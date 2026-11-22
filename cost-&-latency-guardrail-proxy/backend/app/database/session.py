from typing import Generator
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import DEFAULT_MODEL_PRICING, get_settings
from app.database.models import Base, GuardrailConfig, ProviderConfig

settings = get_settings()

connect_args = (
    {"check_same_thread": False} if settings.database_url.startswith("sqlite") else {}
)
engine = create_engine(settings.database_url, connect_args=connect_args, pool_pre_ping=True)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


def init_db() -> None:
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        if not db.query(GuardrailConfig).filter(GuardrailConfig.id == 1).first():
            db.add(
                GuardrailConfig(
                    id=1,
                    daily_budget=settings.default_daily_budget_usd,
                    monthly_budget=settings.default_monthly_budget_usd,
                    requests_per_minute=settings.default_requests_per_minute,
                    max_tokens=settings.default_max_tokens,
                    similarity_threshold=settings.semantic_similarity_threshold,
                    cache_ttl_seconds=settings.cache_ttl_seconds,
                    fallback_enabled=settings.fallback_enabled,
                    request_timeout_ms=settings.request_timeout_ms,
                    max_retries=settings.max_retries,
                )
            )
            db.commit()

        if db.query(ProviderConfig).count() == 0:
            priorities = {
                "gpt-4o": 1,
                "gpt-4o-mini": 2,
                "gemini-2.5-flash": 3,
                "gpt-4.1-mini": 4,
                "claude-3-5-sonnet": 5,
            }
            for pricing in DEFAULT_MODEL_PRICING.values():
                db.add(
                    ProviderConfig(
                        provider_name=pricing.provider,
                        model_name=pricing.model,
                        enabled=True,
                        priority=priorities.get(pricing.model, 10),
                        input_price_per_1m=pricing.input_price_per_1m,
                        output_price_per_1m=pricing.output_price_per_1m,
                        max_tokens_limit=pricing.max_tokens_limit,
                    )
                )
            db.commit()
    finally:
        db.close()


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
