import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import db
from .api import router

logging.basicConfig(level=logging.INFO)


@asynccontextmanager
async def lifespan(app: FastAPI):
    if db.ping():
        db.ensure_schema()
    else:
        logging.getLogger(__name__).warning(
            "neo4j unreachable at startup — endpoints will fail until it is up"
        )
    yield
    db.close_driver()


app = FastAPI(title="code2graph", version="0.1.0", lifespan=lifespan)

# The UI is served same-origin via the Vite proxy; permissive CORS just keeps
# direct-origin access (ip:3014 -> ip:3015) working too.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router)
