from datetime import datetime, timezone
from fastapi import APIRouter, Depends, Request
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.database.repository import ProxyRepository
from app.database.session import get_db

router = APIRouter(prefix="/api/v1", tags=["health"])


@router.get("/health")
def health_check(request: Request, db: Session = Depends(get_db)):
    db_ok = False
    try:
        db.execute(text("SELECT 1"))
        db_ok = True
    except Exception:
        db_ok = False

    redis_ok = request.app.state.cache.is_connected()
    return {
        "status": "healthy" if db_ok else "degraded",
        "service": "cost-latency-guardrail-proxy",
        "database": "connected" if db_ok else "disconnected",
        "redis": "connected" if redis_ok else "unavailable",
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


@router.get("/system/status")
def system_status(request: Request, db: Session = Depends(get_db)):
    settings = get_settings()
    db_ok = False
    try:
        db.execute(text("SELECT 1"))
        db_ok = True
    except Exception:
        db_ok = False

    providers = ProxyRepository(db).get_providers()
    enabled = [p for p in providers if p.enabled]
    redis_ok = request.app.state.cache.is_connected()

    return {
        "gateway": {
            "status": "online",
            "runtime": "fastapi-uvicorn",
            "primaryModel": settings.primary_model,
            "fallbackModel": settings.fallback_model,
            "providerMode": "mock-local" if settings.mock_provider_mode else "live-upstream",
        },
        "cache": {
            "engine": "Redis Semantic Vector Cache",
            "status": "connected" if redis_ok else "degraded",
            "cachedEntries": request.app.state.cache.count_entries(),
        },
        "database": {
            "engine": "SQLAlchemy",
            "status": "connected" if db_ok else "error",
        },
        "providers": {
            "configured": len(providers),
            "enabled": len(enabled),
            "status": "ready" if enabled else "unavailable",
        },
        "monitoring": {
            "prometheusEndpoint": "/metrics",
            "status": "available",
        },
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
