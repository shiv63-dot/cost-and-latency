from functools import lru_cache
from typing import Dict
from pydantic import BaseModel
from pydantic_settings import BaseSettings, SettingsConfigDict


class ModelPricing(BaseModel):
    provider: str
    model: str
    input_price_per_1m: float
    output_price_per_1m: float
    max_tokens_limit: int


DEFAULT_MODEL_PRICING: Dict[str, ModelPricing] = {
    "gpt-4o": ModelPricing(
        provider="openai",
        model="gpt-4o",
        input_price_per_1m=2.50,
        output_price_per_1m=10.00,
        max_tokens_limit=128000,
    ),
    "gpt-4o-mini": ModelPricing(
        provider="openai",
        model="gpt-4o-mini",
        input_price_per_1m=0.15,
        output_price_per_1m=0.60,
        max_tokens_limit=128000,
    ),
    "gpt-4.1-mini": ModelPricing(
        provider="openai",
        model="gpt-4.1-mini",
        input_price_per_1m=0.40,
        output_price_per_1m=1.60,
        max_tokens_limit=128000,
    ),
    "gemini-2.5-flash": ModelPricing(
        provider="google",
        model="gemini-2.5-flash",
        input_price_per_1m=0.15,
        output_price_per_1m=0.60,
        max_tokens_limit=1000000,
    ),
    "claude-3-5-sonnet": ModelPricing(
        provider="anthropic-compat",
        model="claude-3-5-sonnet",
        input_price_per_1m=3.00,
        output_price_per_1m=15.00,
        max_tokens_limit=200000,
    ),
}


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_name: str = "Cost & Latency Guardrail Proxy"
    environment: str = "development"

    openai_api_key: str = ""
    openai_base_url: str = "https://api.openai.com/v1"
    mock_provider_mode: bool = True

    primary_model: str = "gpt-4o"
    fallback_model: str = "gpt-4o-mini"
    fallback_enabled: bool = True
    request_timeout_ms: int = 15000
    max_retries: int = 2

    admin_passcode: str = ""
    proxy_client_api_key: str = ""

    redis_url: str = "redis://localhost:6379/0"
    semantic_similarity_threshold: float = 0.84
    cache_ttl_seconds: int = 3600
    embedding_model_name: str = "all-MiniLM-L6-v2"

    database_url: str = "sqlite:///./proxy_metrics.db"

    default_daily_budget_usd: float = 25.0
    default_monthly_budget_usd: float = 500.0
    default_requests_per_minute: int = 60
    default_max_tokens: int = 4096

    log_prompts: bool = False


@lru_cache
def get_settings() -> Settings:
    return Settings()
