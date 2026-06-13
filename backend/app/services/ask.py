"""Ask-the-codebase: agentic GraphRAG Q&A over the knowledge graph.

The LLM answers natural-language questions by exploring the graph itself through
tools — fulltext search, node neighborhoods, read-only Cypher, and reading real
source slices from the cloned repo — then composes an answer. The full tool trail
is returned so the UI can show *how* the answer was derived and link every touched
node into the graph explorer.
"""

import json
import logging
from pathlib import Path

from .. import db
from . import llm, queries

log = logging.getLogger(__name__)

MAX_STEPS = 10
TOOL_RESULT_CAP = 7000

TOOLS = [
    {
        "name": "search_nodes",
        "description": "Fulltext search over the code graph: node names, FQNs, file paths "
                       "and LLM summaries. Use this first to locate relevant elements.",
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "labels": {"type": "string",
                           "description": "optional comma-separated label filter, e.g. 'Endpoint,Service'"},
                "limit": {"type": "integer", "default": 10},
            },
            "required": ["query"],
        },
    },
    {
        "name": "get_node",
        "description": "Fetch one node's full properties (including its LLM summary if present) "
                       "plus every neighbor with relationship type and direction.",
        "input_schema": {
            "type": "object",
            "properties": {"node_id": {"type": "string"}},
            "required": ["node_id"],
        },
    },
    {
        "name": "run_cypher",
        "description": "Run a read-only Cypher query for structural questions (paths, impact, "
                       "counts, traversals). Always filter by {project: $project} — the parameter "
                       "$project is bound automatically. Mutations are rejected.",
        "input_schema": {
            "type": "object",
            "properties": {"query": {"type": "string"}},
            "required": ["query"],
        },
    },
    {
        "name": "get_source",
        "description": "Read the actual source code of a node (by node id) from the checked-out "
                       "repository. Use to verify behavior details the graph cannot answer.",
        "input_schema": {
            "type": "object",
            "properties": {"node_id": {"type": "string"}},
            "required": ["node_id"],
        },
    },
]

SYSTEM = """You are a senior engineer answering questions about a codebase that has been \
ingested into a Neo4j knowledge graph. Project: "{project}".

Graph ontology — every node has label CodeNode plus one specific label, and properties \
id, fqn, name, label, stack (java|angular|infra|system), project, filePath, startLine, endLine, \
and possibly summary/tags (LLM-written):
- Labels: Application, File, Class, Component (Angular), Service, Controller, Endpoint \
(httpMethod, path), ApiCall (httpMethod, normalizedPath, urlExpression — an Angular HTTP call site), \
Method (signature; may have async/scheduled/transactional), DTO, Entity (tableName), Table (columns), \
Repository, Route (routePath), Template, Topic, Deployment, Datasource, Scenario (title, summary, steps).
- Edges: DECLARES, IMPORTS, INJECTS, CALLS, EXTENDS, IMPLEMENTS, RENDERS (component→child), \
BINDS, USES_TEMPLATE, NAVIGATES_TO (route→component), EXPOSES (controller→endpoint), \
HANDLED_BY (endpoint→method), MAKES_CALL (method→apicall), INVOKES_API (apicall→endpoint, \
the cross-stack link, props confidence/tier), ACCEPTS/RETURNS (endpoint→dto), MAPS_TO (entity→table), \
RELATES_TO (entity→entity), READS/WRITES/MANAGES (repository→entity), PUBLISHES_TO/CONSUMES_FROM \
(messaging), DEPLOYED_AS/CONNECTS_TO/USES_DATASOURCE/PROVIDED_BY/HOSTS (physical), COVERS (scenario→node).

Method:
1. Search or query the graph to locate the relevant elements; follow edges to understand structure.
2. Read source with get_source when the question needs implementation details (validation rules, \
calculations, conditions).
3. Answer concisely in markdown. Wrap every file path in backticks (e.g. `src/app/x.ts`) — \
the UI makes them clickable. State line numbers when you read source. Walk through flows step \
by step across both stacks when relevant. If something is not in the graph or source, say so \
instead of guessing.

Example Cypher — full cross-stack flow for an endpoint:
MATCH (c:ApiCall {{project: $project}})-[r:INVOKES_API]->(ep:Endpoint)<-[:EXPOSES]-(ctrl:Controller)
RETURN c.normalizedPath, ep.path, ctrl.name, r.confidence"""


def _project_roots(project: str) -> dict:
    rows = db.run(
        "MATCH (p:Project {name: $p}) RETURN p.javaRoot AS j, p.angularRoot AS a",
        p=project,
    )
    if not rows:
        return {}
    return {"java": rows[0]["j"], "angular": rows[0]["a"]}


def _exec_tool(name: str, args: dict, project: str, touched: dict) -> str:
    try:
        if name == "search_nodes":
            labels = [l.strip() for l in (args.get("labels") or "").split(",") if l.strip()] or None
            hits = queries.search(args.get("query", ""), project, labels,
                                  min(int(args.get("limit", 10) or 10), 25))
            out = []
            for h in hits:
                touched[h["id"]] = {"id": h["id"], "name": h.get("name"), "label": h.get("label")}
                out.append({k: h.get(k) for k in
                            ("id", "label", "name", "fqn", "stack", "filePath", "summary")
                            if h.get(k) is not None})
            return json.dumps(out)

        if name == "get_node":
            detail = queries.node_detail(args.get("node_id", ""))
            if not detail:
                return json.dumps({"error": "no such node"})
            node = detail["node"]
            touched[node["id"]] = {"id": node["id"], "name": node.get("name"),
                                   "label": node.get("label")}
            neighbors = [
                {"rel": nb["relType"], "dir": nb["direction"],
                 "id": nb["node"]["id"], "label": nb["node"].get("label"),
                 "name": nb["node"].get("name")}
                for nb in detail["neighbors"]
            ]
            return json.dumps({"node": node, "neighbors": neighbors[:60]})

        if name == "run_cypher":
            query = args.get("query", "")
            result = queries.read_cypher(query, {"project": project})
            return json.dumps(result, default=str)

        if name == "get_source":
            return json.dumps(_get_source(args.get("node_id", ""), project, touched))

        return json.dumps({"error": f"unknown tool {name}"})
    except Exception as exc:
        return json.dumps({"error": str(exc)[:400]})


def _get_source(node_id: str, project: str, touched: dict) -> dict:
    rows = db.run(
        "MATCH (n:CodeNode {id: $id}) RETURN properties(n) AS n", id=node_id,
    )
    if not rows:
        return {"error": "no such node"}
    node = rows[0]["n"]
    touched[node["id"]] = {"id": node["id"], "name": node.get("name"), "label": node.get("label")}
    roots = _project_roots(project)
    root = roots.get(node.get("stack"))
    if not root:
        return {"error": f"no source root recorded for stack {node.get('stack')} "
                         "(re-ingest the project to record it)"}
    path = Path(root) / node.get("filePath", "")
    if not node.get("filePath") or not path.is_file():
        return {"error": f"source file not found: {node.get('filePath')}"}
    try:
        lines = path.read_text(errors="replace").splitlines()
    except OSError as exc:
        return {"error": str(exc)}
    start = max(0, int(node.get("startLine", 1) or 1) - 1)
    end = int(node.get("endLine", 0) or 0) or len(lines)
    end = min(len(lines), max(end, start + 1))
    numbered = "\n".join(f"{i + 1}: {l}" for i, l in enumerate(lines[start:end], start=start))
    return {"filePath": node["filePath"], "startLine": start + 1, "endLine": end,
            "source": numbered[:TOOL_RESULT_CAP]}


def ask(project: str, question: str, history: list | None = None,
        trail: list | None = None) -> dict:
    """trail: optional shared list that receives thought/tool entries as they happen,
    so a polling caller can show live progress."""
    if not llm.enabled():
        raise RuntimeError("LLM access is not configured (see backend/.env)")
    system = SYSTEM.format(project=project)

    messages = []
    for turn in (history or [])[-8:]:
        role = turn.get("role")
        content = str(turn.get("content", ""))[:4000]
        if role in ("user", "assistant") and content:
            messages.append({"role": role, "content": content})
    messages.append({"role": "user", "content": question})

    steps = trail if trail is not None else []
    touched: dict[str, dict] = {}
    answer = ""

    for _ in range(MAX_STEPS):
        resp = llm.create_with_tools(system, messages, TOOLS)
        tool_blocks = [b for b in resp.content if b.type == "tool_use"]
        text = "".join(b.text for b in resp.content if b.type == "text")
        if not tool_blocks:
            answer = text
            break
        if text.strip():
            # the model's narration between tool rounds — its visible thinking
            steps.append({"type": "thought", "text": text.strip()[:1500]})
        messages.append({"role": "assistant", "content": resp.content})
        results = []
        for block in tool_blocks:
            entry = {"type": "tool", "tool": block.name, "input": dict(block.input)}
            steps.append(entry)
            output = _exec_tool(block.name, dict(block.input), project, touched)
            entry["resultPreview"] = output[:300]
            results.append({
                "type": "tool_result",
                "tool_use_id": block.id,
                "content": output[:TOOL_RESULT_CAP],
            })
        messages.append({"role": "user", "content": results})
    else:
        # step budget exhausted — force a final answer from what was gathered
        messages.append({"role": "user",
                         "content": "Stop exploring. Answer now with what you have."})
        resp = llm.create_with_tools(system, messages, TOOLS)
        answer = "".join(b.text for b in resp.content if b.type == "text")

    return {
        "answer": answer or "(no answer produced)",
        "steps": steps,
        "nodes": list(touched.values()),
    }
