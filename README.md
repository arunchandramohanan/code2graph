# code2graph

Turns an Angular frontend + Java Spring Boot backend into **one unified knowledge graph** in Neo4j,
links the two stacks together at the HTTP boundary, enriches the graph with LLM summaries
(GraphRAG-style), and ships a web UI to explore, search, and run impact analysis across the whole system.

```
Angular source ──> angular-extractor (ts-morph + @angular/compiler) ──┐  JSON
                                                                      ├──> FastAPI backend ──> Neo4j
Spring source ──>  java-extractor   (JavaParser + symbol solver)   ──┘      │
                                                                            ├─ cross-stack linker (ApiCall ↔ Endpoint)
                                                                            ├─ LLM enrichment (Claude via Vertex AI)
React/Vite UI  <────────────────────────────────────────────────────────────┘
```

## Components

| Path                          | What it is                                                            |
|-------------------------------|-----------------------------------------------------------------------|
| `extractors/java-extractor`   | Maven/JavaParser CLI: Spring semantics → graph JSON (no LLM)          |
| `extractors/angular-extractor`| Node/ts-morph CLI: components, DI, routes, templates, HttpClient calls|
| `backend`                     | FastAPI: ingestion, Neo4j storage, 3-tier cross-stack linker, LLM enrichment, query API |
| `frontend`                    | React + Vite (JSX): dashboard, graph explorer, search, impact analysis, API-links view |
| `docs/CONTRACTS.md`           | **The contract**: ontology, JSON exchange format, HTTP API            |
| `samples/`                    | Small Spring + Angular fixture apps used to verify the extractors     |
| `scripts/start.sh / stop.sh`  | Run/stop backend (:3015) + frontend (:3014)                           |

## Prerequisites

- Java 17+ & Maven (java extractor), Node 20+ (angular extractor + frontend), Python 3.12+ (backend)
- Neo4j 5.x on `bolt://localhost:7687` (installed as a systemd service on this box,
  user `neo4j` / password `code2graph`; or `docker compose up neo4j`)
- LLM access (optional but recommended): Vertex AI service account for Claude
  (configured in `backend/.env`; currently `llmaccess/service-account.json`, model `claude-opus-4-6`).
  Without it everything still works except node/community summaries and tier-3 linking.

## Build & run

```bash
# 1. extractors
cd extractors/java-extractor   && mvn -q package          # -> target/java-extractor.jar
cd extractors/angular-extractor && npm install && npm run build   # -> dist/index.js

# 2. backend + frontend
./scripts/start.sh    # backend on :3015, frontend on :3014
```

Open `http://<host>:3014`, then on the Dashboard ingest a project — two ways:

- **GitHub repository (default):** paste any repo URL (e.g. `https://github.com/owner/repo`).
  The backend pre-checks the URL shape and reachability (`git ls-remote`), shallow-clones into
  `workspace/`, auto-detects the Spring Boot root (pom.xml/build.gradle + `src/main/java`) and the
  Angular root (`angular.json` / `@angular/core`) anywhere in the repo, then runs the full pipeline.
- **Local paths:** absolute paths to already-checked-out Spring Boot / Angular projects.

The pipeline: extract → ingest → cross-stack link → physical view (docker-compose/k8s/
application.yml/dev-proxy) → scenarios (+1 view, LLM-named) — with live step progress.
Then use **Graph** (with the **4+1 view switcher**: Logical / Development / Process / Physical /
Scenarios), **Search**, **Impact** ("what breaks if I change this?"), **API Links**
(Angular HTTP call ↔ Spring endpoint with confidence/tier), **Scenarios** (use-case cards),
and **Ask** — a GraphRAG chat where Claude answers questions about the codebase by exploring
the graph itself (fulltext search, neighborhoods, read-only Cypher) and reading the actual
source from the cloned repo, returning the full evidence trail with links into the graph.

Enrichment (summaries + community detection) runs via `POST /api/enrich`:

```bash
curl -X POST http://localhost:3015/api/enrich -H 'Content-Type: application/json' \
  -d '{"project":"banking","scope":"all","javaPath":"/path/to/backend","angularPath":"/path/to/frontend"}'
```

## How the cross-stack linking works

1. Extractors record every Spring `Endpoint` (verb + path template) and every Angular `ApiCall`
   (verb + URL expression, statically resolved through `environment.*`, class fields, and template
   literals; dynamic segments become `{*}`).
2. The linker matches them in three tiers: **exact** normalized-path equality (confidence 1.0),
   **pattern** segment-wise matching with wildcards (0.5–0.9), and an **LLM fallback** for
   genuinely dynamic URLs (≤0.85). Each `INVOKES_API` edge carries `confidence` and `tier`.
3. One Cypher traversal then answers questions like *"if I change this JPA entity, which Angular
   components are affected?"* — that's the Impact page.

## Verified against

`https://github.com/arditlleshi/banking-mini-system` (Spring Boot 4 / Java 21 + Angular 21):
540 Java nodes, 592 Angular nodes, **19/19 API calls linked to endpoints (all tier "exact")**,
12 detected communities summarized by Claude Opus 4.6, 8 LLM-named scenarios
("Create Payment or Transfer", "View Account Statement", …), plus physical view
(postgres compose service ← datasource ← application, frontend → backend dev proxy).

## 4+1 architectural views

| View | Source | Shown as |
|---|---|---|
| Logical | classes/services/components/entities + their wiring | Graph preset `logical` |
| Development | files/modules + IMPORTS/DECLARES | Graph preset `development` |
| Process | `@Async`/`@Scheduled`/`@Transactional` methods, Kafka/Rabbit/JMS topics, PUBLISHES_TO/CONSUMES_FROM | Graph preset `process` |
| Physical | docker-compose/k8s services, datasources (application.yml), dev-proxy links | Graph preset `physical` |
| Scenarios (+1) | per-route trace Route→Component→ApiCall→Endpoint→Entity→Table, LLM-named | Scenarios page + Graph preset `scenarios` |

## Useful direct queries (`POST /api/cypher`, read-only)

```cypher
// Angular components that ultimately depend on a given entity
MATCH (e:Entity {name:'AccountEntity'})<-[:MANAGES|READS|WRITES]-(:Repository)
      <-[:INJECTS|CALLS*1..3]-(:CodeNode)<-[:HANDLED_BY]-(ep:Endpoint)
      <-[:INVOKES_API]-(:ApiCall)<-[:MAKES_CALL]-(m)
RETURN DISTINCT ep.path, m.fqn

// Cross-stack API surface with confidence
MATCH (c:ApiCall)-[r:INVOKES_API]->(ep:Endpoint)
RETURN c.httpMethod, c.normalizedPath, ep.path, r.tier, r.confidence ORDER BY r.confidence
```
