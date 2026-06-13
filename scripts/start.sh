#!/usr/bin/env bash
# Start backend (:3015) and frontend (:3014). Neo4j must already be running.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

cd "$ROOT/backend"
[ -d .venv ] || { python3 -m venv .venv && .venv/bin/pip install -r requirements.txt; }
[ -f .env ] || cp .env.example .env
nohup .venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 3015 > /tmp/code2graph-backend.log 2>&1 &
echo "backend  -> http://0.0.0.0:3015  (log: /tmp/code2graph-backend.log)"

cd "$ROOT/frontend"
[ -d node_modules ] || npm install
npm run build > /dev/null
nohup npm run preview -- --host 0.0.0.0 --port 3014 > /tmp/code2graph-frontend.log 2>&1 &
echo "frontend -> http://0.0.0.0:3014  (log: /tmp/code2graph-frontend.log)"
