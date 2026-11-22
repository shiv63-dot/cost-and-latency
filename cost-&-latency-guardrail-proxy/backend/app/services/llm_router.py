import asyncio
from dataclasses import dataclass
from typing import Dict, List, Optional
import httpx

from app.core.config import Settings
from app.core.security import is_safe_external_url
from app.database.repository import ProxyRepository


@dataclass
class RouteOutcome:
    content: str
    model_used: str
    provider_used: str
    input_tokens: int
    output_tokens: int
    fallback_used: bool
    attempts: int


class LLMRouterService:
    def __init__(self, settings: Settings):
        self.settings = settings

    async def _invoke_model(
        self,
        repo: ProxyRepository,
        model: str,
        messages: List[Dict[str, str]],
        temperature: float,
        max_tokens: Optional[int],
        timeout_ms: int,
        simulate_failure: bool = False,
        simulate_timeout: bool = False,
    ) -> tuple[str, str, int, int]:
        if simulate_timeout:
            await asyncio.sleep(min(timeout_ms / 1000.0 + 0.05, 0.35))
            raise TimeoutError(f"Provider request timed out after {timeout_ms}ms")

        if simulate_failure:
            raise RuntimeError(f"Simulated upstream 503 failure for {model}")

        provider_row = repo.get_provider_by_model(model)
        if provider_row and not provider_row.enabled:
            raise RuntimeError(f"Model {model} is disabled in provider config")

        if not self.settings.mock_provider_mode and self.settings.openai_api_key:
            base_url = self.settings.openai_base_url.rstrip("/")
            if not is_safe_external_url(base_url):
                raise RuntimeError("Blocked unsafe OPENAI_BASE_URL destination")
            async with httpx.AsyncClient(timeout=timeout_ms / 1000.0) as client:
                resp = await client.post(
                    f"{base_url}/chat/completions",
                    headers={
                        "Authorization": f"Bearer {self.settings.openai_api_key}",
                        "Content-Type": "application/json",
                    },
                    json={
                        "model": model,
                        "messages": messages,
                        "temperature": temperature,
                        **({"max_tokens": max_tokens} if max_tokens else {}),
                    },
                )
                resp.raise_for_status()
                data = resp.json()
                content = data["choices"][0]["message"]["content"]
                usage = data.get("usage", {})
                in_tok = int(usage.get("prompt_tokens", 16))
                out_tok = int(usage.get("completion_tokens", max(1, len(content) // 4)))
                return content, (provider_row.provider_name if provider_row else "openai"), in_tok, out_tok

        # Deterministic Mock Provider Mode for local development & automated tests
        await asyncio.sleep(0.05)
        user_prompts = [m["content"] for m in messages if m.get("role") == "user"]
        prompt = user_prompts[-1] if user_prompts else ""
        content = (
            f"Mock response from {model}: processed '{prompt[:100]}'. "
            "Configure OPENAI_API_KEY and MOCK_PROVIDER_MODE=false for live upstream routing."
        )
        in_tok = max(4, len(" ".join(m["content"] for m in messages)) // 4)
        out_tok = max(4, len(content) // 4)
        return content, f"mock-{provider_row.provider_name if provider_row else 'openai'}", in_tok, out_tok

    async def route_and_execute(
        self,
        repo: ProxyRepository,
        requested_model: str,
        messages: List[Dict[str, str]],
        temperature: float,
        max_tokens: Optional[int],
        allow_fallback: bool,
        simulate_primary_failure: bool = False,
        simulate_timeout: bool = False,
    ) -> RouteOutcome:
        cfg = repo.get_guardrail_config()
        primary = requested_model or self.settings.primary_model
        fallback = self.settings.fallback_model
        max_retries = max(0, min(5, cfg.max_retries))
        attempts = 0
        last_err: Optional[Exception] = None

        for attempt in range(max_retries + 1):
            attempts += 1
            try:
                content, provider, in_tok, out_tok = await self._invoke_model(
                    repo=repo,
                    model=primary,
                    messages=messages,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    timeout_ms=cfg.request_timeout_ms,
                    simulate_failure=simulate_primary_failure,
                    simulate_timeout=simulate_timeout,
                )
                return RouteOutcome(
                    content=content,
                    model_used=primary,
                    provider_used=provider,
                    input_tokens=in_tok,
                    output_tokens=out_tok,
                    fallback_used=False,
                    attempts=attempts,
                )
            except Exception as exc:
                last_err = exc
                if attempt < max_retries and not simulate_timeout:
                    await asyncio.sleep(0.05 * (attempt + 1))

        if cfg.fallback_enabled and allow_fallback and fallback and fallback != primary:
            attempts += 1
            content, provider, in_tok, out_tok = await self._invoke_model(
                repo=repo,
                model=fallback,
                messages=messages,
                temperature=temperature,
                max_tokens=max_tokens,
                timeout_ms=cfg.request_timeout_ms,
                simulate_failure=False,
                simulate_timeout=False,
            )
            return RouteOutcome(
                content=content,
                model_used=fallback,
                provider_used=provider,
                input_tokens=in_tok,
                output_tokens=out_tok,
                fallback_used=True,
                attempts=attempts,
            )

        raise last_err or RuntimeError("All LLM providers failed")
