"""LLM enrichment layer (runs after the deterministic graph is built).

Per node: one-paragraph summary + business-capability tags, generated with graph
context (the node's neighbors) in the prompt. Per community: Louvain communities
(networkx, over the dependency projection) summarized into capability clusters.

Only nodes whose `summary` is null are processed (ingestion clears summaries when
a node's content hash changes), so re-running is incremental.
"""

import json
import logging
import re
from pathlib import Path

from .. import db
from . import llm

log = logging.getLogger(__name__)

# Labels worth summarizing (skip File/Method/Template noise for cost control).
ENRICH_LABELS = [
    "Controller", "Service", "Component", "Endpoint", "Entity", "Repository",
    "DTO", "Class", "Route",
]

PROJECTION_EDGES = "CALLS|INJECTS|RENDERS|INVOKES_API|EXPOSES|HANDLED_BY|MANAGES|READS|WRITES|MAPS_TO|RELATES_TO|ACCEPTS|RETURNS"


def _require_llm():
    if not llm.enabled():
        raise RuntimeError("LLM access is not configured (see backend/.env)")


def _source_snippet(project_roots: dict, node: dict, max_chars: int = 3000) -> str:
    root = project_roots.get(node.get("stack"))
    if not root or not node.get("filePath"):
        return ""
    path = Path(root) / node["filePath"]
    try:
        lines = path.read_text(errors="replace").splitlines()
        start = max(0, int(node.get("startLine", 1)) - 1)
        end = min(len(lines), int(node.get("endLine", 0)) or len(lines))
        return "\n".join(lines[start:end])[:max_chars]
    except OSError:
        return ""


def enrich_nodes(project: str, job=None, batch_limit: int = 500,
                 project_roots: dict | None = None) -> dict:
    _require_llm()
    rows = db.run(
        f"""
        MATCH (n:CodeNode {{project: $p}})
        WHERE n.label IN $labels AND n.summary IS NULL
        OPTIONAL MATCH (n)-[r:{PROJECTION_EDGES}]-(m:CodeNode)
        WITH n, collect({{rel: type(r),
                          dir: CASE WHEN startNode(r) = n THEN 'out' ELSE 'in' END,
                          name: m.name, label: m.label}})[..25] AS nbrs
        RETURN properties(n) AS node, nbrs LIMIT $limit
        """,
        p=project,
        labels=ENRICH_LABELS,
        limit=batch_limit,
    )
    done = 0
    for row in rows:
        node, nbrs = row["node"], row["nbrs"]
        context = "\n".join(
            f"  {'->' if nb['dir'] == 'out' else '<-'} {nb['rel']} {nb['label']} {nb['name']}"
            for nb in nbrs if nb.get("name")
        )
        snippet = _source_snippet(project_roots or {}, node)
        prompt = (
            f"Code element: {node['label']} `{node['fqn']}` (stack: {node['stack']}, "
            f"file: {node['filePath']})\n"
            f"Graph neighbors:\n{context or '  (none)'}\n"
            + (f"Source:\n```\n{snippet}\n```\n" if snippet else "")
            + "\nReturn JSON only: {\"summary\": \"<one paragraph, plain language, what this "
            "element does in the system and why it matters>\", \"tags\": [\"2-5 business-capability "
            "tags, lowercase-kebab\"]}"
        )
        try:
            data = _parse_json(llm.complete(prompt, max_tokens=500))
            db.run(
                "MATCH (n:CodeNode {id: $id}) SET n.summary = $s, n.tags = $t",
                id=node["id"], s=str(data.get("summary", ""))[:2000],
                t=[str(t) for t in data.get("tags", [])][:8],
            )
            done += 1
        except Exception as exc:
            log.warning("enrich failed for %s: %s", node["id"], exc)
    return {"summarized": done, "candidates": len(rows)}


def enrich_communities(project: str, job=None) -> dict:
    _require_llm()
    import networkx as nx

    rows = db.run(
        f"""
        MATCH (a:CodeNode {{project: $p}})-[r:{PROJECTION_EDGES}]-(b:CodeNode {{project: $p}})
        WHERE a.label IN $labels AND b.label IN $labels
        RETURN a.id AS src, b.id AS tgt
        """,
        p=project,
        labels=ENRICH_LABELS,
    )
    graph = nx.Graph()
    graph.add_edges_from((r["src"], r["tgt"]) for r in rows)
    if graph.number_of_nodes() == 0:
        return {"communities": 0}

    communities = nx.community.louvain_communities(graph, seed=42)
    summarized = 0
    for idx, members in enumerate(communities):
        member_list = list(members)
        db.run(
            "UNWIND $ids AS id MATCH (n:CodeNode {id: id}) SET n.community = $c",
            ids=member_list, c=idx,
        )
        if len(member_list) < 3:
            continue
        detail = db.run(
            """
            UNWIND $ids AS id MATCH (n:CodeNode {id: id})
            RETURN n.label AS label, n.name AS name, n.summary AS summary
            LIMIT 60
            """,
            ids=member_list,
        )
        listing = "\n".join(
            f"  - {d['label']} {d['name']}: {(d['summary'] or '')[:140]}" for d in detail
        )
        prompt = (
            f"These code elements form one community (cluster) in a system's dependency graph:\n"
            f"{listing}\n\n"
            'Return JSON only: {"title": "<3-6 word capability name>", '
            '"summary": "<one paragraph: what business capability this cluster implements>"}'
        )
        try:
            data = _parse_json(llm.complete(prompt, max_tokens=400))
            db.run(
                """
                MERGE (c:Community {project: $p, communityId: $c})
                SET c.title = $title, c.summary = $summary, c.size = $size
                """,
                p=project, c=idx, title=str(data.get("title", f"community-{idx}"))[:120],
                summary=str(data.get("summary", ""))[:2000], size=len(member_list),
            )
            summarized += 1
        except Exception as exc:
            log.warning("community %s summary failed: %s", idx, exc)
    return {"communities": len(communities), "summarized": summarized}


def _parse_json(text: str) -> dict:
    text = re.sub(r"^```(json)?|```$", "", text.strip(), flags=re.MULTILINE).strip()
    match = re.search(r"\{.*\}", text, re.DOTALL)
    return json.loads(match.group(0) if match else text)
