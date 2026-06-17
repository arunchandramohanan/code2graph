"""Maven dependency extractor.

Parses every pom.xml under the project's Java root into `Dependency` nodes and
maps them to the code that uses them, so a third-party library (e.g. a vulnerable
one) becomes a first-class graph node you can trace and run a blast radius from:

- each <dependency> in a pom.xml -> a Dependency node, linked to the Java
  Application via DECLARES_DEPENDENCY
- (:Class)-[:USES_DEPENDENCY]->(:Dependency) for every type whose source file
  imports a package under the dependency's groupId

Usage mapping is a heuristic: an import is attributed to the dependency whose
groupId is the longest prefix of the imported package. When several artifacts
share that groupId the import is attributed to all of them (groupId alone can't
pin the artifact).
"""

import logging
import re
import xml.etree.ElementTree as ET
from pathlib import Path

from .. import db

log = logging.getLogger(__name__)

SKIP_DIRS = {"node_modules", ".git", "target", "dist", "build", ".angular"}
IMPORT_RE = re.compile(r"^\s*import\s+(?:static\s+)?([\w.]+)\s*;", re.M)
# Type-declaration nodes (everything class-shaped, excluding members/containers).
NON_TYPE_LABELS = ["File", "Method", "Endpoint", "ApiCall", "Application", "Dependency"]


def _strip_ns(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _parse_pom(path: Path) -> list[dict]:
    try:
        root = ET.parse(path).getroot()
    except Exception as exc:  # malformed pom — skip, don't fail the run
        log.warning("pom parse failed %s: %s", path, exc)
        return []
    # Exclude <dependencyManagement> entries — those only pin versions, they are
    # not actual dependencies of the module.
    managed: set[int] = set()
    for dm in root.iter():
        if _strip_ns(dm.tag) == "dependencyManagement":
            for d in dm.iter():
                if _strip_ns(d.tag) == "dependency":
                    managed.add(id(d))
    out = []
    for d in root.iter():
        if _strip_ns(d.tag) != "dependency" or id(d) in managed:
            continue
        vals = {"groupId": None, "artifactId": None, "version": None, "scope": None}
        for ch in d:
            t = _strip_ns(ch.tag)
            if t in vals:
                vals[t] = (ch.text or "").strip()
        if vals["groupId"] and vals["artifactId"]:
            out.append(vals)
    return out


def _merge_dependency(project: str, dep: dict) -> str:
    node_id = f"java:dependency:{dep['groupId']}:{dep['artifactId']}"
    db.run(
        """
        MERGE (n:CodeNode {id: $id})
        SET n:Dependency,
            n.label = 'Dependency', n.stack = 'system', n.project = $project,
            n.name = $name, n.fqn = $fqn, n.filePath = '',
            n.startLine = 0, n.endLine = 0, n.hash = '',
            n.groupId = $groupId, n.artifactId = $artifactId,
            n.version = $version, n.scope = $scope
        """,
        id=node_id, project=project, name=dep["artifactId"],
        fqn=f"{dep['groupId']}:{dep['artifactId']}",
        groupId=dep["groupId"], artifactId=dep["artifactId"],
        version=dep["version"], scope=dep["scope"],
    )
    return node_id


def _merge_edge(src: str, tgt: str, rel: str) -> None:
    db.run(
        f"""
        MATCH (a:CodeNode {{id: $src}}), (b:CodeNode {{id: $tgt}})
        MERGE (a)-[:{rel}]->(b)
        """,
        src=src, tgt=tgt,
    )


def build_dependencies(project: str, java_root: str | None) -> dict:
    stats = {"poms": 0, "dependencies": 0, "usedDependencies": 0, "usageEdges": 0}
    # Idempotent re-run: drop previously extracted dependency nodes/edges.
    db.run("MATCH (n:CodeNode {project: $p, label: 'Dependency'}) DETACH DELETE n", p=project)
    if not java_root:
        return stats
    root = Path(java_root)
    if not root.is_dir():
        return stats

    poms = [
        p for p in root.rglob("pom.xml")
        if not any(part in SKIP_DIRS for part in p.parts)
    ]
    stats["poms"] = len(poms)

    # group_to_deps: groupId -> {depId}; deps keyed by (groupId, artifactId)
    group_to_deps: dict[str, set[str]] = {}
    seen: set[tuple[str, str]] = set()
    app_id = f"java:application:{project}"
    for pom in poms:
        for dep in _parse_pom(pom):
            key = (dep["groupId"], dep["artifactId"])
            if key in seen:
                continue
            seen.add(key)
            dep_id = _merge_dependency(project, dep)
            _merge_edge(app_id, dep_id, "DECLARES_DEPENDENCY")
            group_to_deps.setdefault(dep["groupId"], set()).add(dep_id)
    stats["dependencies"] = len(seen)
    if not group_to_deps:
        return stats

    # longest groupId prefix wins; ties (same groupId, many artifacts) link to all
    groups_by_len = sorted(group_to_deps, key=len, reverse=True)

    def deps_for_import(pkg: str) -> set[str]:
        for g in groups_by_len:
            if pkg == g or pkg.startswith(g + "."):
                return group_to_deps[g]
        return set()

    # type nodes grouped by source file
    rows = db.run(
        f"""
        MATCH (n:CodeNode {{project: $p, stack: 'java'}})
        WHERE NOT n.label IN $skip AND n.filePath ENDS WITH '.java'
        RETURN n.filePath AS fp, collect(n.id) AS ids
        """,
        p=project, skip=NON_TYPE_LABELS,
    )
    used: set[str] = set()
    for row in rows:
        fp, class_ids = row["fp"], row["ids"]
        if not fp or not class_ids:
            continue
        try:
            text = (root / fp).read_text(errors="ignore")
        except OSError:
            continue
        dep_ids: set[str] = set()
        for imp in IMPORT_RE.findall(text):
            dep_ids |= deps_for_import(imp)
        for dep_id in dep_ids:
            used.add(dep_id)
            for cid in class_ids:
                _merge_edge(cid, dep_id, "USES_DEPENDENCY")
                stats["usageEdges"] += 1
    stats["usedDependencies"] = len(used)
    return stats
