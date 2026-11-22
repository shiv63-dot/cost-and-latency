import json
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional
import redis

from app.core.security import sha256_hex
from app.services.embedding_service import EmbeddingService, cosine_similarity


@dataclass
class CacheLookupOutcome:
    hit: bool
    cache_type: str  # NONE | EXACT | SEMANTIC
    similarity_score: Optional[float]
    lookup_ms: float
    payload: Optional[Dict[str, Any]]
    settings_hash: str
    exact_hash: str
    prompt_text: str
    embedding: List[float]
    redis_available: bool = True


class SemanticCacheService:
    def __init__(self, redis_client: Optional[redis.Redis], embedder: EmbeddingService):
        self.redis = redis_client
        self.embedder = embedder

    def is_connected(self) -> bool:
        if self.redis is None:
            return False
        try:
            return bool(self.redis.ping())
        except Exception:
            return False

    @staticmethod
    def build_settings_hash(
        model: str,
        messages: List[Dict[str, str]],
        temperature: float,
        max_tokens: Optional[int],
        client_scope: str,
    ) -> str:
        system_prompts = [m["content"].strip() for m in messages if m.get("role") == "system"]
        temp_bucket = round(float(temperature), 1)
        canonical = json.dumps(
            {
                "model": model,
                "system": system_prompts,
                "temperature": temp_bucket,
                "max_tokens": max_tokens,
                "scope": client_scope,
            },
            sort_keys=True,
        )
        return sha256_hex(canonical)

    @staticmethod
    def extract_prompt_text(messages: List[Dict[str, str]]) -> str:
        return "\n".join(
            f"{m['role']}: {m['content'].strip()}"
            for m in messages
            if m.get("role") != "system"
        ).strip()

    def lookup(
        self,
        model: str,
        messages: List[Dict[str, str]],
        temperature: float,
        max_tokens: Optional[int],
        client_scope: str,
        similarity_threshold: float,
    ) -> CacheLookupOutcome:
        started = time.perf_counter()
        settings_hash = self.build_settings_hash(
            model, messages, temperature, max_tokens, client_scope
        )
        canonical_msgs = [
            {"role": m["role"], "content": " ".join(m["content"].strip().split())}
            for m in messages
        ]
        exact_hash = sha256_hex(f"{settings_hash}:{json.dumps(canonical_msgs, sort_keys=True)}")
        prompt_text = self.extract_prompt_text(messages)

        if self.redis is None:
            return CacheLookupOutcome(
                hit=False,
                cache_type="NONE",
                similarity_score=None,
                lookup_ms=round((time.perf_counter() - started) * 1000, 3),
                payload=None,
                settings_hash=settings_hash,
                exact_hash=exact_hash,
                prompt_text=prompt_text,
                embedding=[],
                redis_available=False,
            )

        try:
            # Tier 1: Exact-match Redis lookup
            exact_raw = self.redis.get(f"cache:exact:{exact_hash}")
            if exact_raw:
                payload = json.loads(exact_raw)
                return CacheLookupOutcome(
                    hit=True,
                    cache_type="EXACT",
                    similarity_score=1.0,
                    lookup_ms=round((time.perf_counter() - started) * 1000, 3),
                    payload=payload,
                    settings_hash=settings_hash,
                    exact_hash=exact_hash,
                    prompt_text=prompt_text,
                    embedding=[],
                    redis_available=True,
                )

            # Tier 2: Semantic similarity search within matching settings_hash index
            embedding = self.embedder.embed(prompt_text)
            candidate_keys = list(self.redis.smembers(f"cache:index:{settings_hash}") or [])
            best_score = 0.0
            best_payload: Optional[Dict[str, Any]] = None

            for key in candidate_keys:
                key_str = key.decode("utf-8") if isinstance(key, bytes) else str(key)
                raw_entry = self.redis.get(key_str)
                if not raw_entry:
                    self.redis.srem(f"cache:index:{settings_hash}", key_str)
                    continue
                entry = json.loads(raw_entry)
                score = cosine_similarity(embedding, entry.get("embedding", []))
                if score > best_score:
                    best_score = score
                    best_payload = entry.get("payload")

            lookup_ms = round((time.perf_counter() - started) * 1000, 3)
            if best_payload and best_score >= similarity_threshold:
                return CacheLookupOutcome(
                    hit=True,
                    cache_type="SEMANTIC",
                    similarity_score=round(best_score, 4),
                    lookup_ms=lookup_ms,
                    payload=best_payload,
                    settings_hash=settings_hash,
                    exact_hash=exact_hash,
                    prompt_text=prompt_text,
                    embedding=embedding,
                    redis_available=True,
                )

            return CacheLookupOutcome(
                hit=False,
                cache_type="NONE",
                similarity_score=round(best_score, 4) if best_score > 0 else None,
                lookup_ms=lookup_ms,
                payload=None,
                settings_hash=settings_hash,
                exact_hash=exact_hash,
                prompt_text=prompt_text,
                embedding=embedding,
                redis_available=True,
            )
        except Exception:
            # Graceful fallback when Redis is unavailable
            return CacheLookupOutcome(
                hit=False,
                cache_type="NONE",
                similarity_score=None,
                lookup_ms=round((time.perf_counter() - started) * 1000, 3),
                payload=None,
                settings_hash=settings_hash,
                exact_hash=exact_hash,
                prompt_text=prompt_text,
                embedding=[],
                redis_available=False,
            )

    def store(
        self,
        exact_hash: str,
        settings_hash: str,
        prompt_text: str,
        embedding: List[float],
        payload: Dict[str, Any],
        ttl_seconds: int,
    ) -> None:
        if self.redis is None:
            return
        try:
            vec = embedding or self.embedder.embed(prompt_text)
            self.redis.setex(f"cache:exact:{exact_hash}", ttl_seconds, json.dumps(payload))
            sem_key = f"cache:sem:{exact_hash}"
            self.redis.setex(
                sem_key,
                ttl_seconds,
                json.dumps(
                    {
                        "prompt_preview": prompt_text[:160],
                        "embedding": vec,
                        "payload": payload,
                    }
                ),
            )
            self.redis.sadd(f"cache:index:{settings_hash}", sem_key)
            self.redis.expire(f"cache:index:{settings_hash}", ttl_seconds)
        except Exception:
            pass

    def clear_all(self) -> int:
        if self.redis is None:
            return 0
        try:
            keys = list(self.redis.scan_iter("cache:*"))
            if not keys:
                return 0
            return int(self.redis.delete(*keys))
        except Exception:
            return 0

    def count_entries(self) -> int:
        if self.redis is None:
            return 0
        try:
            return sum(1 for _ in self.redis.scan_iter("cache:exact:*"))
        except Exception:
            return 0
