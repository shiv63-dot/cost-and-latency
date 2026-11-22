from typing import List, Literal, Optional
from pydantic import BaseModel, Field


class ChatMessageSchema(BaseModel):
    role: Literal["system", "user", "assistant"]
    content: str = Field(..., min_length=1, max_length=32000)


class ChatCompletionRequest(BaseModel):
    model: str = Field(default="gpt-4o-mini", min_length=1, max_length=64)
    messages: List[ChatMessageSchema] = Field(..., min_length=1, max_length=64)
    temperature: float = Field(default=0.7, ge=0.0, le=2.0)
    max_tokens: Optional[int] = Field(default=None, ge=1, le=128000)
    allow_fallback: bool = True


class GuardrailConfigUpdate(BaseModel):
    daily_budget: Optional[float] = Field(default=None, gt=0)
    monthly_budget: Optional[float] = Field(default=None, gt=0)
    requests_per_minute: Optional[int] = Field(default=None, ge=1)
    max_tokens: Optional[int] = Field(default=None, ge=64)
    similarity_threshold: Optional[float] = Field(default=None, ge=0.5, le=0.99)
    cache_ttl_seconds: Optional[int] = Field(default=None, ge=30)
    fallback_enabled: Optional[bool] = None
    request_timeout_ms: Optional[int] = Field(default=None, ge=500)
    max_retries: Optional[int] = Field(default=None, ge=0, le=5)
