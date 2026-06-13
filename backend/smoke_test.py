"""Backend smoke test: ingestion → linker → every query path, against live Neo4j.

Uses hand-crafted extractor documents (project __smoke__), cleaned up at the end.
Run: .venv/bin/python smoke_test.py
"""

from app import db
from app.services import ingest, linker, queries

P = "__smoke__"


def base(id_, label, stack, name, **props):
    return {
        "id": id_, "label": label, "fqn": id_.split(":", 1)[1], "name": name,
        "filePath": f"src/{name}.x", "startLine": 1, "endLine": 10,
        "hash": "h_" + name, "props": props,
    }


JAVA_DOC = {
    "schemaVersion": "1.0", "stack": "java", "project": P, "root": "/tmp",
    "nodes": [
        base("java:com.x.OrderController", "Controller", "java", "OrderController"),
        base("java:com.x.OrderService", "Service", "java", "OrderService"),
        base("java:com.x.Order", "Entity", "java", "Order", tableName="orders"),
        base("java:table:orders", "Table", "java", "orders", tableName="orders", columns=["id"]),
        base("java:com.x.OrderController#list():GET /api/orders", "Endpoint", "java", "GET /api/orders",
             httpMethod="GET", path="/api/orders", normalizedPath="/api/orders"),
        base("java:com.x.OrderController#get(long):GET /api/orders/{id}", "Endpoint", "java",
             "GET /api/orders/{id}", httpMethod="GET", path="/api/orders/{id}",
             normalizedPath="/api/orders/{*}"),
        base("java:com.x.OrderController#list()", "Method", "java", "list"),
        base("java:com.x.OrderService#findAll()", "Method", "java", "findAll"),
    ],
    "edges": [
        {"source": "java:com.x.OrderController", "target": "java:com.x.OrderService", "type": "INJECTS"},
        {"source": "java:com.x.OrderController", "target": "java:com.x.OrderController#list():GET /api/orders", "type": "EXPOSES"},
        {"source": "java:com.x.OrderController", "target": "java:com.x.OrderController#get(long):GET /api/orders/{id}", "type": "EXPOSES"},
        {"source": "java:com.x.OrderController#list():GET /api/orders", "target": "java:com.x.OrderController#list()", "type": "HANDLED_BY"},
        {"source": "java:com.x.OrderController#list()", "target": "java:com.x.OrderService#findAll()", "type": "CALLS", "props": {"line": 5}},
        {"source": "java:com.x.Order", "target": "java:table:orders", "type": "MAPS_TO"},
    ],
    "warnings": [],
}

NG_DOC = {
    "schemaVersion": "1.0", "stack": "angular", "project": P, "root": "/tmp",
    "nodes": [
        base("angular:src/app/o.service.ts:OrderService", "Service", "angular", "OrderService"),
        base("angular:src/app/o.component.ts:OrderListComponent", "Component", "angular", "OrderListComponent"),
        base("angular:src/app/o.service.ts:OrderService#list", "Method", "angular", "list"),
        base("angular:src/app/o.service.ts:OrderService#byId", "Method", "angular", "byId"),
        base("angular:src/app/o.service.ts:OrderService#list@call0", "ApiCall", "angular", "GET call",
             httpMethod="GET", urlExpression="`${this.base}/api/orders`",
             resolvedPath="/api/orders", normalizedPath="/api/orders",
             inMethod="src/app/o.service.ts:OrderService#list"),
        base("angular:src/app/o.service.ts:OrderService#byId@call0", "ApiCall", "angular", "GET call",
             httpMethod="GET", urlExpression="`${this.base}/api/orders/${id}`",
             resolvedPath="/api/orders/{*}", normalizedPath="/api/orders/{*}",
             inMethod="src/app/o.service.ts:OrderService#byId"),
    ],
    "edges": [
        {"source": "angular:src/app/o.component.ts:OrderListComponent", "target": "angular:src/app/o.service.ts:OrderService", "type": "INJECTS"},
        {"source": "angular:src/app/o.service.ts:OrderService#list", "target": "angular:src/app/o.service.ts:OrderService#list@call0", "type": "MAKES_CALL"},
        {"source": "angular:src/app/o.service.ts:OrderService#byId", "target": "angular:src/app/o.service.ts:OrderService#byId@call0", "type": "MAKES_CALL"},
    ],
    "warnings": [],
}


def main():
    assert db.ping(), "neo4j unreachable"
    db.ensure_schema()

    s1 = ingest.ingest_document(JAVA_DOC)
    s2 = ingest.ingest_document(NG_DOC)
    print("ingest java:", s1)
    print("ingest angular:", s2)
    assert s1["nodes"] == 8 and s2["nodes"] == 6

    # idempotency
    s1b = ingest.ingest_document(JAVA_DOC)
    assert s1b["staleRemoved"] == 0, s1b

    link_stats = linker.run_linker(P, use_llm=False)
    print("linker:", link_stats)
    assert link_stats["linked"] == 2, link_stats
    # both exact: /api/orders, and /api/orders/{*} == normalized /api/orders/{id}
    assert link_stats["byTier"].get("exact") == 2, link_stats

    print("projects:", queries.list_projects())
    print("overview:", queries.overview(P))

    sg = queries.subgraph(P, None, 1, None, None, 400)
    print(f"arch subgraph: {len(sg['nodes'])} nodes {len(sg['edges'])} edges")
    assert len(sg["nodes"]) >= 6

    sg2 = queries.subgraph(P, "java:com.x.OrderController", 2, None, None, 400)
    print(f"node subgraph: {len(sg2['nodes'])} nodes {len(sg2['edges'])} edges")
    assert len(sg2["nodes"]) >= 4

    detail = queries.node_detail("java:com.x.OrderController")
    assert detail and len(detail["neighbors"]) >= 3

    res = queries.search("OrderService", P, None, 10)
    print("search hits:", [r["id"] for r in res])
    assert any("OrderService" in r["id"] for r in res)

    imp = queries.impact("java:com.x.Order", "both", 4)
    print(f"impact: {len(imp['nodes'])} nodes")
    ids = {n["id"] for n in imp["nodes"]}
    # entity → table and entity ←(nothing yet)… via MAPS_TO at least
    assert "java:table:orders" in ids

    # cross-stack impact: from endpoint upstream should reach the angular ApiCall
    imp2 = queries.impact("java:com.x.OrderController#list():GET /api/orders", "both", 3)
    ids2 = {n["id"] for n in imp2["nodes"]}
    assert "angular:src/app/o.service.ts:OrderService#list@call0" in ids2, ids2

    lk = queries.links(P, 0.0)
    print(f"links: {len(lk['links'])} linked, {len(lk['unmatchedApiCalls'])} unmatched calls")
    assert len(lk["links"]) == 2

    cy = queries.read_cypher("MATCH (n:CodeNode {project: $p}) RETURN n.label, count(*)", {"p": P})
    print("cypher:", cy["rows"])
    try:
        queries.read_cypher("MATCH (n) DETACH DELETE n", None)
        raise SystemExit("mutation was not blocked!")
    except ValueError:
        print("mutation blocked: ok")

    removed = ingest.delete_project(P)
    print("cleanup removed:", removed)
    print("\nALL SMOKE TESTS PASSED")


if __name__ == "__main__":
    main()
