from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from . import db, jobs
from .config import settings
from .services import (
    ask, diagrams, enrich, extractors, github, ingest, linker, physical, queries, scenarios,
)

router = APIRouter(prefix="/api")


@router.get("/health")
def health():
    return {"status": "ok", "neo4j": db.ping(), "llm": settings.llm_enabled}


class IngestRequest(BaseModel):
    project: str
    javaPath: str | None = None
    angularPath: str | None = None
    link: bool = True


@router.post("/ingest")
def start_ingest(req: IngestRequest):
    if not req.javaPath and not req.angularPath:
        raise HTTPException(400, "provide javaPath and/or angularPath")
    for p in (req.javaPath, req.angularPath):
        if p and not Path(p).is_dir():
            raise HTTPException(400, f"not a directory: {p}")
    if not db.ping():
        raise HTTPException(503, "neo4j is not reachable")

    def work(job):
        _run_pipeline(job, req.project, req.javaPath, req.angularPath, req.link)

    job = jobs.submit("ingest", work)
    return {"jobId": job.id}


def _run_pipeline(job, project: str, java_path: str | None, angular_path: str | None,
                  link: bool = True):
    """Shared ingestion pipeline: extract -> ingest -> link -> physical -> scenarios."""
    roots = {}
    if java_path:
        step = job.step("extract java")
        doc = extractors.run_java(java_path, project)
        step.done(f"{len(doc.get('nodes', []))} nodes, {len(doc.get('warnings', []))} warnings")
        step = job.step("ingest java")
        stats = ingest.ingest_document(doc)
        job.stats["java"] = stats
        step.done(f"{stats['nodes']} nodes, {stats['edges']} edges")
        roots["java"] = java_path
    if angular_path:
        step = job.step("extract angular")
        doc = extractors.run_angular(angular_path, project)
        step.done(f"{len(doc.get('nodes', []))} nodes, {len(doc.get('warnings', []))} warnings")
        step = job.step("ingest angular")
        stats = ingest.ingest_document(doc)
        job.stats["angular"] = stats
        step.done(f"{stats['nodes']} nodes, {stats['edges']} edges")
        roots["angular"] = angular_path
    if link:
        step = job.step("cross-stack linking")
        stats = linker.run_linker(project)
        job.stats["linker"] = stats
        step.done(f"{stats['linked']}/{stats['apiCalls']} api calls linked")
    step = job.step("physical view (deployment configs)")
    try:
        stats = physical.extract_physical(project, roots)
        job.stats["physical"] = stats
        step.done(f"{stats['deployments']} deployments, {stats['datasources']} datasources")
    except Exception as exc:
        step.fail(str(exc)[:200])
    step = job.step("scenarios (+1 view)")
    try:
        stats = scenarios.build_scenarios(project)
        job.stats["scenarios"] = stats
        step.done(f"{stats['scenarios']} scenarios ({stats['llmNamed']} LLM-named)")
    except Exception as exc:
        step.fail(str(exc)[:200])
    # remember source roots so ask/enrich can read code later
    db.run(
        "MERGE (p:Project {name: $p}) SET p.javaRoot = $j, p.angularRoot = $a",
        p=project, j=roots.get("java"), a=roots.get("angular"),
    )
    job.stats["roots"] = roots


class GithubPrecheckRequest(BaseModel):
    repoUrl: str


@router.post("/github/precheck")
def github_precheck(req: GithubPrecheckRequest):
    result = github.precheck(req.repoUrl)
    result["extractorsReady"] = {
        "java": Path(settings.java_extractor_jar).exists(),
        "angular": Path(settings.angular_extractor).exists(),
    }
    result["neo4j"] = db.ping()
    return result


class GithubIngestRequest(BaseModel):
    repoUrl: str
    project: str | None = None
    ref: str | None = None


@router.post("/ingest/github")
def start_github_ingest(req: GithubIngestRequest):
    check = github.validate_url(req.repoUrl)
    if not check["valid"]:
        raise HTTPException(400, check["reason"])
    if not db.ping():
        raise HTTPException(503, "neo4j is not reachable")
    url = check["normalized"]
    project = req.project or github.repo_name(url)

    def work(job):
        step = job.step("precheck remote")
        pre = github.precheck(url)
        if not pre.get("ok"):
            step.fail(pre.get("detail", "unreachable"))
            raise RuntimeError(f"precheck failed: {pre.get('detail')}")
        step.done(f"default branch {pre['defaultBranch']}, {pre['branches']} branches")

        step = job.step("clone repository")
        dest = github.clone(url, project, req.ref)
        step.done(str(dest))

        step = job.step("detect stacks")
        detected = github.detect_stacks(dest)
        job.stats["detected"] = {
            "javaCandidates": detected["javaCandidates"],
            "angularCandidates": detected["angularCandidates"],
        }
        if not detected["javaPath"] and not detected["angularPath"]:
            step.fail("no Spring Boot or Angular project found in the repository")
            raise RuntimeError("no Spring Boot (pom.xml/build.gradle + src/main/java) "
                               "or Angular (angular.json / @angular/core) project detected")
        found = []
        if detected["javaPath"]:
            found.append(f"java: {detected['javaCandidates'][0]}")
        if detected["angularPath"]:
            found.append(f"angular: {detected['angularCandidates'][0]}")
        step.done("; ".join(found))

        _run_pipeline(job, project, detected["javaPath"], detected["angularPath"])

    job = jobs.submit("github-ingest", work)
    return {"jobId": job.id, "project": project}


@router.get("/jobs/{job_id}")
def job_status(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "no such job")
    return job.to_dict()


@router.get("/projects")
def projects():
    return queries.list_projects()


@router.delete("/projects/{name}")
def delete_project(name: str):
    removed = ingest.delete_project(name)
    return {"removed": removed}


@router.get("/graph/overview")
def overview(project: str):
    return queries.overview(project)


@router.get("/graph/subgraph")
def subgraph(
    project: str = "",
    nodeId: str | None = None,
    depth: int = Query(1, ge=1, le=4),
    labels: str | None = None,
    edgeTypes: str | None = None,
    limit: int = Query(400, ge=1, le=2000),
    view: str | None = None,
):
    if not nodeId and not project:
        raise HTTPException(400, "provide project or nodeId")
    try:
        return queries.subgraph(
            project,
            nodeId,
            depth,
            labels.split(",") if labels else None,
            edgeTypes.split(",") if edgeTypes else None,
            limit,
            view,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc))


PATH_LABEL_RANK = ["Controller", "Service", "Component", "Entity", "Repository",
                   "DTO", "Endpoint", "Route", "Class", "Template", "File"]


@router.get("/nodes/by-path")
def node_by_path(project: str, path: str):
    """Resolve a file path (as cited in an answer) to its best graph node."""
    cleaned = path.strip().lstrip("/").split(" ")[0]
    rows = db.run(
        """
        MATCH (n:CodeNode {project: $p})
        WHERE n.filePath = $path OR n.filePath ENDS WITH $path
        RETURN n.id AS id, n.label AS label, n.name AS name, n.filePath AS fp
        LIMIT 25
        """,
        p=project, path=cleaned,
    )
    if not rows:
        raise HTTPException(404, f"no node found for path: {cleaned}")
    def rank(r):
        label_rank = PATH_LABEL_RANK.index(r["label"]) if r["label"] in PATH_LABEL_RANK else 99
        return (label_rank, len(r["fp"] or ""))
    best = min(rows, key=rank)
    return {"id": best["id"], "label": best["label"], "name": best["name"]}


@router.get("/nodes/{node_id:path}")
def node_detail(node_id: str):
    detail = queries.node_detail(node_id)
    if not detail:
        raise HTTPException(404, "no such node")
    return detail


@router.get("/search")
def search(
    q: str,
    project: str | None = None,
    labels: str | None = None,
    limit: int = Query(25, ge=1, le=100),
):
    return queries.search(q, project, labels.split(",") if labels else None, limit)


@router.get("/impact/{node_id:path}")
def impact(node_id: str, direction: str = "both", depth: int = Query(3, ge=1, le=6)):
    if direction not in ("upstream", "downstream", "both"):
        raise HTTPException(400, "direction must be upstream|downstream|both")
    return queries.impact(node_id, direction, depth)


@router.get("/links")
def links(project: str, minConfidence: float = Query(0.0, ge=0.0, le=1.0)):
    return queries.links(project, minConfidence)


class RelinkRequest(BaseModel):
    project: str


@router.post("/links/relink")
def relink(req: RelinkRequest):
    return linker.run_linker(req.project)


class EnrichRequest(BaseModel):
    project: str
    scope: str = "all"  # nodes | communities | all
    javaPath: str | None = None
    angularPath: str | None = None


@router.post("/enrich")
def start_enrich(req: EnrichRequest):
    if not settings.llm_enabled:
        raise HTTPException(409, "LLM is not configured (set ANTHROPIC_API_KEY in backend/.env)")
    roots = {"java": req.javaPath, "angular": req.angularPath}

    def work(job):
        if req.scope in ("nodes", "all"):
            step = job.step("summarize nodes")
            stats = enrich.enrich_nodes(req.project, job, project_roots=roots)
            job.stats["nodes"] = stats
            step.done(f"{stats['summarized']} summarized")
        if req.scope in ("communities", "all"):
            step = job.step("community detection + summaries")
            stats = enrich.enrich_communities(req.project, job)
            job.stats["communities"] = stats
            step.done(f"{stats.get('summarized', 0)}/{stats['communities']} communities summarized")

    job = jobs.submit("enrich", work)
    return {"jobId": job.id}


class ScenariosRequest(BaseModel):
    project: str


@router.post("/scenarios")
def build_scenarios(req: ScenariosRequest):
    def work(job):
        step = job.step("build scenario traces")
        stats = scenarios.build_scenarios(req.project)
        job.stats["scenarios"] = stats
        step.done(f"{stats['scenarios']} scenarios ({stats['llmNamed']} LLM-named)")

    job = jobs.submit("scenarios", work)
    return {"jobId": job.id}


@router.get("/scenarios")
def get_scenarios(project: str):
    return scenarios.list_scenarios(project)


@router.get("/sequence")
def sequence(project: str, nodeId: str):
    return diagrams.sequence(project, nodeId)


class AskRequest(BaseModel):
    project: str
    question: str
    history: list[dict] = []


@router.post("/ask")
def ask_question(req: AskRequest):
    """Starts an ask job; poll GET /api/jobs/{jobId} — stats.trail grows live
    (thought + tool entries), stats.answer/nodes appear when done."""
    if not settings.llm_enabled:
        raise HTTPException(409, "LLM is not configured (see backend/.env)")
    if not req.question.strip():
        raise HTTPException(400, "question is required")

    def work(job):
        trail: list = []
        job.stats["trail"] = trail
        result = ask.ask(req.project, req.question.strip(), req.history, trail=trail)
        job.stats["answer"] = result["answer"]
        job.stats["nodes"] = result["nodes"]

    job = jobs.submit("ask", work)
    return {"jobId": job.id}


@router.get("/ask/suggestions")
def ask_suggestions(project: str):
    """Project-specific starter questions derived from the graph (no LLM call)."""
    suggestions: list[str] = []
    try:
        rows = db.run(
            """
            MATCH (s:Scenario {project: $p})
            OPTIONAL MATCH (s)-[:COVERS]->(n)
            WITH s, count(n) AS covered ORDER BY covered DESC LIMIT 3
            RETURN s.title AS title
            """,
            p=project,
        )
        for r in rows:
            if r["title"]:
                suggestions.append(f"How does the “{r['title']}” flow work end to end?")

        rows = db.run(
            """
            MATCH (t:Table {project: $p})<-[:MAPS_TO]-(e:Entity)
            OPTIONAL MATCH (e)-[rel:RELATES_TO]-()
            WITH t, count(rel) AS rels ORDER BY rels DESC LIMIT 1
            RETURN t.name AS name
            """,
            p=project,
        )
        if rows and rows[0]["name"]:
            suggestions.append(
                f"Which screens are affected if I change the {rows[0]['name']} table?")

        rows = db.run(
            """
            MATCH (e:Endpoint {project: $p})
            WHERE NOT ()-[:INVOKES_API]->(e)
            RETURN count(e) AS c
            """,
            p=project,
        )
        if rows and rows[0]["c"] > 0:
            suggestions.append(
                f"Which endpoints are not called by any frontend code? ({rows[0]['c']} look unused)")

        rows = db.run(
            """
            MATCH (n:CodeNode {project: $p})
            WHERE toLower(n.name) CONTAINS 'auth' OR toLower(n.name) CONTAINS 'security'
            RETURN count(n) AS c
            """,
            p=project,
        )
        if rows and rows[0]["c"] >= 3:
            suggestions.append("How is authentication implemented?")
    except Exception:
        pass
    suggestions.append("Give me an overview of this system's architecture.")
    return suggestions[:6]


class CypherRequest(BaseModel):
    query: str
    params: dict | None = None


@router.post("/cypher")
def cypher(req: CypherRequest):
    try:
        return queries.read_cypher(req.query, req.params)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    except Exception as exc:
        raise HTTPException(400, f"query failed: {exc}")
