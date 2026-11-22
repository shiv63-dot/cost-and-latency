import time
import uuid
from fastapi import APIRouter, Depends, Header, Request
from fastapi.responses import JSONResponse
from prometheus_client import Counter, Histogram
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.database.models import APIRequest
from app.database.repository import ProxyRepository
from app.database.session import get_db
from app.middleware.authentication import authenticate_client_key
from app.schemas.proxy import ChatCompletionRequest
from app.services.cost_tracker import CostTrackerService

router = APIRouter(prefix="/api/v1/chat", tags=["chat"])

PROM_REQUESTS = Counter(
    "proxy_requests_total",
    "Total API requests handled by the gateway",
    ["model", "status", "cache_status"],
)
PROM_CACHE_HITS = Counter("proxy_cache_hits_total", "Cache hits by tier", ["cache_type"])
PROM_CACHE_MISSES = Counter("proxy_cache_misses_total", "Total cache misses")
PROM_TOKENS = Counter("proxy_tokens_total", "Total tokens processed", ["type"])
PROM_COST = Counter("proxy_estimated_cost_usd_total", "Estimated upstream API cost in USD")
PROM_SAVINGS = Counter("proxy_estimated_savings_usd_total", "Estimated cache savings in USD")
PROM_ERRORS = Counter("proxy_provider_errors_total", "Upstream provider errors")
PROM_FALLBACKS = Counter("proxy_fallback_used_total", "Requests routed to fallback model")
PROM_LATENCY = Histogram(
    "proxy_request_latency_ms",
    "Request latency in milliseconds",
    buckets=(5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000),
)


@router.post("/completions")
async def create_chat_completion(
    payload: ChatCompletionRequest,
    request: Request,
    client_id: str = Depends(authenticate_client_key),
    db: Session = Depends(get_db),
    x_bypass_cache: str | None = Header(default=None),
    x_simulate_primary_failure: str | None = Header(default=None),
    x_simulate_timeout: str | None = Header(default=None),
):
    started = time.perf_counter()
    req_id = getattr(request.state, "request_id", None) or f"req_{uuid.uuid4().hex[:16]}"
    repo = ProxyRepository(db)
    cost_tracker = CostTrackerService(repo)
    guardrails = request.app.state.guardrails
    cache = request.app.state.cache
    llm_router = request.app.state.llm_router
    settings = get_settings()

    messages_dicts = [{"role": m.role, "content": m.content} for m in payload.messages]

    # 1. Evaluate Guardrails (Token limits, RPM rate limit, Daily/Monthly budget)
    decision = guardrails.evaluate(
        repo=repo,
        client_id=client_id,
        messages=messages_dicts,
        requested_max_tokens=payload.max_tokens,
    )
    if not decision.allowed:
        latency_ms = round((time.perf_counter() - started) * 1000, 2)
        repo.record_request(
            APIRequest(
                request_id=req_id,
                client_id=client_id,
                model=payload.model,
                requested_model=payload.model,
                status="rejected",
                status_code=decision.status_code,
                provider="guardrail-engine",
                latency_ms=latency_ms,
                error_message=decision.message,
            )
        )
        PROM_REQUESTS.labels(model=payload.model, status="rejected", cache_status="miss").inc()
        PROM_LATENCY.observe(latency_ms)
        headers = {"X-Request-ID": req_id, "X-Cache-Status": "BYPASS"}
        if decision.retry_after:
            headers["Retry-After"] = str(decision.retry_after)
        return JSONResponse(
            status_code=decision.status_code,
            headers=headers,
            content={
                "error": {
                    "message": decision.message,
                    "type": decision.error_type,
                    "code": decision.error_code,
                }
            },
        )

    cfg = repo.get_guardrail_config()
    bypass = (x_bypass_cache or "").lower() == "true"

    # 2. Semantic & Exact Cache Lookup
    cache_outcome = (
        None
        if bypass
        else cache.lookup(
            model=payload.model,
            messages=messages_dicts,
            temperature=payload.temperature,
            max_tokens=payload.max_tokens,
            client_scope=client_id,
            similarity_threshold=cfg.similarity_threshold,
        )
    )

    if cache_outcome and cache_outcome.hit and cache_outcome.payload:
        latency_ms = round((time.perf_counter() - started) * 1000, 2)
        cached = cache_outcome.payload
        in_tok = int(cached.get("input_tokens", 0))
        out_tok = int(cached.get("output_tokens", 0))
        cached_model = str(cached.get("model", payload.model))
        saved_usd = cost_tracker.calculate_estimated_cost(cached_model, in_tok, out_tok)

        repo.record_request(
            APIRequest(
                request_id=req_id,
                client_id=client_id,
                model=cached_model,
                requested_model=payload.model,
                status="success",
                status_code=200,
                input_tokens=in_tok,
                output_tokens=out_tok,
                total_tokens=in_tok + out_tok,
                estimated_cost=0.0,
                estimated_savings=saved_usd,
                latency_ms=latency_ms,
                cache_lookup_ms=cache_outcome.lookup_ms,
                cache_hit=True,
                cache_type=cache_outcome.cache_type,
                similarity_score=cache_outcome.similarity_score,
                provider="semantic-cache",
                fallback_used=False,
            )
        )

        PROM_REQUESTS.labels(model=cached_model, status="success", cache_status="hit").inc()
        PROM_CACHE_HITS.labels(cache_type=cache_outcome.cache_type).inc()
        PROM_TOKENS.labels(type="input").inc(in_tok)
        PROM_TOKENS.labels(type="output").inc(out_tok)
        PROM_SAVINGS.inc(saved_usd)
        PROM_LATENCY.observe(latency_ms)

        return JSONResponse(
            status_code=200,
            headers={
                "X-Request-ID": req_id,
                "X-Cache-Status": f"HIT_{cache_outcome.cache_type}",
                "X-Cache-Lookup-Ms": str(cache_outcome.lookup_ms),
                "X-Proxy-Model-Used": cached_model,
            },
            content={
                "id": req_id,
                "object": "chat.completion",
                "created": int(time.time()),
                "model": cached_model,
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": cached["content"]},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {
                    "prompt_tokens": in_tok,
                    "completion_tokens": out_tok,
                    "total_tokens": in_tok + out_tok,
                },
                "proxy_metadata": {
                    "request_id": req_id,
                    "cache_hit": True,
                    "cache_type": cache_outcome.cache_type,
                    "similarity_score": cache_outcome.similarity_score,
                    "cache_lookup_ms": cache_outcome.lookup_ms,
                    "total_latency_ms": latency_ms,
                    "estimated_cost_usd": 0.0,
                    "estimated_savings_usd": saved_usd,
                    "fallback_used": False,
                    "provider": "semantic-cache",
                },
            },
        )

    # 3. Cache MISS -> Forward via Intelligent LLM Router
    try:
        route_res = await llm_router.route_and_execute(
            repo=repo,
            requested_model=payload.model,
            messages=messages_dicts,
            temperature=payload.temperature,
            max_tokens=payload.max_tokens,
            allow_fallback=payload.allow_fallback,
            simulate_primary_failure=(x_simulate_primary_failure or "").lower() == "true",
            simulate_timeout=(x_simulate_timeout or "").lower() == "true",
        )

        latency_ms = round((time.perf_counter() - started) * 1000, 2)
        est_cost = cost_tracker.calculate_estimated_cost(
            route_res.model_used, route_res.input_tokens, route_res.output_tokens
        )

        if not bypass and cache_outcome and route_res.model_used == payload.model:
            cache.store(
                exact_hash=cache_outcome.exact_hash,
                settings_hash=cache_outcome.settings_hash,
                prompt_text=cache_outcome.prompt_text,
                embedding=cache_outcome.embedding,
                payload={
                    "content": route_res.content,
                    "model": route_res.model_used,
                    "provider": route_res.provider_used,
                    "input_tokens": route_res.input_tokens,
                    "output_tokens": route_res.output_tokens,
                },
                ttl_seconds=cfg.cache_ttl_seconds or settings.cache_ttl_seconds,
            )

        repo.record_request(
            APIRequest(
                request_id=req_id,
                client_id=client_id,
                model=route_res.model_used,
                requested_model=payload.model,
                status="success",
                status_code=200,
                input_tokens=route_res.input_tokens,
                output_tokens=route_res.output_tokens,
                total_tokens=route_res.input_tokens + route_res.output_tokens,
                estimated_cost=est_cost,
                estimated_savings=0.0,
                latency_ms=latency_ms,
                cache_lookup_ms=cache_outcome.lookup_ms if cache_outcome else 0.0,
                cache_hit=False,
                cache_type="NONE",
                similarity_score=cache_outcome.similarity_score if cache_outcome else None,
                provider=route_res.provider_used,
                fallback_used=route_res.fallback_used,
            )
        )

        PROM_REQUESTS.labels(model=route_res.model_used, status="success", cache_status="miss").inc()
        PROM_CACHE_MISSES.inc()
        PROM_TOKENS.labels(type="input").inc(route_res.input_tokens)
        PROM_TOKENS.labels(type="output").inc(route_res.output_tokens)
        PROM_COST.inc(est_cost)
        if route_res.fallback_used:
            PROM_FALLBACKS.inc()
        PROM_LATENCY.observe(latency_ms)

        return JSONResponse(
            status_code=200,
            headers={
                "X-Request-ID": req_id,
                "X-Cache-Status": "MISS",
                "X-Cache-Lookup-Ms": str(cache_outcome.lookup_ms if cache_outcome else 0.0),
                "X-Proxy-Model-Used": route_res.model_used,
                "X-Fallback-Used": str(route_res.fallback_used).lower(),
            },
            content={
                "id": req_id,
                "object": "chat.completion",
                "created": int(time.time()),
                "model": route_res.model_used,
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": route_res.content},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {
                    "prompt_tokens": route_res.input_tokens,
                    "completion_tokens": route_res.output_tokens,
                    "total_tokens": route_res.input_tokens + route_res.output_tokens,
                },
                "proxy_metadata": {
                    "request_id": req_id,
                    "cache_hit": False,
                    "cache_type": "NONE",
                    "similarity_score": cache_outcome.similarity_score if cache_outcome else None,
                    "cache_lookup_ms": cache_outcome.lookup_ms if cache_outcome else 0.0,
                    "total_latency_ms": latency_ms,
                    "estimated_cost_usd": est_cost,
                    "estimated_savings_usd": 0.0,
                    "fallback_used": route_res.fallback_used,
                    "attempts": route_res.attempts,
                    "provider": route_res.provider_used,
                },
            },
        )
    except Exception as exc:
        latency_ms = round((time.perf_counter() - started) * 1000, 2)
        is_timeout = isinstance(exc, TimeoutError) or "timed out" in str(exc).lower()
        status_code = 504 if is_timeout else 502
        repo.record_request(
            APIRequest(
                request_id=req_id,
                client_id=client_id,
                model=payload.model,
                requested_model=payload.model,
                status="error",
                status_code=status_code,
                latency_ms=latency_ms,
                provider="upstream-error",
                error_message=str(exc)[:240],
            )
        )
        PROM_REQUESTS.labels(model=payload.model, status="error", cache_status="miss").inc()
        PROM_ERRORS.inc()
        PROM_LATENCY.observe(latency_ms)
        return JSONResponse(
            status_code=status_code,
            headers={"X-Request-ID": req_id, "X-Cache-Status": "MISS"},
            content={
                "error": {
                    "message": str(exc),
                    "type": "timeout_error" if is_timeout else "upstream_provider_error",
                    "code": "provider_timeout" if is_timeout else "provider_unavailable",
                }
            },
        )
