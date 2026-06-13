# code2graph — Contracts

Single source of truth for the unified ontology, the extractor JSON exchange format,
and the backend HTTP API. **All components (extractors, backend, frontend) must conform to this document.**

---

## 1. Unified ontology (stack-neutral)

### Node labels

Every node gets the Neo4j label `CodeNode` **plus** its primary label below.

| Label        | Meaning                                                        | Stack    |
|--------------|----------------------------------------------------------------|----------|
| `Application`| Root node per ingested project/stack                           | both     |
| `Module`     | NgModule (Angular) / Maven module or top-level package (Java)  | both     |
| `File`       | Source file                                                    | both     |
| `Class`      | Plain class/interface not covered by a more specific label     | both     |
| `Component`  | Angular `@Component`                                           | angular  |
| `Service`    | Angular `@Injectable` / Spring `@Service`/`@Component` bean    | both     |
| `Controller` | Spring `@RestController`/`@Controller`                         | java     |
| `Endpoint`   | One HTTP operation exposed by a controller method              | java     |
| `ApiCall`    | One HttpClient invocation site (candidate for linking)         | angular  |
| `Method`     | Method / function declared by a class/component/service        | both     |
| `DTO`        | Request/response payload type                                  | both     |
| `Entity`     | JPA `@Entity`                                                  | java     |
| `Table`      | Database table derived from an entity                          | java     |
| `Repository` | Spring Data repository interface                               | java     |
| `Route`      | Angular router route config entry                              | angular  |
| `Template`   | Angular component HTML template                                | angular  |
| `Deployment` | Deployable/infra unit (docker-compose service, k8s deployment)| infra    |
| `Datasource` | Database connection (spring.datasource.*)                     | infra    |
| `Topic`      | Message channel (Kafka topic / Rabbit queue / JMS destination)| java     |
| `Scenario`   | Named use-case slice through the system (4+1 "+1" view)       | system   |

`stack` may therefore also be `infra` (deployment/config-derived) or `system` (cross-cutting, derived).

**Process-view properties on `Method` nodes** (set by the java extractor):
`async` (bool, `@Async`), `scheduled` (string — cron/fixedRate/fixedDelay expression or "true", `@Scheduled`),
`transactional` (bool, `@Transactional` on the method or its class).

### Required node properties (all nodes)

| Property    | Type   | Notes                                                          |
|-------------|--------|----------------------------------------------------------------|
| `id`        | string | Stable unique id: `<stack>:<fqn>` (see FQN rules below)        |
| `fqn`       | string | Fully-qualified name, unique within a stack                    |
| `name`      | string | Short display name                                             |
| `label`     | string | Primary label (duplicated as property for easy querying)       |
| `stack`     | string | `java` \| `angular`                                            |
| `project`   | string | Ingestion project name                                         |
| `filePath`  | string | Relative to project root (`""` for derived nodes like Table)   |
| `startLine` | int    | 0 if not applicable                                            |
| `endLine`   | int    | 0 if not applicable                                            |
| `hash`      | string | sha256 of the defining source slice (incremental re-ingestion) |

Type-specific properties go flat on the node (no nesting). Conventions:

- `Endpoint`: `httpMethod` (GET/POST/...), `path` (e.g. `/api/orders/{id}`), `normalizedPath`
  (path params collapsed: `/api/orders/{*}`), `requestType`, `responseType` (FQNs, may be "")
- `ApiCall`: `httpMethod`, `urlExpression` (raw source text), `resolvedPath` (best-effort static
  resolution, `{*}` for dynamic segments, "" if unresolvable), `normalizedPath`, `inMethod` (fqn)
- `Component`: `selector`, `templatePath`, `standalone` (bool), `inputs` (string[]), `outputs` (string[])
- `Route`: `routePath`, `componentFqn` (may be "", e.g. lazy routes carry `lazyImport` instead)
- `Entity`: `tableName`
- `Table`: `tableName`, `columns` (string[])
- `Method`: `signature`, `returnType`, `params` (string[]), `visibility`
- `Repository`: `entityFqn`, `idType`
- `Class`/`DTO`: `fields` (string[] as `name:type`)

**FQN rules**
- Java: standard FQN (`com.acme.orders.OrderService`), methods `com.acme.orders.OrderService#findById(long)`,
  endpoints `<controllerFqn>#<methodName>:<HTTPMETHOD> <path>`, tables `table:<tableName>`.
- Angular: project-relative path based (`src/app/orders/order.service.ts:OrderService`), methods
  `<classFqn>#<methodName>`, api calls `<methodFqn>@call<N>` (N = ordinal within the method),
  templates `<componentFqn>:template`, routes `route:<routePath>` (or `route:<parent>/<routePath>` to keep them unique).

### Edge types

| Type           | From → To                              | Props                                  |
|----------------|----------------------------------------|----------------------------------------|
| `DECLARES`     | App→Module, Module→File, File→Class-likes, Class-like→Method | |
| `IMPORTS`      | File→File (resolved imports)           |                                        |
| `INJECTS`      | Class-like→Class-like (constructor/field/`inject()` DI) | `via` (param name)    |
| `CALLS`        | Method→Method (resolved invocations)   | `line`                                 |
| `EXTENDS`      | Class-like→Class-like                  |                                        |
| `IMPLEMENTS`   | Class-like→Class-like                  |                                        |
| `RENDERS`      | Component→Component (child usage in template) | `viaSelector`                   |
| `BINDS`        | Template→Method (event handler bindings) | `event`, `expression`                |
| `USES_TEMPLATE`| Component→Template                     |                                        |
| `NAVIGATES_TO` | Route→Component                        |                                        |
| `EXPOSES`      | Controller→Endpoint                    |                                        |
| `HANDLED_BY`   | Endpoint→Method                        |                                        |
| `MAKES_CALL`   | Method→ApiCall                         |                                        |
| `INVOKES_API`  | ApiCall→Endpoint (**created by linker, not extractors**) | `confidence` (0-1), `tier` (`exact`\|`pattern`\|`llm`) |
| `ACCEPTS`      | Endpoint→DTO                           |                                        |
| `RETURNS`      | Endpoint→DTO / Method→Class-like       |                                        |
| `MAPS_TO`      | Entity→Table                           |                                        |
| `RELATES_TO`   | Entity→Entity (JPA relations)          | `kind` (OneToMany/...), `field`        |
| `READS`        | Repository→Entity                      |                                        |
| `WRITES`       | Repository→Entity                      |                                        |
| `MANAGES`      | Repository→Entity (catch-all CRUD)     |                                        |
| `PUBLISHES_TO` | Method→Topic (KafkaTemplate/RabbitTemplate/JmsTemplate send) |                  |
| `CONSUMES_FROM`| Topic→Method (@KafkaListener/@RabbitListener/@JmsListener)   |                  |
| `DEPLOYED_AS`  | Application→Deployment (**backend physical extractor**)      |                  |
| `CONNECTS_TO`  | Deployment→Deployment / Application→Application (compose depends_on, dev proxy) | `via` |
| `USES_DATASOURCE` | Application→Datasource (**backend physical extractor**)   |                  |
| `PROVIDED_BY`  | Datasource→Deployment (db container backing the datasource)  |                  |
| `HOSTS`        | Datasource→Table                       |                                        |
| `COVERS`       | Scenario→CodeNode (**backend scenario builder**)              | `role` (route/component/endpoint/entity/table) |

Extractors **never** emit `INVOKES_API`; the backend linker creates those edges.

---

## 2. Extractor JSON exchange format

Each extractor is a CLI producing one JSON document:

```
java -jar java-extractor.jar --src <projectRoot> --project <name> --out graph.json
node angular-extractor/dist/index.js --src <projectRoot> --project <name> --out graph.json
```

```json
{
  "schemaVersion": "1.0",
  "stack": "java",
  "project": "demo",
  "root": "/abs/path/to/project",
  "extractedAt": "2026-06-11T00:00:00Z",
  "nodes": [
    {
      "id": "java:com.acme.OrderService",
      "label": "Service",
      "fqn": "com.acme.OrderService",
      "name": "OrderService",
      "filePath": "src/main/java/com/acme/OrderService.java",
      "startLine": 12,
      "endLine": 80,
      "hash": "sha256hex",
      "props": { "fields": ["repo:OrderRepository"] }
    }
  ],
  "edges": [
    { "source": "java:com.acme.OrderController#list()", "target": "java:com.acme.OrderService#findAll()", "type": "CALLS", "props": { "line": 31 } }
  ],
  "warnings": ["unresolved call at Foo.java:42"]
}
```

Rules:
- `props` keys/values must be Neo4j-storable primitives or arrays of primitives (no nested objects).
- Edges may reference nodes not present in `nodes` **only if** they are in the same document — otherwise drop the edge and add a warning.
- Exit code 0 with valid JSON even when the project has parse errors in some files (collect into `warnings`); non-zero only for fatal errors (bad args, unreadable root).

---

## 3. Cross-stack linker (backend)

Input: all `ApiCall` nodes and all `Endpoint` nodes of one project.

- **Tier 1 — exact:** `httpMethod` equal AND `normalizedPath` equal → confidence 1.0.
- **Tier 2 — pattern:** verb equal, same segment count, each segment equal OR either side is a
  param/wildcard. Score = matchedLiteralSegments / totalSegments, accept ≥ 0.5. Confidence 0.5–0.9.
- **Tier 3 — llm:** unresolved ApiCalls (+ their surrounding method source) sent to the LLM with the
  candidate endpoint list; only runs when LLM credentials are configured. Confidence as returned, capped 0.85.

Normalization (applies to both sides): strip protocol/host/env base (`environment.apiUrl`, `${baseUrl}`
prefixes), collapse duplicate `/`, strip trailing `/`, lowercase literal segments,
`{anything}` / `:param` / `${expr}` → `{*}`, strip query strings.

---

## 4. Backend HTTP API (FastAPI, default port 3015, prefix `/api`; UI served on 3014 with `/api` proxied)

All endpoints accept/return JSON. Graph payload shape used everywhere:
`{ "nodes": [ { id, label, name, fqn, stack, project, filePath, startLine, endLine, ...props } ], "edges": [ { id, source, target, type, props } ] }`

| Method & path                       | Purpose / params |
|-------------------------------------|------------------|
| `GET  /api/health`                  | `{status, neo4j: bool, llm: bool}` |
| `POST /api/ingest`                  | body `{project, javaPath?, angularPath?, link?: true}` → starts background job, returns `{jobId}` |
| `GET  /api/jobs/{jobId}`            | `{jobId, status: queued|running|done|error, steps: [{name,status,detail}], stats?}` |
| `GET  /api/projects`                | `[{name, nodeCounts: {Label: n}, edgeCounts: {TYPE: n}, lastIngestedAt}]` |
| `DELETE /api/projects/{name}`       | remove project subgraph |
| `GET  /api/graph/overview`          | `?project=` → counts by label & edge type, cross-stack link stats |
| `GET  /api/graph/subgraph`          | `?project=&nodeId=&depth=1..4&labels=&edgeTypes=&limit=&view=` → graph payload (neighborhood). Without `nodeId`: top-level architecture view. `view` preset (overrides labels/edgeTypes): `logical` \| `development` \| `physical` \| `process` \| `scenarios` — the 4+1 views |
| `POST /api/scenarios`               | `{project}` → job: build Route→…→Table traces, LLM-name them, store Scenario nodes + COVERS edges |
| `GET  /api/scenarios`               | `?project=` → `[{id, title, summary, routePath, steps, covers: {label: [name]}}]` |
| `GET  /api/nodes/{id}`              | node + grouped neighbors `{node, neighbors: [{relType, direction, node}]}` (id URL-encoded) |
| `GET  /api/search`                  | `?q=&project=&labels=&limit=` → `[node]` (fulltext over name/fqn/filePath + summary if enriched) |
| `GET  /api/impact/{id}`             | `?direction=upstream|downstream|both&depth=1..6` → graph payload of transitively affected nodes, each node also carries `distance` |
| `GET  /api/links`                   | `?project=&minConfidence=` → `[{apiCall, endpoint, confidence, tier}]` cross-stack table |
| `POST /api/links/relink`            | re-run linker `{project}` → stats |
| `POST /api/enrich`                  | `{project, scope: nodes|communities|all}` → job. 409 `{detail}` if LLM not configured |
| `POST /api/ask`                     | `{project, question, history?: [{role, content}]}` → `{answer (markdown), steps: [{tool, input, resultPreview}], nodes: [{id, name, label}]}` — agentic GraphRAG Q&A (LLM explores graph + source via tools) |
| `POST /api/cypher`                  | `{query, params}` — read-only (rejects mutation keywords) → `{columns, rows}` |

Errors: FastAPI default `{detail: "..."}` with proper status codes.

---

## 5. Configuration (backend `.env`)

```
NEO4J_URI=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=code2graph

# LLM access — vertex (service account) | anthropic (api key) | "" (disabled)
LLM_PROVIDER=vertex
LLM_MODEL=claude-opus-4-6
VERTEX_SERVICE_ACCOUNT=/home/ubuntu/code2graph/llmaccess/service-account.json
VERTEX_PROJECT_ID=818763934039
VERTEX_REGION=global
ANTHROPIC_API_KEY=            # only when LLM_PROVIDER=anthropic

JAVA_EXTRACTOR_JAR=/home/ubuntu/code2graph/extractors/java-extractor/target/java-extractor.jar
ANGULAR_EXTRACTOR=/home/ubuntu/code2graph/extractors/angular-extractor/dist/index.js
```
