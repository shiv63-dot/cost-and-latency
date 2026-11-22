from app.core.config import DEFAULT_MODEL_PRICING
from app.database.repository import ProxyRepository


class CostTrackerService:
    def __init__(self, repo: ProxyRepository):
        self.repo = repo

    def calculate_estimated_cost(self, model: str, input_tokens: int, output_tokens: int) -> float:
        provider_row = self.repo.get_provider_by_model(model)
        if provider_row:
            in_price = provider_row.input_price_per_1m
            out_price = provider_row.output_price_per_1m
        else:
            pricing = DEFAULT_MODEL_PRICING.get(model) or DEFAULT_MODEL_PRICING["gpt-4o-mini"]
            in_price = pricing.input_price_per_1m
            out_price = pricing.output_price_per_1m

        cost = (input_tokens / 1_000_000.0) * in_price + (output_tokens / 1_000_000.0) * out_price
        return round(cost, 8)
