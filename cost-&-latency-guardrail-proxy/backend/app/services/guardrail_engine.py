from dataclasses import dataclass
from typing import Dict, List, Optional
import time

from app.database.repository import ProxyRepository


@dataclass
class GuardrailDecision:
    allowed: bool
    status_code: int = 200
    error_code: str = ""
    error_type: str = ""
    message: str = ""
    retry_after: Optional[int] = None


class GuardrailEngine:
    def __init__(self):
        self._client_windows: Dict[str, List[float]] = {}

    def evaluate(
        self,
        repo: ProxyRepository,
        client_id: str,
        messages: List[Dict[str, str]],
        requested_max_tokens: Optional[int],
    ) -> GuardrailDecision:
        cfg = repo.get_guardrail_config()

        combined = " ".join(m.get("content", "") for m in messages)
        est_input_tokens = max(1, len(combined.strip()) // 4)
        eff_max_tokens = requested_max_tokens or 512

        if est_input_tokens > cfg.max_tokens:
            return GuardrailDecision(
                allowed=False,
                status_code=400,
                error_code="max_input_tokens_exceeded",
                error_type="invalid_request_error",
                message=f"Estimated input tokens ({est_input_tokens}) exceed limit ({cfg.max_tokens}).",
            )

        if eff_max_tokens > cfg.max_tokens:
            return GuardrailDecision(
                allowed=False,
                status_code=400,
                error_code="max_tokens_exceeded",
                error_type="invalid_request_error",
                message=f"Requested max_tokens ({eff_max_tokens}) exceed limit ({cfg.max_tokens}).",
            )

        now = time.time()
        window_start = now - 60.0
        timestamps = [ts for ts in self._client_windows.get(client_id, []) if ts > window_start]
        if len(timestamps) >= cfg.requests_per_minute:
            retry_after = max(1, int(timestamps[0] + 60.0 - now) + 1)
            self._client_windows[client_id] = timestamps
            return GuardrailDecision(
                allowed=False,
                status_code=429,
                error_code="rate_limit_exceeded",
                error_type="rate_limit_error",
                message=f"Rate limit exceeded for client '{client_id}' ({cfg.requests_per_minute} RPM).",
                retry_after=retry_after,
            )
        timestamps.append(now)
        self._client_windows[client_id] = timestamps

        daily_spend, monthly_spend = repo.get_spend_totals()
        if daily_spend >= cfg.daily_budget:
            return GuardrailDecision(
                allowed=False,
                status_code=429,
                error_code="daily_budget_exceeded",
                error_type="insufficient_quota",
                message=f"Daily budget reached (${daily_spend:.4f} / ${cfg.daily_budget:.2f}).",
            )

        if monthly_spend >= cfg.monthly_budget:
            return GuardrailDecision(
                allowed=False,
                status_code=429,
                error_code="monthly_budget_exceeded",
                error_type="insufficient_quota",
                message=f"Monthly budget reached (${monthly_spend:.4f} / ${cfg.monthly_budget:.2f}).",
            )

        return GuardrailDecision(allowed=True)

    def current_rpm(self) -> int:
        window_start = time.time() - 60.0
        total = 0
        for cid, items in list(self._client_windows.items()):
            active = [ts for ts in items if ts > window_start]
            if not active:
                del self._client_windows[cid]
            else:
                self._client_windows[cid] = active
                total += len(active)
        return total
