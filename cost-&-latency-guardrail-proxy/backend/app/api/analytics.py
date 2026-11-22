from fastapi import APIRouter, Depends, Query
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.database.models import APIRequest, UsageStatistics
from app.database.repository import ProxyRepository
from app.database.session import get_db

router = APIRouter(prefix="/api/v1/analytics", tags=["analytics"])


def _percentile(sorted_vals: list[float], pct: float) -> float:
    if not sorted_vals:
        return 0.0
    idx = max(0, min(len(sorted_vals) - 1, int((pct / 100.0) * len(sorted_vals) + 0.999) - 1))
    return round(sorted_vals[idx], 2)


@router.get("/overview")
def analytics_overview(db: Session = Depends(get_db)):
    total = db.query(func.count(APIRequest.id)).scalar() or 0
    hits = db.query(func.count(APIRequest.id)).filter(APIRequest.cache_hit.is_(True)).scalar() or 0
    exact_hits = (
        db.query(func.count(APIRequest.id)).filter(APIRequest.cache_type == "EXACT").scalar() or 0
    )
    semantic_hits = (
        db.query(func.count(APIRequest.id)).filter(APIRequest.cache_type == "SEMANTIC").scalar() or 0
    )
    success_count = (
        db.query(func.count(APIRequest.id)).filter(APIRequest.status == "success").scalar() or 0
    )
    failed_count = total - success_count
    fallback_count = (
        db.query(func.count(APIRequest.id)).filter(APIRequest.fallback_used.is_(True)).scalar() or 0
    )

    total_tokens = db.query(func.coalesce(func.sum(APIRequest.total_tokens), 0)).scalar() or 0
    in_tokens = db.query(func.coalesce(func.sum(APIRequest.input_tokens), 0)).scalar() or 0
    out_tokens = db.query(func.coalesce(func.sum(APIRequest.output_tokens), 0)).scalar() or 0
    total_cost = db.query(func.coalesce(func.sum(APIRequest.estimated_cost), 0.0)).scalar() or 0.0
    total_savings = (
        db.query(func.coalesce(func.sum(APIRequest.estimated_savings), 0.0)).scalar() or 0.0
    )
    avg_latency = db.query(func.coalesce(func.avg(APIRequest.latency_ms), 0.0)).scalar() or 0.0

    latencies = [
        r[0] for r in db.query(APIRequest.latency_ms).order_by(APIRequest.latency_ms.asc()).all()
    ]

    return {
        "totalRequests": int(total),
        "successfulRequests": int(success_count),
        "failedRequests": int(failed_count),
        "cacheHits": int(hits),
        "exactHits": int(exact_hits),
        "semanticHits": int(semantic_hits),
        "cacheHitRatio": round(hits / total, 4) if total > 0 else 0.0,
        "totalTokens": int(total_tokens),
        "inputTokens": int(in_tokens),
        "outputTokens": int(out_tokens),
        "estimatedCostUsd": round(float(total_cost), 6),
        "estimatedSavingsUsd": round(float(total_savings), 6),
        "avgLatencyMs": round(float(avg_latency), 2),
        "p50LatencyMs": _percentile(latencies, 50),
        "p95LatencyMs": _percentile(latencies, 95),
        "fallbackCount": int(fallback_count),
    }


@router.get("/requests")
def analytics_requests(
    limit: int = Query(default=100, ge=1, le=500),
    db: Session = Depends(get_db),
):
    rows = db.query(APIRequest).order_by(APIRequest.id.desc()).limit(limit).all()
    return {
        "requests": [
            {
                "id": r.id,
                "request_id": r.request_id,
                "client_id": r.client_id,
                "model": r.model,
                "requested_model": r.requested_model,
                "status": r.status,
                "status_code": r.status_code,
                "input_tokens": r.input_tokens,
                "output_tokens": r.output_tokens,
                "total_tokens": r.total_tokens,
                "estimated_cost": r.estimated_cost,
                "estimated_savings": r.estimated_savings,
                "latency_ms": r.latency_ms,
                "cache_lookup_ms": r.cache_lookup_ms,
                "cache_hit": r.cache_hit,
                "cache_type": r.cache_type,
                "similarity_score": r.similarity_score,
                "provider": r.provider,
                "fallback_used": r.fallback_used,
                "created_at": r.created_at.isoformat() if r.created_at else None,
            }
            for r in rows
        ]
    }


@router.get("/costs")
def analytics_costs(db: Session = Depends(get_db)):
    repo = ProxyRepository(db)
    daily_spend, monthly_spend = repo.get_spend_totals()
    rows = (
        db.query(
            APIRequest.model,
            func.count(APIRequest.id),
            func.coalesce(func.sum(APIRequest.input_tokens), 0),
            func.coalesce(func.sum(APIRequest.output_tokens), 0),
            func.coalesce(func.sum(APIRequest.estimated_cost), 0.0),
            func.coalesce(func.sum(APIRequest.estimated_savings), 0.0),
        )
        .group_by(APIRequest.model)
        .all()
    )
    daily_series = (
        db.query(
            UsageStatistics.date,
            func.coalesce(func.sum(UsageStatistics.total_requests), 0),
            func.coalesce(func.sum(UsageStatistics.cache_hits), 0),
            func.coalesce(func.sum(UsageStatistics.total_tokens), 0),
            func.coalesce(func.sum(UsageStatistics.total_cost), 0.0),
            func.coalesce(func.sum(UsageStatistics.total_savings), 0.0),
        )
        .group_by(UsageStatistics.date)
        .order_by(UsageStatistics.date.asc())
        .all()
    )
    return {
        "dailySpendUsd": round(daily_spend, 6),
        "monthlySpendUsd": round(monthly_spend, 6),
        "byModel": [
            {
                "model": m,
                "requests": int(cnt),
                "inputTokens": int(in_t),
                "outputTokens": int(out_t),
                "estimatedCostUsd": round(float(c), 6),
                "estimatedSavingsUsd": round(float(s), 6),
            }
            for m, cnt, in_t, out_t, c, s in rows
        ],
        "dailySeries": [
            {
                "date": d,
                "requests": int(r),
                "cache_hits": int(h),
                "tokens": int(t),
                "cost_usd": round(float(c), 6),
                "savings_usd": round(float(s), 6),
            }
            for d, r, h, t, c, s in daily_series
        ],
    }


@router.get("/tokens")
def analytics_tokens(db: Session = Depends(get_db)):
    rows = (
        db.query(
            APIRequest.model,
            func.coalesce(func.sum(APIRequest.input_tokens), 0),
            func.coalesce(func.sum(APIRequest.output_tokens), 0),
            func.coalesce(func.sum(APIRequest.total_tokens), 0),
        )
        .group_by(APIRequest.model)
        .all()
    )
    return {
        "byModel": [
            {
                "model": m,
                "input_tokens": int(i),
                "output_tokens": int(o),
                "total_tokens": int(t),
            }
            for m, i, o, t in rows
        ]
    }
