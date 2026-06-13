# java-extractor

Deterministic Spring Boot source extractor (no LLM). Parses Java with JavaParser + symbol solver
(Java 21 language level, no compilation needed) and emits graph JSON per `docs/CONTRACTS.md`.

Extracts: controllers/endpoints (verb + path templates, request/response DTOs), services and
DI wiring, JPA entities → tables + relations, Spring Data repositories (managed entity,
read/write access), resolved method call graph, imports, type hierarchy.

## Build

```bash
mvn -q package          # -> target/java-extractor.jar (fat jar)
```

## Run

```bash
java -jar target/java-extractor.jar \
  --src /path/to/spring-project \      # repo root; all src/main/java roots are discovered
  --project myproject \
  --out graph.json
```

Always exits 0 with valid JSON when the source tree is readable; per-file parse and resolution
failures are collected into the `warnings` array.
