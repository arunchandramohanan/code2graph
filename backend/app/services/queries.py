"""Read queries powering the API: overview, subgraph, search, impact, links."""

import re

from .. import db

BASE_KEYS = (
    "id", "fqn", "name", "label", "stack", "project", "filePath",
    "startLine", "endLine",
)

# Edges along which "change X" propagates for impact analysis.
IMPACT_TYPES = (
    "CALLS|INJECTS|EXPOSES|HANDLED_BY|MAKES_CALL|INVOKES_API|ACCEPTS|RETURNS|"
    "MAPS_TO|RELATES_TO|READS|WRITES|MANAGES|RENDERS|BINDS|USES_TEMPLATE|"
    "NAVIGATES_TO|EXTENDS|IMPLEMENTS|DECLARES"
)

ARCH_LABELS = ["Controller", "Service", "Component", "Endpoint", "Entity", "Repository", "ApiCall"]

# 4+1 view presets: node-filter cypher fragment + edge types shown between them.
VIEW_PRESETS = {
    "logical": {
        "where": "n.label IN ['Controller','Service','Component','Endpoint','Entity',"
                 "'DTO','Repository','ApiCall','Route']",
        "edges": None,  # all edges between the selected nodes
        # Collapse the (excluded) Method hop into direct class-level edges so the
        # high-level view doesn't fragment: Service/Component -> ApiCall and
        # Component/Service -> Service/Repository. Value = label set to keep.
        "collapse": ["Controller", "Service", "Component", "Endpoint", "Entity",
                     "DTO", "Repository", "ApiCall", "Route"],
    },
    "development": {
        "where": "n.label IN ['Application','Module','File']",
        "edges": ["IMPORTS", "DECLARES"],
    },
    "physical": {
        "where": "n.label IN ['Application','Deployment','Datasource','Table','Topic']",
        "edges": ["DEPLOYED_AS", "CONNECTS_TO", "USES_DATASOURCE", "PROVIDED_BY",
                   "HOSTS", "PUBLISHES_TO", "CONSUMES_FROM"],
    },
    "process": {
        "where": "n.label IN ['Topic','Scenario'] "
                 "OR (n.label = 'Method' AND (n.async = true OR n.scheduled IS NOT NULL "
                 "OR n.transactional = true)) "
                 "OR (n.label = 'Endpoint')",
        "edges": ["PUBLISHES_TO", "CONSUMES_FROM", "HANDLED_BY", "CALLS"],
    },
    "scenarios": {
        "where": "n.label IN ['Scenario','Route','Component','Endpoint','Entity','Table']",
        "edges": ["COVERS", "NAVIGATES_TO", "MAPS_TO"],
    },
    # Whole-project method call graph, including the cross-stack hops
    # (Angular method -> ApiCall -> Endpoint -> backend method).
    "callgraph": {
        "where": "n.label IN ['Method','Endpoint','ApiCall']",
        "edges": ["CALLS", "HANDLED_BY", "MAKES_CALL", "INVOKES_API"],
    },
}


def _node_payload(props: dict) -> dict:
    out = dict(props)
    out.pop("embedding", None)  # large vector, never ship to the UI
    return out


def _graph_payload(rows: list[dict]) -> dict:
    """rows: records each carrying `nodes` (list of maps) and `rels` (list of [srcId, type, props, tgtId])."""
    nodes: dict[str, dict] = {}
    edges: dict[str, dict] = {}
    for row in rows:
        for n in row.get("nodes") or []:
            if n and n.get("id"):
                nodes.setdefault(n["id"], _node_payload(n))
        for r in row.get("rels") or []:
            if not r:
                continue
            src, rel_type, props, tgt = r
            key = f"{src}|{rel_type}|{tgt}"
            edges.setdefault(key, {
                "id": key, "source": src, "target": tgt, "type": rel_type,
                "props": props or {},
            })
    return {"nodes": list(nodes.values()), "edges": list(edges.values())}


def list_projects() -> list[dict]:
    rows = db.run(
        """
        MATCH (n:CodeNode)
        WITH n.project AS name, n.label AS label, count(*) AS c
        WITH name, collect([label, c]) AS labelCounts
        OPTIONAL MATCH (p:Project {name: name})
        RETURN name, labelCounts, p.lastIngestedAt AS lastIngestedAt
        ORDER BY name
        """
    )
    out = []
    for row in rows:
        edge_rows = db.run(
            """
            MATCH (a:CodeNode {project: $p})-[r]->(:CodeNode {project: $p})
            RETURN type(r) AS t, count(*) AS c
            """,
            p=row["name"],
        )
        out.append({
            "name": row["name"],
            "nodeCounts": {label: c for label, c in row["labelCounts"]},
            "edgeCounts": {r["t"]: r["c"] for r in edge_rows},
            "lastIngestedAt": row["lastIngestedAt"],
        })
    return out


def overview(project: str) -> dict:
    nodes = db.run(
        "MATCH (n:CodeNode {project: $p}) RETURN n.label AS label, n.stack AS stack, count(*) AS c",
        p=project,
    )
    edges = db.run(
        "MATCH (:CodeNode {project: $p})-[r]->(:CodeNode {project: $p}) RETURN type(r) AS t, count(*) AS c",
        p=project,
    )
    links = db.run(
        """
        MATCH (c:ApiCall {project: $p})
        OPTIONAL MATCH (c)-[r:INVOKES_API]->()
        RETURN count(c) AS calls, count(r) AS linked
        """,
        p=project,
    )
    return {
        "project": project,
        "nodesByLabel": _sum_by(nodes, "label"),
        "nodesByStack": _sum_by(nodes, "stack"),
        "edgesByType": {r["t"]: r["c"] for r in edges},
        "apiCalls": links[0]["calls"] if links else 0,
        "apiCallsLinked": links[0]["linked"] if links else 0,
    }


def _sum_by(rows: list[dict], key: str) -> dict:
    out: dict[str, int] = {}
    for r in rows:
        out[r[key]] = out.get(r[key], 0) + r["c"]
    return out


def _add_collapsed_edges(project: str, payload: dict, keep_labels: list[str]) -> None:
    """Synthesize class-level edges by collapsing the excluded Method hop, so the
    logical view stays connected: owner -> ApiCall (via MAKES_CALL) and owner ->
    owner (via method CALLS). Only edges between already-present nodes are added."""
    present = {n["id"] for n in payload["nodes"]}
    existing = {e["id"] for e in payload["edges"]}
    syn = db.run(
        """
        MATCH (owner:CodeNode {project:$p})-[:DECLARES]->(:Method)-[:MAKES_CALL]->(a:ApiCall {project:$p})
        WHERE owner.label IN $labels
        RETURN DISTINCT owner.id AS s, 'MAKES_CALL' AS ty, a.id AS o
        UNION
        MATCH (oa:CodeNode {project:$p})-[:DECLARES]->(:Method)-[:CALLS]->(:Method)<-[:DECLARES]-(ob:CodeNode {project:$p})
        WHERE oa.label IN $labels AND ob.label IN $labels AND oa <> ob
        RETURN DISTINCT oa.id AS s, 'CALLS' AS ty, ob.id AS o
        """,
        p=project, labels=keep_labels,
    )
    for r in syn:
        if r["s"] not in present or r["o"] not in present:
            continue
        key = f"{r['s']}|{r['ty']}|{r['o']}"
        if key in existing:
            continue
        existing.add(key)
        payload["edges"].append({
            "id": key, "source": r["s"], "target": r["o"],
            "type": r["ty"], "props": {"collapsed": True},
        })


def subgraph(project: str, node_id: str | None, depth: int, labels: list[str] | None,
             edge_types: list[str] | None, limit: int, view: str | None = None) -> dict:
    if view and not node_id:
        preset = VIEW_PRESETS.get(view)
        if not preset:
            raise ValueError(f"unknown view: {view}")
        rows = db.run(
            f"""
            MATCH (n:CodeNode {{project: $p}})
            WHERE {preset['where']}
            WITH collect(n) AS ns LIMIT 1
            UNWIND ns AS a
            OPTIONAL MATCH (a)-[r]->(b:CodeNode {{project: $p}})
            WHERE b IN ns
            WITH ns, collect(r) AS rs
            RETURN [n IN ns | properties(n)] AS nodes,
                   [r IN rs WHERE r IS NOT NULL |
                        [startNode(r).id, type(r), properties(r), endNode(r).id]] AS rels
            """,
            p=project,
        )
        payload = _graph_payload(rows)
        if preset.get("collapse"):
            _add_collapsed_edges(project, payload, preset["collapse"])
        if preset["edges"]:
            keep = set(preset["edges"])
            payload["edges"] = [e for e in payload["edges"] if e["type"] in keep]
        if view == "process":
            # drop endpoints with no process-relevant connection to reduce noise
            connected = {e["source"] for e in payload["edges"]} | {e["target"] for e in payload["edges"]}
            payload["nodes"] = [
                n for n in payload["nodes"]
                if n.get("label") != "Endpoint" or n["id"] in connected
            ]
            ids = {n["id"] for n in payload["nodes"]}
            payload["edges"] = [e for e in payload["edges"] if e["source"] in ids and e["target"] in ids]
        if len(payload["nodes"]) > limit:
            payload["nodes"] = payload["nodes"][:limit]
            ids = {n["id"] for n in payload["nodes"]}
            payload["edges"] = [e for e in payload["edges"] if e["source"] in ids and e["target"] in ids]
        return payload

    if node_id:
        rel_filter = "|".join(t for t in (edge_types or []) if re.fullmatch(r"\w+", t)) or IMPACT_TYPES
        rows = db.run(
            f"""
            MATCH (start:CodeNode {{id: $id}})
            CALL {{
                WITH start
                MATCH p = (start)-[:{rel_filter}*1..{min(depth, 4)}]-(m:CodeNode)
                RETURN p LIMIT $limit
            }}
            WITH start, collect(p) AS paths
            WITH start, paths,
                 [p IN paths | nodes(p)] AS nodeLists,
                 [p IN paths | relationships(p)] AS relLists
            WITH start,
                 reduce(acc = [], l IN nodeLists | acc + l) AS allNodes,
                 reduce(acc = [], l IN relLists | acc + l) AS allRels
            RETURN [n IN allNodes + [start] | properties(n)] AS nodes,
                   [r IN allRels | [startNode(r).id, type(r), properties(r), endNode(r).id]] AS rels
            """,
            id=node_id,
            limit=limit,
        )
        payload = _graph_payload(rows)
        if labels:
            keep = set(labels) | ({"__start__"})
            payload["nodes"] = [
                n for n in payload["nodes"] if n.get("label") in set(labels) or n.get("id") == node_id
            ]
            ids = {n["id"] for n in payload["nodes"]}
            payload["edges"] = [e for e in payload["edges"] if e["source"] in ids and e["target"] in ids]
        return payload

    arch = labels or ARCH_LABELS
    arch = [l for l in arch if re.fullmatch(r"\w+", l)]
    rows = db.run(
        """
        MATCH (n:CodeNode {project: $p})
        WHERE n.label IN $labels
        WITH collect(n) AS ns LIMIT 1
        UNWIND ns AS a
        OPTIONAL MATCH (a)-[r]->(b:CodeNode {project: $p})
        WHERE b IN ns
        WITH ns, collect(r) AS rs
        RETURN [n IN ns | properties(n)] AS nodes,
               [r IN rs WHERE r IS NOT NULL |
                    [startNode(r).id, type(r), properties(r), endNode(r).id]] AS rels
        """,
        p=project,
        labels=arch,
    )
    payload = _graph_payload(rows)
    if edge_types:
        keep = set(edge_types)
        payload["edges"] = [e for e in payload["edges"] if e["type"] in keep]
    if len(payload["nodes"]) > limit:
        payload["nodes"] = payload["nodes"][:limit]
        ids = {n["id"] for n in payload["nodes"]}
        payload["edges"] = [e for e in payload["edges"] if e["source"] in ids and e["target"] in ids]
    return payload


def node_detail(node_id: str) -> dict | None:
    rows = db.run(
        """
        MATCH (n:CodeNode {id: $id})
        OPTIONAL MATCH (n)-[r]-(m:CodeNode)
        RETURN properties(n) AS node,
               collect({relType: type(r),
                        direction: CASE WHEN startNode(r) = n THEN 'out' ELSE 'in' END,
                        props: properties(r),
                        node: properties(m)}) AS neighbors
        """,
        id=node_id,
    )
    if not rows or rows[0]["node"] is None:
        return None
    node = _node_payload(rows[0]["node"])
    neighbors = [
        {**nb, "node": _node_payload(nb["node"])}
        for nb in rows[0]["neighbors"]
        if nb.get("node") and nb["node"].get("id")
    ]
    return {"node": node, "neighbors": neighbors}


def search(q: str, project: str | None, labels: list[str] | None, limit: int) -> list[dict]:
    terms = [t for t in re.split(r"\s+", q.strip()) if t]
    if not terms:
        return []
    # fuzzy-ish: each term as prefix match
    query = " AND ".join(f"{_escape_lucene(t)}*" for t in terms)
    try:
        rows = db.run(
            """
            CALL db.index.fulltext.queryNodes('code_node_search', $q) YIELD node, score
            WHERE ($project IS NULL OR node.project = $project)
              AND ($labels IS NULL OR node.label IN $labels)
            RETURN properties(node) AS n, score
            ORDER BY score DESC LIMIT $limit
            """,
            q=query,
            project=project,
            labels=labels or None,
            limit=limit,
        )
    except Exception:
        rows = db.run(
            """
            MATCH (n:CodeNode)
            WHERE ($project IS NULL OR n.project = $project)
              AND ($labels IS NULL OR n.label IN $labels)
              AND (toLower(n.name) CONTAINS toLower($raw) OR toLower(n.fqn) CONTAINS toLower($raw))
            RETURN properties(n) AS n, 1.0 AS score LIMIT $limit
            """,
            project=project,
            labels=labels or None,
            raw=q.strip(),
            limit=limit,
        )
    return [{**_node_payload(r["n"]), "score": r["score"]} for r in rows]


def _escape_lucene(term: str) -> str:
    return re.sub(r'([+\-!(){}\[\]^"~*?:\\/]|&&|\|\|)', r"\\\1", term)


def impact(node_id: str, direction: str, depth: int) -> dict:
    depth = max(1, min(depth, 6))
    if direction == "downstream":
        pattern = f"(start)-[:{IMPACT_TYPES}*1..{depth}]->(m:CodeNode)"
    elif direction == "upstream":
        pattern = f"(start)<-[:{IMPACT_TYPES}*1..{depth}]-(m:CodeNode)"
    else:
        pattern = f"(start)-[:{IMPACT_TYPES}*1..{depth}]-(m:CodeNode)"
    rows = db.run(
        f"""
        MATCH (start:CodeNode {{id: $id}})
        CALL {{
            WITH start
            MATCH p = {pattern}
            RETURN m, min(length(p)) AS distance, collect(DISTINCT relationships(p)) AS relLists
            LIMIT 2000
        }}
        WITH start, collect({{node: properties(m), distance: distance}}) AS hits,
             reduce(acc = [], l IN collect(relLists) | acc + reduce(a2 = [], x IN l | a2 + x)) AS allRels
        RETURN properties(start) AS startNode, hits,
               [r IN allRels | [startNode(r).id, type(r), properties(r), endNode(r).id]] AS rels
        """,
        id=node_id,
    )
    if not rows or rows[0]["startNode"] is None:
        return {"nodes": [], "edges": []}
    row = rows[0]
    nodes: dict[str, dict] = {}
    start = _node_payload(row["startNode"])
    start["distance"] = 0
    nodes[start["id"]] = start
    for hit in row["hits"]:
        n = _node_payload(hit["node"])
        n["distance"] = hit["distance"]
        existing = nodes.get(n["id"])
        if not existing or existing.get("distance", 99) > n["distance"]:
            nodes[n["id"]] = n
    edges: dict[str, dict] = {}
    ids = set(nodes)
    for src, rel_type, props, tgt in row["rels"] or []:
        if src in ids and tgt in ids:
            key = f"{src}|{rel_type}|{tgt}"
            edges.setdefault(key, {"id": key, "source": src, "target": tgt,
                                   "type": rel_type, "props": props or {}})
    return {"nodes": list(nodes.values()), "edges": list(edges.values())}


# Labels that represent an externally-reachable entry point: a place where the
# blast radius of a vulnerable class becomes part of the attack surface.
ENTRY_POINT_LABELS = ("Endpoint", "Controller", "Route", "Component")

# Packaging/container nodes — not "dependents", just where code lives. Dropped
# from the blast radius so the affected count reflects real code, not structure.
STRUCTURAL_LABELS = ("File", "Application", "Module")


def resolve_blast_seeds(seeds: list[str] | None, cypher: str | None,
                        params: dict | None) -> list[str]:
    """Resolve the vulnerable class(es) to a de-duplicated list of node ids.

    Accepts explicit node ids (from the search picker) and/or a read-only Cypher
    predicate whose result columns carry node ids — either a column literally named
    `id` or a returned node/map with an `id` property (e.g.
    `MATCH (n:CodeNode) WHERE 'log4j' IN n.imports RETURN n`)."""
    ids: list[str] = []
    seen: set[str] = set()

    def _add(value):
        if isinstance(value, str) and value and value not in seen:
            seen.add(value)
            ids.append(value)

    for s in seeds or []:
        _add(s)
    if cypher:
        res = read_cypher(cypher, params)  # raises on write/forbidden cypher
        cols = res["columns"]
        for row in res["rows"]:
            for col, val in zip(cols, row):
                if isinstance(val, dict):
                    _add(val.get("id"))
                elif col == "id":
                    _add(val)
    return ids


def blast_radius(seeds: list[str] | None, cypher: str | None,
                 params: dict | None, depth: int) -> dict:
    """Upstream impact ("what depends on it") from one or more vulnerable classes,
    with the affected entry points (the exposed attack surface) called out."""
    seed_ids = resolve_blast_seeds(seeds, cypher, params)
    if not seed_ids:
        raise ValueError(
            "no vulnerable class selected — pass seed node ids and/or a cypher "
            "query whose results carry node ids"
        )
    depth = max(1, min(depth, 6))
    # Dependency edges (CALLS) live at the Method level, so expand each seed class
    # to the methods it declares and traverse upstream from the whole set — that is
    # what surfaces the real callers (and, transitively, the exposed entry points).
    rows = db.run(
        f"""
        MATCH (seed:CodeNode) WHERE seed.id IN $ids
        OPTIONAL MATCH (seed)-[:DECLARES]->(mem:Method)
        WITH collect(DISTINCT seed) AS seeds,
             [x IN collect(DISTINCT mem) WHERE x IS NOT NULL] AS members
        WITH seeds, members, seeds + members AS starts
        UNWIND starts AS start
        CALL {{
            WITH start
            MATCH p = (start)<-[:{IMPACT_TYPES}*1..{depth}]-(m:CodeNode)
            RETURN m, min(length(p)) AS distance, collect(DISTINCT relationships(p)) AS relLists
            LIMIT 2000
        }}
        WITH seeds, members,
             collect({{node: properties(m), distance: distance}}) AS hits,
             reduce(acc = [], l IN collect(relLists) | acc + reduce(a2 = [], x IN l | a2 + x)) AS allRels
        RETURN [s IN seeds | properties(s)] AS seedNodes,
               [m IN members | properties(m)] AS memberNodes, hits,
               [r IN allRels | [startNode(r).id, type(r), properties(r), endNode(r).id]] AS rels
        """,
        ids=seed_ids,
    )
    if not rows or not rows[0]["seedNodes"]:
        return {"seeds": [], "nodes": [], "edges": [], "entryPoints": [],
                "counts": {"affected": 0, "entryPoints": 0, "byLabel": {}}}
    row = rows[0]
    seed_id_set = {n["id"] for n in (row["seedNodes"] or []) if n and n.get("id")}
    member_id_set = {n["id"] for n in (row["memberNodes"] or []) if n and n.get("id")}
    vuln_id_set = seed_id_set | member_id_set  # the vulnerable unit itself
    nodes: dict[str, dict] = {}
    for sn in row["seedNodes"]:
        n = _node_payload(sn)
        n["distance"] = 0
        n["isSeed"] = True
        n["isEntryPoint"] = n.get("label") in ENTRY_POINT_LABELS
        nodes[n["id"]] = n
    for mn in row["memberNodes"]:
        n = _node_payload(mn)
        if n["id"] in nodes:
            continue
        n["distance"] = 0
        n["isMember"] = True  # a method of the vulnerable class — part of the unit
        nodes[n["id"]] = n
    for hit in row["hits"]:
        if not hit.get("node"):
            continue
        n = _node_payload(hit["node"])
        if n["id"] in vuln_id_set or n.get("label") in STRUCTURAL_LABELS:
            continue  # skip the vulnerable unit and structural containers
        n["distance"] = hit["distance"]
        n["isSeed"] = False
        n["isEntryPoint"] = n.get("label") in ENTRY_POINT_LABELS
        existing = nodes.get(n["id"])
        if not existing or existing.get("distance", 99) > n["distance"]:
            nodes[n["id"]] = n
    ids = set(nodes)
    edges: dict[str, dict] = {}
    for src, rel_type, props, tgt in row["rels"] or []:
        if src in ids and tgt in ids:
            key = f"{src}|{rel_type}|{tgt}"
            edges.setdefault(key, {"id": key, "source": src, "target": tgt,
                                   "type": rel_type, "props": props or {}})
    affected = [n for n in nodes.values()
                if not n.get("isSeed") and not n.get("isMember")]
    entry_points = sorted(
        (n for n in affected if n.get("isEntryPoint")),
        key=lambda n: (n.get("distance", 99), n.get("label") or "", n.get("name") or ""),
    )
    by_label: dict[str, int] = {}
    for n in affected:
        by_label[n["label"]] = by_label.get(n["label"], 0) + 1
    return {
        "seeds": [n for n in nodes.values() if n.get("isSeed")],
        "nodes": list(nodes.values()),
        "edges": list(edges.values()),
        "entryPoints": entry_points,
        "counts": {
            "affected": len(affected),
            "entryPoints": len(entry_points),
            "byLabel": by_label,
        },
    }


def links(project: str, min_confidence: float) -> dict:
    rows = db.run(
        """
        MATCH (c:ApiCall {project: $p})-[r:INVOKES_API]->(e:Endpoint)
        WHERE r.confidence >= $min
        OPTIONAL MATCH (ctrl:Controller)-[:EXPOSES]->(e)
        RETURN properties(c) AS call, properties(e) AS endpoint,
               r.confidence AS confidence, r.tier AS tier, ctrl.name AS controller
        ORDER BY r.confidence DESC
        """,
        p=project,
        min=min_confidence,
    )
    unmatched_calls = db.run(
        """
        MATCH (c:ApiCall {project: $p})
        WHERE NOT (c)-[:INVOKES_API]->()
        RETURN properties(c) AS call
        """,
        p=project,
    )
    unmatched_eps = db.run(
        """
        MATCH (e:Endpoint {project: $p})
        WHERE NOT ()-[:INVOKES_API]->(e)
        OPTIONAL MATCH (ctrl:Controller)-[:EXPOSES]->(e)
        RETURN properties(e) AS endpoint, ctrl.name AS controller
        """,
        p=project,
    )
    return {
        "links": [
            {"apiCall": _node_payload(r["call"]), "endpoint": _node_payload(r["endpoint"]),
             "confidence": r["confidence"], "tier": r["tier"], "controller": r["controller"]}
            for r in rows
        ],
        "unmatchedApiCalls": [_node_payload(r["call"]) for r in unmatched_calls],
        "unmatchedEndpoints": [
            {**_node_payload(r["endpoint"]), "controller": r["controller"]}
            for r in unmatched_eps
        ],
    }


FORBIDDEN_CYPHER = re.compile(
    r"\b(CREATE|MERGE|DELETE|DETACH|SET|REMOVE|DROP|LOAD\s+CSV|FOREACH|CALL\s+apoc\.(create|merge|refactor|load|periodic))\b",
    re.IGNORECASE,
)


def read_cypher(query: str, params: dict | None) -> dict:
    if FORBIDDEN_CYPHER.search(query):
        raise ValueError("only read queries are allowed")
    with db.get_driver().session(default_access_mode="READ") as session:
        result = session.run(query, **(params or {}))
        columns = list(result.keys())
        rows = []
        for i, record in enumerate(result):
            if i >= 500:
                break
            rows.append([_to_plain(v) for v in record.values()])
        return {"columns": columns, "rows": rows}


def _to_plain(value):
    if hasattr(value, "items"):  # Node / Relationship / dict-like
        return dict(value.items())
    if isinstance(value, (list, tuple)):
        return [_to_plain(v) for v in value]
    return value
