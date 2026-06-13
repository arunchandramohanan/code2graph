"""Scenario builder — 4+1's "+1" (use-case) view.

For each Angular Route, walks the static trace
Route -> Component (-> rendered children) -> methods -> ApiCall -> Endpoint
      -> handler method -> Repository -> Entity -> Table
and stores one Scenario node per route with COVERS edges to everything in the
slice. The LLM (one batched call) names each scenario and writes a user-goal
summary; without LLM access the route path is used as the title.
"""

import json
import logging
import re

from .. import db
from . import llm

log = logging.getLogger(__name__)


TRACE_QUERY = """
MATCH (r:Route {project: $p})
OPTIONAL MATCH (r)-[:NAVIGATES_TO]->(c:Component)
OPTIONAL MATCH (c)-[:RENDERS*0..2]->(comp:Component)
WITH r, collect(DISTINCT comp) + collect(DISTINCT c) AS comps
UNWIND CASE WHEN size(comps) = 0 THEN [null] ELSE comps END AS comp
OPTIONAL MATCH (comp)-[:DECLARES]->(:Method)-[:CALLS*0..3]->(m:Method)-[:MAKES_CALL]->(a:ApiCall)
OPTIONAL MATCH (a)-[:INVOKES_API]->(ep:Endpoint)
OPTIONAL MATCH (ep)-[:HANDLED_BY]->(:Method)-[:CALLS*0..4]->(sm:Method)
OPTIONAL MATCH (repo:Repository)-[:DECLARES]->(sm)
OPTIONAL MATCH (repo)-[:MANAGES]->(ent:Entity)-[:MAPS_TO]->(t:Table)
RETURN r.id AS routeId, r.routePath AS routePath,
       collect(DISTINCT {id: comp.id, name: comp.name, label: comp.label}) AS components,
       collect(DISTINCT {id: a.id, name: a.httpMethod + ' ' + a.normalizedPath, label: 'ApiCall'}) AS apiCalls,
       collect(DISTINCT {id: ep.id, name: ep.httpMethod + ' ' + ep.path, label: 'Endpoint'}) AS endpoints,
       collect(DISTINCT {id: ent.id, name: ent.name, label: 'Entity'}) AS entities,
       collect(DISTINCT {id: t.id, name: t.name, label: 'Table'}) AS tables
"""


def _clean(items: list[dict]) -> list[dict]:
    return [i for i in items if i and i.get("id")]


def build_scenarios(project: str) -> dict:
    db.run(
        "MATCH (s:CodeNode {project: $p, label: 'Scenario'}) DETACH DELETE s",
        p=project,
    )
    rows = db.run(TRACE_QUERY, p=project)

    traces = []
    for row in rows:
        components = _clean(row["components"])
        api_calls = _clean(row["apiCalls"])
        endpoints = _clean(row["endpoints"])
        entities = _clean(row["entities"])
        tables = _clean(row["tables"])
        if not components and not endpoints:
            continue
        traces.append({
            "routeId": row["routeId"],
            "routePath": row["routePath"] if row["routePath"] is not None else "",
            "components": components,
            "apiCalls": api_calls,
            "endpoints": endpoints,
            "entities": entities,
            "tables": tables,
        })

    named = _name_with_llm(traces) if llm.enabled() else {}

    created = 0
    for trace in traces:
        route_path = trace["routePath"]
        info = named.get(route_path, {})
        title = info.get("title") or (f"Screen: /{route_path}" if route_path else "Landing screen")
        summary = info.get("summary", "")
        scenario_id = f"system:scenario:{project}:{route_path or 'root'}"
        steps = (
            [f"Route /{route_path}"]
            + [f"Component {c['name']}" for c in trace["components"]]
            + [f"API {a['name']}" for a in trace["apiCalls"]]
            + [f"Endpoint {e['name']}" for e in trace["endpoints"]]
            + [f"Entity {e['name']}" for e in trace["entities"]]
            + [f"Table {t['name']}" for t in trace["tables"]]
        )
        db.run(
            """
            MERGE (s:CodeNode {id: $id})
            SET s:Scenario, s.label = 'Scenario', s.fqn = $fqn, s.name = $title,
                s.stack = 'system', s.project = $p, s.filePath = '',
                s.startLine = 0, s.endLine = 0, s.hash = '',
                s.title = $title, s.summary = $summary, s.routePath = $routePath,
                s.steps = $steps
            """,
            id=scenario_id, fqn=scenario_id.split("system:", 1)[-1], title=title,
            summary=summary, routePath=route_path, p=project, steps=steps,
        )
        covers = (
            [(trace["routeId"], "route")]
            + [(c["id"], "component") for c in trace["components"]]
            + [(a["id"], "apicall") for a in trace["apiCalls"]]
            + [(e["id"], "endpoint") for e in trace["endpoints"]]
            + [(e["id"], "entity") for e in trace["entities"]]
            + [(t["id"], "table") for t in trace["tables"]]
        )
        db.run(
            """
            UNWIND $rows AS row
            MATCH (s:CodeNode {id: $sid}), (n:CodeNode {id: row[0]})
            MERGE (s)-[r:COVERS]->(n)
            SET r.role = row[1]
            """,
            sid=scenario_id, rows=[[c, r] for c, r in covers if c],
        )
        created += 1

    return {"routes": len(rows), "scenarios": created, "llmNamed": len(named)}


def _name_with_llm(traces: list[dict]) -> dict:
    if not traces:
        return {}
    descriptions = [
        {
            "routePath": t["routePath"],
            "components": [c["name"] for c in t["components"]][:8],
            "apiCalls": [a["name"] for a in t["apiCalls"]][:10],
            "entities": [e["name"] for e in t["entities"]][:8],
        }
        for t in traces
    ]
    prompt = (
        "Each item below is a use-case slice of a web application: an Angular route, the "
        "components it renders, the backend API calls it makes, and the entities it touches.\n"
        f"{json.dumps(descriptions, indent=1)}\n\n"
        'For each, name the user-facing use case. Return ONLY a JSON array: '
        '[{"routePath": "<same routePath>", "title": "<2-5 word use-case name, e.g. '
        '\'Create money transfer\'>", "summary": "<one sentence: what the user accomplishes '
        "and what data is involved>\"}]. No prose."
    )
    try:
        text = llm.complete(prompt, max_tokens=3000).strip()
        text = re.sub(r"^```(json)?|```$", "", text, flags=re.MULTILINE).strip()
        items = json.loads(text)
        return {i["routePath"]: i for i in items if isinstance(i, dict) and "routePath" in i}
    except Exception as exc:
        log.warning("scenario naming failed: %s", exc)
        return {}


def list_scenarios(project: str) -> list[dict]:
    rows = db.run(
        """
        MATCH (s:Scenario {project: $p})
        OPTIONAL MATCH (s)-[c:COVERS]->(n:CodeNode)
        WITH s, collect({label: n.label, name: n.name, id: n.id, role: c.role}) AS covered
        RETURN s.id AS id, s.title AS title, s.summary AS summary,
               s.routePath AS routePath, s.steps AS steps, covered
        ORDER BY s.routePath
        """,
        p=project,
    )
    out = []
    for row in rows:
        covers: dict[str, list] = {}
        for c in row["covered"]:
            if c.get("id"):
                covers.setdefault(c["label"], []).append({"id": c["id"], "name": c["name"]})
        out.append({
            "id": row["id"], "title": row["title"], "summary": row["summary"],
            "routePath": row["routePath"], "steps": row["steps"] or [], "covers": covers,
        })
    return out
