from datetime import datetime, timezone
from sqlalchemy import Boolean, Column, DateTime, Float, Index, Integer, String, Text
from sqlalchemy.orm import declarative_base

Base = declarative_base()


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class APIRequest(Base):
    __tablename__ = "api_requests"

    id = Column(Integer, primary_key=True, index=True)
    request_id = Column(String(64), unique=True, nullable=False, index=True)
    client_id = Column(String(64), nullable=False, index=True)
    model = Column(String(64), nullable=False, index=True)
    requested_model = Column(String(64), nullable=False)
    status = Column(String(32), nullable=False)
    status_code = Column(Integer, nullable=False, default=200)
    input_tokens = Column(Integer, nullable=False, default=0)
    output_tokens = Column(Integer, nullable=False, default=0)
    total_tokens = Column(Integer, nullable=False, default=0)
    estimated_cost = Column(Float, nullable=False, default=0.0)
    estimated_savings = Column(Float, nullable=False, default=0.0)
    latency_ms = Column(Float, nullable=False, default=0.0)
    cache_lookup_ms = Column(Float, nullable=False, default=0.0)
    cache_hit = Column(Boolean, nullable=False, default=False, index=True)
    cache_type = Column(String(16), nullable=False, default="NONE")
    similarity_score = Column(Float, nullable=True)
    provider = Column(String(64), nullable=False)
    fallback_used = Column(Boolean, nullable=False, default=False)
    error_message = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, default=utcnow, index=True)


class UsageStatistics(Base):
    __tablename__ = "usage_statistics"

    id = Column(Integer, primary_key=True, index=True)
    client_id = Column(String(64), nullable=False, index=True)
    date = Column(String(10), nullable=False, index=True)
    total_requests = Column(Integer, nullable=False, default=0)
    cache_hits = Column(Integer, nullable=False, default=0)
    total_tokens = Column(Integer, nullable=False, default=0)
    total_cost = Column(Float, nullable=False, default=0.0)
    total_savings = Column(Float, nullable=False, default=0.0)

    __table_args__ = (
        Index("idx_usage_client_date", "client_id", "date", unique=True),
    )


class GuardrailConfig(Base):
    __tablename__ = "guardrail_config"

    id = Column(Integer, primary_key=True)
    daily_budget = Column(Float, nullable=False, default=25.0)
    monthly_budget = Column(Float, nullable=False, default=500.0)
    requests_per_minute = Column(Integer, nullable=False, default=60)
    max_tokens = Column(Integer, nullable=False, default=4096)
    similarity_threshold = Column(Float, nullable=False, default=0.84)
    cache_ttl_seconds = Column(Integer, nullable=False, default=3600)
    fallback_enabled = Column(Boolean, nullable=False, default=True)
    request_timeout_ms = Column(Integer, nullable=False, default=15000)
    max_retries = Column(Integer, nullable=False, default=2)
    updated_at = Column(DateTime(timezone=True), nullable=False, default=utcnow)


class ProviderConfig(Base):
    __tablename__ = "provider_config"

    id = Column(Integer, primary_key=True, index=True)
    provider_name = Column(String(64), nullable=False)
    model_name = Column(String(64), unique=True, nullable=False)
    enabled = Column(Boolean, nullable=False, default=True)
    priority = Column(Integer, nullable=False, default=10)
    input_price_per_1m = Column(Float, nullable=False)
    output_price_per_1m = Column(Float, nullable=False)
    max_tokens_limit = Column(Integer, nullable=False, default=128000)
