from datetime import datetime, timezone
from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.database.repository import ProxyRepository
from app.database.session import get_db
from app.middleware.authentication import require_admin_auth
from app.schemas.proxy import GuardrailConfigUpdate

router = APIRouter(prefix="/api/v1", tags=["guardrails"])


@router.get("/guardrails/status")
def guardrails_status(request: Request, db: Session = Depends(get_db)):
    repo = ProxyRepository(db)
    cfg = repo.get_guardrail_config()
    daily_spend, monthly_spend = repo.get_spend_totals()
    rpm = request.app.state.guardrails.current_rpm()

    return {
        "config": {
            "daily_budget": cfg.daily_budget,
            "monthly_budget": cfg.monthly_budget,
            "requests_per_minute": cfg.requests_per_minute,
            "max_tokens": cfg.max_tokens,
            "similarity_threshold": cfg.similarity_threshold,
            "cache_ttl_seconds": cfg.cache_ttl_seconds,
            "fallback_enabled": cfg.fallback_enabled,
            "request_timeout_ms": cfg.request_timeout_ms,
            "max_retries": cfg.max_retries,
        },
        "utilization": {
            "dailySpendUsd": round(daily_spend, 6),
            "dailyBudgetUsd": cfg.daily_budget,
            "dailyUtilizationPct": round(min(100.0, (daily_spend / cfg.daily_budget) * 100), 2)
            if cfg.daily_budget > 0
            else 0.0,
            "monthlySpendUsd": round(monthly_spend, 6),
            "monthlyBudgetUsd": cfg.monthly_budget,
            "monthlyUtilizationPct": round(min(100.0, (monthly_spend / cfg.monthly_budget) * 100), 2)
            if cfg.monthly_budget > 0
            else 0.0,
            "currentRpm": rpm,
            "rpmLimit": cfg.requests_per_minute,
            "rpmUtilizationPct": round(min(100.0, (rpm / cfg.requests_per_minute) * 100), 2)
            if cfg.requests_per_minute > 0
            else 0.0,
        },
    }


@router.post("/guardrails/config", dependencies=[Depends(require_admin_auth)])
def update_guardrails_config(
    payload: GuardrailConfigUpdate,
    request: Request,
    db: Session = Depends(get_db),
):
    repo = ProxyRepository(db)
    cfg = repo.get_guardrail_config()
    for field, value in payload.model_dump(exclude_none=True).items():
        setattr(cfg, field, value)
    cfg.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(cfg)
    return guardrails_status(request, db)


@router.get("/providers")
def list_providers(db: Session = Depends(get_db)):
    settings = get_settings()
    providers = ProxyRepository(db).get_providers()
    return {
        "primaryModel": settings.primary_model,
        "fallbackModel": settings.fallback_model,
        "providerMode": "mock-local" if settings.mock_provider_mode else "live-upstream",
        "providers": [
            {
                "id": p.id,
                "provider_name": p.provider_name,
                "model_name": p.model_name,
                "enabled": p.enabled,
                "priority": p.priority,
                "input_price_per_1m": p.input_price_per_1m,
                "output_price_per_1m": p.output_price_per_1m,
                "max_tokens_limit": p.max_tokens_limit,
            }
            for p in providers
        ],
    }
