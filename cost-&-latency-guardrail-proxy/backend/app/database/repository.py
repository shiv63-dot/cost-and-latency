from datetime import datetime, timezone
from typing import List, Optional
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.database.models import APIRequest, GuardrailConfig, ProviderConfig, UsageStatistics


class ProxyRepository:
    def __init__(self, db: Session):
        self.db = db

    def get_guardrail_config(self) -> GuardrailConfig:
        cfg = self.db.query(GuardrailConfig).filter(GuardrailConfig.id == 1).first()
        if not cfg:
            cfg = GuardrailConfig(id=1)
            self.db.add(cfg)
            self.db.commit()
            self.db.refresh(cfg)
        return cfg

    def get_providers(self) -> List[ProviderConfig]:
        return (
            self.db.query(ProviderConfig)
            .order_by(ProviderConfig.priority.asc(), ProviderConfig.id.asc())
            .all()
        )

    def get_provider_by_model(self, model_name: str) -> Optional[ProviderConfig]:
        return (
            self.db.query(ProviderConfig)
            .filter(ProviderConfig.model_name == model_name)
            .first()
        )

    def record_request(self, request_row: APIRequest) -> None:
        self.db.add(request_row)
        date_key = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        stats = (
            self.db.query(UsageStatistics)
            .filter(
                UsageStatistics.client_id == request_row.client_id,
                UsageStatistics.date == date_key,
            )
            .first()
        )
        if not stats:
            stats = UsageStatistics(
                client_id=request_row.client_id,
                date=date_key,
                total_requests=1,
                cache_hits=1 if request_row.cache_hit else 0,
                total_tokens=request_row.total_tokens,
                total_cost=request_row.estimated_cost,
                total_savings=request_row.estimated_savings,
            )
            self.db.add(stats)
        else:
            stats.total_requests += 1
            stats.cache_hits += 1 if request_row.cache_hit else 0
            stats.total_tokens += request_row.total_tokens
            stats.total_cost += request_row.estimated_cost
            stats.total_savings += request_row.estimated_savings
        self.db.commit()

    def get_spend_totals(self) -> tuple[float, float]:
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        month_prefix = datetime.now(timezone.utc).strftime("%Y-%m")
        daily = (
            self.db.query(func.coalesce(func.sum(UsageStatistics.total_cost), 0.0))
            .filter(UsageStatistics.date == today)
            .scalar()
        )
        monthly = (
            self.db.query(func.coalesce(func.sum(UsageStatistics.total_cost), 0.0))
            .filter(UsageStatistics.date.like(f"{month_prefix}%"))
            .scalar()
        )
        return float(daily or 0.0), float(monthly or 0.0)
