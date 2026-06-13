#!/usr/bin/env bash
pkill -f "uvicorn app.main:app" 2>/dev/null && echo "backend stopped"
pkill -f "vite preview" 2>/dev/null && echo "frontend stopped"
exit 0
