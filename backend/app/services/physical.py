"""Physical (deployment) view extractor — 4+1's physical view.

Scans the ingested project roots for deployment/config artifacts and writes
infra nodes straight into Neo4j:

- docker-compose*.y(a)ml  -> Deployment per service (+ CONNECTS_TO via depends_on)
- k8s manifests           -> Deployment per Deployment/StatefulSet/Service kind
- application*.yml/.properties -> Datasource (spring.datasource.*) + USES_DATASOURCE,
                                  HOSTS edges to the project's tables,
                                  PROVIDED_BY when a compose service backs the db port
- proxy.conf.json (angular dev proxy) -> CONNECTS_TO between the two stack Applications
"""

import json
import logging
import re
from pathlib import Path

import yaml

from .. import db

log = logging.getLogger(__name__)

SKIP_DIRS = {"node_modules", ".git", "target", "dist", "build", ".angular"}


def _walk(root: Path, patterns: list[str]) -> list[Path]:
    out = []
    for path in root.rglob("*"):
        if any(part in SKIP_DIRS for part in path.parts):
            continue
        if path.is_file() and any(path.match(p) for p in patterns):
            out.append(path)
    return out


def _merge_node(node_id: str, label: str, project: str, name: str, props: dict):
    db.run(
        f"""
        MERGE (n:CodeNode {{id: $id}})
        SET n:{label},
            n.label = $label, n.fqn = $fqn, n.name = $name, n.stack = 'infra',
            n.project = $project, n.filePath = coalesce($props.filePath, ''),
            n.startLine = 0, n.endLine = 0, n.hash = ''
        SET n += $props
        """,
        id=node_id, label=label, fqn=node_id.split("infra:", 1)[-1],
        name=name, project=project, props=props,
    )


def _merge_edge(src: str, tgt: str, rel: str, props: dict | None = None):
    if not re.fullmatch(r"\w+", rel):
        return
    db.run(
        f"""
        MATCH (a:CodeNode {{id: $src}}), (b:CodeNode {{id: $tgt}})
        MERGE (a)-[r:{rel}]->(b)
        SET r += $props
        """,
        src=src, tgt=tgt, props=props or {},
    )


def extract_physical(project: str, roots: dict) -> dict:
    """roots: {"java": path, "angular": path} (either may be missing)."""
    # wipe previous infra nodes for idempotent re-runs
    db.run("MATCH (n:CodeNode {project: $p, stack: 'infra'}) DETACH DELETE n", p=project)

    stats = {"deployments": 0, "datasources": 0, "connections": 0}
    compose_services: dict[str, str] = {}  # service name -> node id

    for stack, root_str in roots.items():
        if not root_str:
            continue
        root = Path(root_str)
        if not root.is_dir():
            continue

        # Compose files: conventional names + anything under a docker/ directory
        # (JHipster keeps app.yml / services.yml / postgresql.yml under src/main/docker).
        compose_files = _walk(root, [
            "docker-compose*.yml", "docker-compose*.yaml", "compose.yml", "compose.yaml",
            "*/docker/*.yml", "*/docker/*.yaml",
        ])
        for f in compose_files:
            stats["deployments"] += _extract_compose(project, root, f, compose_services)

        compose_paths = {f for f in compose_files}
        for f in _walk(root, ["*.yml", "*.yaml"]):
            if f in compose_paths or "docker-compose" in f.name or f.name.startswith("application"):
                continue
            stats["deployments"] += _extract_k8s(project, root, f)

    java_app = _app_id(project, "java")
    angular_app = _app_id(project, "angular")

    if roots.get("java"):
        root = Path(roots["java"])
        for f in _walk(root, ["application*.yml", "application*.yaml", "application*.properties"]):
            stats["datasources"] += _extract_datasource(project, root, f, java_app, compose_services)

    if roots.get("angular") and java_app and angular_app:
        root = Path(roots["angular"])
        for f in _walk(root, ["proxy.conf.json"]):
            try:
                conf = json.loads(f.read_text())
                targets = {v.get("target") for v in conf.values() if isinstance(v, dict) and v.get("target")}
                for target in targets:
                    _merge_edge(angular_app, java_app, "CONNECTS_TO",
                                {"via": "dev-proxy", "target": target})
                    stats["connections"] += 1
            except (json.JSONDecodeError, OSError) as exc:
                log.warning("proxy.conf parse failed %s: %s", f, exc)

    return stats


def _app_id(project: str, stack: str) -> str | None:
    rows = db.run(
        "MATCH (a:Application {project: $p, stack: $s}) RETURN a.id AS id LIMIT 1",
        p=project, s=stack,
    )
    return rows[0]["id"] if rows else None


def _extract_compose(project: str, root: Path, file: Path, registry: dict) -> int:
    try:
        data = yaml.safe_load(file.read_text()) or {}
    except (yaml.YAMLError, OSError) as exc:
        log.warning("compose parse failed %s: %s", file, exc)
        return 0
    services = data.get("services") or {}
    if not isinstance(services, dict):
        return 0
    rel = str(file.relative_to(root))
    count = 0
    for name, svc in services.items():
        if not isinstance(svc, dict):
            continue
        node_id = f"infra:deployment:{project}:{name}"
        ports = [str(p) for p in (svc.get("ports") or [])]
        _merge_node(node_id, "Deployment", project, name, {
            "kind": "docker-compose-service",
            "image": str(svc.get("image", "")),
            "containerName": str(svc.get("container_name", "")),
            "ports": ports,
            "filePath": rel,
        })
        registry[name] = node_id
        count += 1
    for name, svc in services.items():
        if not isinstance(svc, dict):
            continue
        deps = svc.get("depends_on") or []
        dep_names = list(deps.keys()) if isinstance(deps, dict) else list(deps)
        for dep in dep_names:
            if name in registry and dep in registry:
                _merge_edge(registry[name], registry[dep], "CONNECTS_TO", {"via": "depends_on"})
    return count


def _extract_k8s(project: str, root: Path, file: Path) -> int:
    try:
        docs = list(yaml.safe_load_all(file.read_text()))
    except (yaml.YAMLError, OSError):
        return 0
    count = 0
    for data in docs:
        if not isinstance(data, dict):
            continue
        kind = data.get("kind")
        if kind not in ("Deployment", "StatefulSet", "DaemonSet", "Service"):
            continue
        name = ((data.get("metadata") or {}).get("name")) or "unnamed"
        node_id = f"infra:deployment:{project}:k8s:{kind.lower()}:{name}"
        images = []
        spec = data.get("spec") or {}
        template = (spec.get("template") or {}).get("spec") or {}
        for c in template.get("containers") or []:
            if isinstance(c, dict) and c.get("image"):
                images.append(str(c["image"]))
        _merge_node(node_id, "Deployment", project, name, {
            "kind": f"k8s-{kind.lower()}",
            "image": images[0] if images else "",
            "filePath": str(file.relative_to(root)),
        })
        count += 1
    return count


JDBC_RE = re.compile(r"jdbc:(\w+)://([^/:]+)(?::(\d+))?/([\w-]+)")

# H2/HSQLDB embedded: jdbc:h2:mem:name;..  jdbc:h2:file:./path/name;..  jdbc:h2:tcp://host/name
_EMBEDDED_MODES = {"mem", "file", "tcp", "ssl", "zip", "nio"}


def _parse_jdbc(url: str) -> tuple[str, str, str, str]:
    """Return (vendor, host, port, dbname) for both server and embedded JDBC URLs."""
    vendor_m = re.match(r"jdbc:(\w+):", url)
    vendor = vendor_m.group(1) if vendor_m else "unknown"

    # server form: jdbc:vendor://host[:port]/db
    server = re.search(r"://([^/:;?]+)(?::(\d+))?/([\w$-]+)", url)
    if server:
        return vendor, server.group(1), server.group(2) or "", server.group(3)

    # embedded form: drop params, strip vendor + mode prefixes, take the final token
    tail = url.split(";")[0].split("?")[0]
    parts = [p for p in tail.split(":") if p]
    candidates = [
        p.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
        for p in parts[2:]  # skip "jdbc" and vendor
        if p not in _EMBEDDED_MODES and not p.isdigit()
    ]
    dbname = candidates[-1] if candidates else vendor
    return vendor, "", "", dbname


def _extract_datasource(project: str, root: Path, file: Path, java_app: str | None,
                        compose_services: dict) -> int:
    try:
        text = file.read_text()
    except OSError:
        return 0
    url = username = driver = app_name = None
    if file.suffix in (".yml", ".yaml"):
        try:
            data = yaml.safe_load(text) or {}
        except yaml.YAMLError:
            return 0
        spring = data.get("spring") or {}
        ds = spring.get("datasource") or {}
        url, username, driver = ds.get("url"), ds.get("username"), ds.get("driver-class-name")
        app_name = (spring.get("application") or {}).get("name")
    else:
        for line in text.splitlines():
            line = line.strip()
            if line.startswith("spring.datasource.url"):
                url = line.split("=", 1)[-1].strip()
            elif line.startswith("spring.datasource.username"):
                username = line.split("=", 1)[-1].strip()
            elif line.startswith("spring.datasource.driver-class-name"):
                driver = line.split("=", 1)[-1].strip()
            elif line.startswith("spring.application.name"):
                app_name = line.split("=", 1)[-1].strip()

    if app_name and java_app:
        db.run("MATCH (a:CodeNode {id: $id}) SET a.applicationName = $n", id=java_app, n=str(app_name))
    if not url:
        return 0

    url = str(url)
    # resolve ${ENV:default} placeholders to the default
    url_resolved = re.sub(r"\$\{[^:}]+:([^}]*)\}", r"\1", url)
    vendor, host, port, dbname = _parse_jdbc(url_resolved)

    node_id = f"infra:datasource:{project}:{dbname}"
    _merge_node(node_id, "Datasource", project, dbname, {
        "vendor": vendor, "url": url_resolved, "host": host, "port": port,
        "username": str(username or ""), "driver": str(driver or ""),
        "filePath": str(file.relative_to(root)),
    })
    if java_app:
        _merge_edge(java_app, node_id, "USES_DATASOURCE")

    # the datasource hosts every table of this project
    db.run(
        """
        MATCH (d:CodeNode {id: $ds}), (t:Table {project: $p})
        MERGE (d)-[:HOSTS]->(t)
        """,
        ds=node_id, p=project,
    )

    # link to a compose service that looks like the database container
    for name, dep_id in compose_services.items():
        rows = db.run("MATCH (d:CodeNode {id: $id}) RETURN d.image AS image, d.ports AS ports", id=dep_id)
        if not rows:
            continue
        image = (rows[0]["image"] or "").lower()
        ports = rows[0]["ports"] or []
        port_match = port and any(str(port) in p for p in ports)
        if vendor.lower() in image or name == host or port_match:
            _merge_edge(node_id, dep_id, "PROVIDED_BY")
    return 1
