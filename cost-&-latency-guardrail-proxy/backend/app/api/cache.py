from fastapi import APIRouter, Depends, Request
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.database.models import APIRequest
from app.database.repository import ProxyRepository
from app.database.session import get_db
from app.middleware.authentication import require_admin_auth

router = APIRouter(prefix="/api/v1/cache", tags=["cache"])


@router.get("/stats")
def cache_stats(request: Request, db: Session = Depends(get_db)):
    cache = request.app.state.cache
    cfg = ProxyRepository(db).get_guardrail_config()
    total_hits = db.query(func.count(APIRequest.id)).filter(APIRequest.cache_hit.is_(True)).scalar() or 0
    exact_hits = db.query(func.count(APIRequest.id)).filter(APIRequest.cache_type == "EXACT").scalar() or 0
    semantic_hits = (
        db.query(func.count(APIRequest.id)).filter(APIRequest.cache_type == "SEMANTIC").scalar() or 0
    )
    misses = (
        db.query(func.count(APIRequest.id))
        .filter(APIRequest.cache_hit.is_(False), APIRequest.status == "success")
        .scalar()
        or 0
    )
    denom = total_hits + misses
    return {
        "cachedPromptCount": cache.count_entries(),
        "totalCacheHits": int(total_hits),
        "exactHits": int(exact_hits),
        "semanticHits": int(semantic_hits),
        "totalMisses": int(misses),
        "hitRatio": round(total_hits / denom, 4) if denom > 0 else 0.0,
        "ttlSeconds": cfg.cache_ttl_seconds,
        "similarityThreshold": cfg.similarity_threshold,
        "redisConnected": cache.is_connected(),
    }


@router.delete("/clear", dependencies=[Depends(require_admin_auth)])
def clear_cache(request: Request):
    removed = request.app.state.cache.clear_all()
    return {"cleared": True, "entriesRemoved": removed}
