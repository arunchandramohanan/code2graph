"""Sequence-diagram builder.

A sequence diagram traces ONE entry point (an endpoint, an API call, or a method)
through the call graph in call order, producing ordered messages between
participants (the owning classes). Whole-project sequence diagrams don't exist —
a sequence is always a single flow.
"""

from .. import db


def _resolve_root_method(node_id: str) -> str | None:
    rows = db.run("MATCH (n:CodeNode {id: $id}) RETURN n.label AS label", id=node_id)
    if not rows:
        return None
    label = rows[0]["label"]
    if label == "Method":
        return node_id
    if label == "Endpoint":
        r = db.run("MATCH (:Endpoint {id:$id})-[:HANDLED_BY]->(m:Method) RETURN m.id AS id", id=node_id)
        return r[0]["id"] if r else None
    if label == "ApiCall":
        r = db.run(
            "MATCH (:ApiCall {id:$id})-[:INVOKES_API]->(:Endpoint)-[:HANDLED_BY]->(m:Method) RETURN m.id AS id",
            id=node_id,
        )
        return r[0]["id"] if r else None
    return None


def sequence(project: str, node_id: str, max_steps: int = 60, max_depth: int = 8) -> dict:
    root = _resolve_root_method(node_id)
    if not root:
        return {"participants": [], "steps": [], "root": None,
                "note": "Pick an Endpoint, API call, or Method to trace a sequence."}

    owner = {
        r["mid"]: {"name": r["cname"], "label": r["clabel"], "stack": r["cstack"]}
        for r in db.run(
            """MATCH (c:CodeNode {project:$p})-[:DECLARES]->(m:Method {project:$p})
               RETURN m.id AS mid, c.name AS cname, c.label AS clabel, c.stack AS cstack""",
            p=project,
        )
    }
    mname = {r["id"]: r["name"] for r in
             db.run("MATCH (m:Method {project:$p}) RETURN m.id AS id, m.name AS name", p=project)}
    calls: dict[str, list] = {}
    for r in db.run(
        """MATCH (a:Method {project:$p})-[r:CALLS]->(b:Method {project:$p})
           RETURN a.id AS s, b.id AS t, coalesce(r.line, 999999) AS line""",
        p=project,
    ):
        calls.setdefault(r["s"], []).append((r["line"], r["t"]))
    for k in calls:
        calls[k].sort()

    def participant(mid: str) -> dict:
        o = owner.get(mid)
        if o:
            return {"name": o["name"], "label": o["label"], "stack": o["stack"]}
        return {"name": mname.get(mid, mid.split(":")[-1]), "label": "Method", "stack": ""}

    participants: list[dict] = []
    seen_part = set()

    def add_part(p: dict):
        if p["name"] not in seen_part:
            seen_part.add(p["name"])
            participants.append(p)

    steps: list[dict] = []
    visited = {root}
    truncated = [False]

    def dfs(mid: str, depth: int):
        if depth > max_depth:
            return
        for _line, tgt in calls.get(mid, []):
            if len(steps) >= max_steps:
                truncated[0] = True
                return
            caller, callee = participant(mid), participant(tgt)
            add_part(caller)
            add_part(callee)
            steps.append({
                "from": caller["name"], "to": callee["name"],
                "message": mname.get(tgt, "?"), "depth": depth,
                "selfCall": caller["name"] == callee["name"],
            })
            if tgt not in visited:
                visited.add(tgt)
                dfs(tgt, depth + 1)

    add_part(participant(root))
    dfs(root, 0)

    return {
        "project": project,
        "root": participant(root)["name"],
        "rootMethod": mname.get(root, ""),
        "participants": participants,
        "steps": steps,
        "truncated": truncated[0],
    }
