"""Neo4j driver wrapper plus schema bootstrap (constraints + indexes)."""

import logging

from neo4j import GraphDatabase

from .config import settings

log = logging.getLogger(__name__)

_driver = None

SCHEMA_STATEMENTS = [
    "CREATE CONSTRAINT code_node_id IF NOT EXISTS FOR (n:CodeNode) REQUIRE n.id IS UNIQUE",
    "CREATE INDEX code_node_project IF NOT EXISTS FOR (n:CodeNode) ON (n.project)",
    "CREATE INDEX code_node_label IF NOT EXISTS FOR (n:CodeNode) ON (n.label)",
    "CREATE INDEX code_node_fqn IF NOT EXISTS FOR (n:CodeNode) ON (n.fqn)",
    """CREATE FULLTEXT INDEX code_node_search IF NOT EXISTS
       FOR (n:CodeNode) ON EACH [n.name, n.fqn, n.filePath, n.summary]""",
]


def get_driver():
    global _driver
    if _driver is None:
        _driver = GraphDatabase.driver(
            settings.neo4j_uri,
            auth=(settings.neo4j_user, settings.neo4j_password),
            notifications_min_severity="OFF",
        )
    return _driver


def close_driver():
    global _driver
    if _driver is not None:
        _driver.close()
        _driver = None


def run(query: str, **params) -> list[dict]:
    with get_driver().session() as session:
        result = session.run(query, **params)
        return [dict(record) for record in result]


def ping() -> bool:
    try:
        run("RETURN 1")
        return True
    except Exception:
        return False


def ensure_schema():
    for stmt in SCHEMA_STATEMENTS:
        try:
            run(stmt)
        except Exception as exc:  # index syntax differences across versions shouldn't kill startup
            log.warning("schema statement failed: %s (%s)", stmt.split("\n")[0], exc)
