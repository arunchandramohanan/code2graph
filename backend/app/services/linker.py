"""Cross-stack linker: match Angular ApiCall nodes to Spring Endpoint nodes.

Tier 1  exact     — same verb + identical normalizedPath               → confidence 1.0
Tier 2  pattern   — same verb + segment-wise match where params/{*}
                    are wildcards; scored by literal overlap           → confidence 0.5–0.9
Tier 3  llm       — remaining unmatched calls judged by the LLM
                    against the endpoint inventory (only if creds set) → capped at 0.85
"""

import json
import logging
import re

from .. import db
from ..config import settings
from . import llm

log = logging.getLogger(__name__)

PARAM_SEG = re.compile(r"^(\{[^}]*\}|:[A-Za-z_][\w]*|\{\*\}|\*)$")


def normalize(path: str) -> str:
    if not path:
        return ""
    path = re.sub(r"^[a-z]+://[^/]+", "", path.strip())  # protocol + host
    path = path.split("?", 1)[0]
    path = re.sub(r"/{2,}", "/", path)
    if not path.startswith("/"):
        path = "/" + path
    if len(path) > 1:
        path = path.rstrip("/")
    segments = []
    for seg in path.split("/"):
        if PARAM_SEG.match(seg) or "${" in seg or "{" in seg:
            segments.append("{*}")
        else:
            segments.append(seg.lower())
    return "/".join(segments)


def _segments(path: str) -> list[str]:
    return [s for s in path.split("/") if s]


def _pattern_score(call_path: str, ep_path: str) -> float:
    """Segment-wise match; either side's {*} is a wildcard. 0 = no match."""
    cs, es = _segments(call_path), _segments(ep_path)
    if len(cs) != len(es) or not cs:
        return 0.0
    literal_total = 0
    literal_matched = 0
    for c, e in zip(cs, es):
        c_wild, e_wild = c == "{*}", e == "{*}"
        if not c_wild and not e_wild:
            literal_total += 1
            if c == e:
                literal_matched += 1
            else:
                return 0.0
        # wildcard vs anything: allowed, contributes no literal evidence
    if literal_total == 0:
        return 0.5  # all-wildcard paths of same length: weak match
    return literal_matched / len(cs)


def _fetch(project: str):
    calls = db.run(
        """
        MATCH (c:ApiCall {project: $project})
        RETURN c.id AS id, c.httpMethod AS method, c.normalizedPath AS path,
               c.urlExpression AS expr, c.inMethod AS inMethod
        """,
        project=project,
    )
    endpoints = db.run(
        """
        MATCH (e:Endpoint {project: $project})
        RETURN e.id AS id, e.httpMethod AS method, e.normalizedPath AS path, e.path AS rawPath
        """,
        project=project,
    )
    return calls, endpoints


def run_linker(project: str, use_llm: bool = True) -> dict:
    calls, endpoints = _fetch(project)
    db.run(
        "MATCH (:ApiCall {project: $project})-[r:INVOKES_API]->() DELETE r",
        project=project,
    )

    links: list[dict] = []
    unmatched: list[dict] = []

    for call in calls:
        method = (call["method"] or "").upper()
        path = normalize(call["path"] or "")
        if not path or path == "/":
            unmatched.append(call)
            continue
        candidates = [e for e in endpoints if (e["method"] or "").upper() == method]

        exact = [e for e in candidates if normalize(e["path"] or "") == path]
        if exact:
            links.append({"call": call["id"], "endpoint": exact[0]["id"],
                          "confidence": 1.0, "tier": "exact"})
            continue

        scored = []
        for e in candidates:
            score = _pattern_score(path, normalize(e["path"] or ""))
            if score >= 0.5:
                scored.append((score, e))
        if scored:
            scored.sort(key=lambda t: -t[0])
            best_score, best = scored[0]
            confidence = round(min(0.9, 0.5 + 0.4 * best_score), 3)
            links.append({"call": call["id"], "endpoint": best["id"],
                          "confidence": confidence, "tier": "pattern"})
            continue

        unmatched.append(call)

    llm_links = 0
    if unmatched and use_llm and settings.llm_enabled:
        try:
            llm_results = _llm_match(unmatched, endpoints)
            links.extend(llm_results)
            llm_links = len(llm_results)
        except Exception as exc:
            log.warning("tier-3 llm linking failed: %s", exc)

    for chunk in (links[i : i + 500] for i in range(0, len(links), 500)):
        db.run(
            """
            UNWIND $rows AS row
            MATCH (c:CodeNode {id: row.call}), (e:CodeNode {id: row.endpoint})
            MERGE (c)-[r:INVOKES_API]->(e)
            SET r.confidence = row.confidence, r.tier = row.tier
            """,
            rows=list(chunk),
        )

    tiers: dict[str, int] = {}
    for l in links:
        tiers[l["tier"]] = tiers.get(l["tier"], 0) + 1
    return {
        "apiCalls": len(calls),
        "endpoints": len(endpoints),
        "linked": len(links),
        "unmatched": len(calls) - len(links),
        "byTier": tiers,
        "llmUsed": llm_links > 0,
    }


def _llm_match(unmatched: list[dict], endpoints: list[dict]) -> list[dict]:
    """Ask the LLM to match dynamic/unresolved calls against the endpoint inventory."""
    inventory = [
        {"id": e["id"], "method": e["method"], "path": e["rawPath"]} for e in endpoints
    ]
    calls_desc = [
        {"id": c["id"], "method": c["method"], "urlExpression": c["expr"],
         "inMethod": c["inMethod"]}
        for c in unmatched
    ]
    prompt = (
        "You match frontend HTTP calls to backend REST endpoints.\n"
        f"Backend endpoints:\n{json.dumps(inventory, indent=1)}\n\n"
        f"Unmatched frontend calls (urlExpression is raw source code):\n"
        f"{json.dumps(calls_desc, indent=1)}\n\n"
        'Return ONLY a JSON array: [{"call": "<call id>", "endpoint": "<endpoint id>", '
        '"confidence": 0.0-1.0}] for calls you can match with confidence >= 0.5. '
        "Omit calls you cannot match. No prose."
    )
    text = llm.complete(prompt, max_tokens=4000).strip()
    text = re.sub(r"^```(json)?|```$", "", text, flags=re.MULTILINE).strip()
    matches = json.loads(text)
    valid_calls = {c["id"] for c in unmatched}
    valid_eps = {e["id"] for e in endpoints}
    return [
        {"call": m["call"], "endpoint": m["endpoint"],
         "confidence": round(min(0.85, float(m.get("confidence", 0.5))), 3), "tier": "llm"}
        for m in matches
        if m.get("call") in valid_calls and m.get("endpoint") in valid_eps
        and float(m.get("confidence", 0)) >= 0.5
    ]
