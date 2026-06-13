"""Ingest extractor JSON documents into Neo4j.

Idempotent: nodes are MERGEd on id; a node whose `hash` is unchanged keeps its
enrichment properties (summary/tags/embedding), a changed hash clears them.
Stale nodes (present in the DB for this project+stack but absent from the new
document) are removed, so re-ingestion converges to the document.
"""

from datetime import datetime, timezone

from .. import db

BATCH = 1000

# Whitelist of primary labels we apply as real Neo4j labels (second label next to CodeNode).
KNOWN_LABELS = {
    "Application", "Module", "File", "Class", "Component", "Service", "Controller",
    "Endpoint", "ApiCall", "Method", "DTO", "Entity", "Table", "Repository", "Route",
    "Template", "Topic", "Deployment", "Datasource", "Scenario",
}

KNOWN_EDGES = {
    "DECLARES", "IMPORTS", "INJECTS", "CALLS", "EXTENDS", "IMPLEMENTS", "RENDERS",
    "BINDS", "USES_TEMPLATE", "NAVIGATES_TO", "EXPOSES", "HANDLED_BY", "MAKES_CALL",
    "ACCEPTS", "RETURNS", "MAPS_TO", "RELATES_TO", "READS", "WRITES", "MANAGES",
    "PUBLISHES_TO", "CONSUMES_FROM",
}


def _chunks(items: list, size: int):
    for i in range(0, len(items), size):
        yield items[i : i + size]


def _flatten(node: dict, project: str, stack: str) -> dict:
    props = dict(node.get("props") or {})
    props.update(
        id=node["id"],
        fqn=node.get("fqn", node["id"]),
        name=node.get("name", ""),
        label=node.get("label", "Class"),
        stack=stack,
        project=project,
        filePath=node.get("filePath", ""),
        startLine=node.get("startLine", 0),
        endLine=node.get("endLine", 0),
        hash=node.get("hash", ""),
    )
    # Neo4j props must be primitives / arrays of primitives.
    return {
        k: v
        for k, v in props.items()
        if isinstance(v, (str, int, float, bool)) or (
            isinstance(v, list) and all(isinstance(x, (str, int, float, bool)) for x in v)
        )
    }


def ingest_document(doc: dict) -> dict:
    project = doc["project"]
    stack = doc["stack"]
    nodes = [_flatten(n, project, stack) for n in doc.get("nodes", [])]
    node_ids = {n["id"] for n in nodes}
    edges = [
        e for e in doc.get("edges", [])
        if e.get("type") in KNOWN_EDGES
        and e.get("source") in node_ids and e.get("target") in node_ids
    ]
    dropped_edges = len(doc.get("edges", [])) - len(edges)

    by_label: dict[str, list[dict]] = {}
    for n in nodes:
        label = n["label"] if n["label"] in KNOWN_LABELS else "Class"
        by_label.setdefault(label, []).append(n)

    for label, group in by_label.items():
        for chunk in _chunks(group, BATCH):
            db.run(
                f"""
                UNWIND $rows AS row
                MERGE (n:CodeNode {{id: row.id}})
                SET n:{label}
                FOREACH (_ IN CASE WHEN coalesce(n.hash, '') <> row.hash THEN [1] ELSE [] END |
                    SET n.summary = null, n.tags = null, n.embedding = null, n.community = null)
                SET n += row
                """,
                rows=chunk,
            )

    # Replace this stack's relationships wholesale; cheaper than diffing and
    # cross-stack INVOKES_API edges are re-created by the linker afterwards.
    db.run(
        """
        MATCH (n:CodeNode {project: $project, stack: $stack})-[r]-()
        DELETE r
        """,
        project=project,
        stack=stack,
    )

    by_type: dict[str, list[dict]] = {}
    for e in edges:
        by_type.setdefault(e["type"], []).append(
            {"source": e["source"], "target": e["target"], "props": _edge_props(e)}
        )
    for rel_type, group in by_type.items():
        for chunk in _chunks(group, BATCH):
            db.run(
                f"""
                UNWIND $rows AS row
                MATCH (a:CodeNode {{id: row.source}}), (b:CodeNode {{id: row.target}})
                MERGE (a)-[r:{rel_type}]->(b)
                SET r += row.props
                """,
                rows=chunk,
            )

    stale = db.run(
        """
        MATCH (n:CodeNode {project: $project, stack: $stack})
        WHERE NOT n.id IN $ids
        DETACH DELETE n
        RETURN count(*) AS removed
        """,
        project=project,
        stack=stack,
        ids=list(node_ids),
    )

    db.run(
        """
        MERGE (p:Project {name: $project})
        SET p.lastIngestedAt = $now
        """,
        project=project,
        now=datetime.now(timezone.utc).isoformat(),
    )

    return {
        "stack": stack,
        "nodes": len(nodes),
        "edges": len(edges),
        "droppedEdges": dropped_edges,
        "staleRemoved": stale[0]["removed"] if stale else 0,
        "warnings": len(doc.get("warnings", [])),
    }


def _edge_props(edge: dict) -> dict:
    props = edge.get("props") or {}
    return {
        k: v for k, v in props.items()
        if isinstance(v, (str, int, float, bool))
        or (isinstance(v, list) and all(isinstance(x, (str, int, float, bool)) for x in v))
    }


def delete_project(project: str) -> int:
    res = db.run(
        "MATCH (n:CodeNode {project: $project}) DETACH DELETE n RETURN count(*) AS removed",
        project=project,
    )
    db.run("MATCH (p:Project {name: $project}) DELETE p", project=project)
    return res[0]["removed"] if res else 0
