from contextlib import asynccontextmanager
from fastapi import FastAPI, Response
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest
import redis

from app.api import analytics, cache, chat, guardrails, health
from app.core.config import get_settings
from app.core.logging import configure_logging
from app.database.session import init_db
from app.middleware.request_tracking import RequestTrackingMiddleware
from app.services.embedding_service import EmbeddingService
from app.services.guardrail_engine import GuardrailEngine
from app.services.llm_router import LLMRouterService
from app.services.semantic_cache import SemanticCacheService


def create_app(
    redis_client: redis.Redis | None = None,
    enable_transformer: bool = True,
) -> FastAPI:
    settings = get_settings()
    configure_logging()

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        init_db()
        yield

    app = FastAPI(
        title=settings.app_name,
        version="1.0.0",
        description="Intelligent AI Infrastructure Optimization Gateway",
        lifespan=lifespan,
    )

    if redis_client is None:
        try:
            redis_client = redis.Redis.from_url(settings.redis_url, decode_responses=False)
        except Exception:
            redis_client = None

    embedder = EmbeddingService(
        model_name=settings.embedding_model_name,
        enable_transformer=enable_transformer,
    )
    app.state.cache = SemanticCacheService(redis_client=redis_client, embedder=embedder)
    app.state.guardrails = GuardrailEngine()
    app.state.llm_router = LLMRouterService(settings=settings)

    app.add_middleware(RequestTrackingMiddleware)

    app.include_router(chat.router)
    app.include_router(analytics.router)
    app.include_router(cache.router)
    app.include_router(guardrails.router)
    app.include_router(health.router)

    @app.get("/metrics")
    def prometheus_metrics():
        return Response(content=generate_latest(), media_type=CONTENT_TYPE_LATEST)

    return app


app = create_app()
