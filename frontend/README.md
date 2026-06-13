# code2graph frontend

Dark-themed React + Vite UI for exploring the code2graph knowledge graph
(projects, subgraph explorer, fulltext search, impact analysis, cross-stack API links).

## Stack

- Vite 5 + React 18 (plain JSX, no TypeScript)
- react-router-dom for routing
- cytoscape (core library) for graph rendering, `cose` layout
- Hand-rolled CSS (single global stylesheet, CSS variables)

## Development

```bash
npm install
npm run dev        # http://localhost:5173
```

The dev server proxies **`/api` → `http://localhost:8000`** (see `vite.config.js`),
so start the FastAPI backend on port 8000 first. The UI degrades gracefully
(error boxes / toasts) when the backend is down.

## Build & preview

```bash
npm run build      # outputs dist/
npm run preview    # serves the production build (no /api proxy by default)
```

Note: `vite preview` does not apply the dev proxy automatically — for a
production deployment put the static `dist/` behind the same origin as the
backend, or a reverse proxy that maps `/api` to the FastAPI service.

## Pages

| Route     | Page                                                              |
|-----------|-------------------------------------------------------------------|
| `/`       | Dashboard — project cards, health dots, ingest form + job polling |
| `/graph`  | Graph Explorer — filters, cytoscape canvas, node details drawer (`?focus=<nodeId>` to focus a node) |
| `/search` | Fulltext search with label filter chips                           |
| `/impact` | Impact analysis (`?node=<nodeId>`), graph + per-distance list     |
| `/links`  | Cross-stack ApiCall ⇄ Endpoint table with confidence/tier         |

The active project is shared across pages via React context and persisted in
`localStorage` (`code2graph.project`).
