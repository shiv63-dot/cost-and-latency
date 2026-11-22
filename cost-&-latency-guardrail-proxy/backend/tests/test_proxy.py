import os
import fnmatch
import pytest
from fastapi.testclient import TestClient

os.environ["DATABASE_URL"] = "sqlite:///./test_proxy_suite.db"
os.environ["PROXY_CLIENT_API_KEY"] = "test-client-key"
os.environ["ADMIN_PASSCODE"] = "test-admin-pass"
os.environ["MOCK_PROVIDER_MODE"] = "true"

from app.database.models import Base  # noqa: E402
from app.database.session import engine, init_db  # noqa: E402
from app.main import create_app  # noqa: E402


class InMemoryRedis:
    def __init__(self):
        self.kv = {}
        self.sets = {}

    def ping(self):
        return True

    def get(self, key):
        return self.kv.get(key)

    def setex(self, key, _ttl, value):
        self.kv[key] = value.encode("utf-8") if isinstance(value, str) else value

    def sadd(self, key, member):
        self.sets.setdefault(key, set()).add(member)

    def smembers(self, key):
        return self.sets.get(key, set())

    def srem(self, key, member):
        self.sets.get(key, set()).discard(member)

    def expire(self, _key, _ttl):
        return True

    def scan_iter(self, pattern):
        for k in list(self.kv.keys()) + list(self.sets.keys()):
            if fnmatch.fnmatch(k, pattern):
                yield k

    def delete(self, *keys):
        removed = 0
        for k in keys:
            if k in self.kv:
                del self.kv[k]
                removed += 1
            if k in self.sets:
                del self.sets[k]
                removed += 1
        return removed


class BrokenRedis:
    def ping(self):
        raise ConnectionError("Redis unavailable")

    def get(self, _key):
        raise ConnectionError("Redis unavailable")

    def setex(self, _key, _ttl, _val):
        raise ConnectionError("Redis unavailable")

    def smembers(self, _key):
        raise ConnectionError("Redis unavailable")


@pytest.fixture()
def client():
    Base.metadata.drop_all(bind=engine)
    init_db()
    app = create_app(redis_client=InMemoryRedis(), enable_transformer=False)
    with TestClient(app) as tc:
        yield tc


CLIENT_HEADERS = {"X-API-Key": "test-client-key"}
ADMIN_HEADERS = {"Authorization": "Bearer test-admin-pass"}


def test_01_request_validation_and_13_auth(client):
    unauth = client.post("/api/v1/chat/completions", json={"model": "gpt-4o", "messages": [{"role": "user", "content": "hi"}]})
    assert unauth.status_code == 401

    invalid = client.post("/api/v1/chat/completions", headers=CLIENT_HEADERS, json={"model": "gpt-4o", "messages": []})
    assert invalid.status_code == 422

    forbidden = client.delete("/api/v1/cache/clear", headers=CLIENT_HEADERS)
    assert forbidden.status_code == 403


def test_02_03_04_05_06_07_cache_lifecycle_and_cost(client):
    # Miss
    r1 = client.post(
        "/api/v1/chat/completions",
        headers=CLIENT_HEADERS,
        json={"model": "gpt-4o", "temperature": 0.7, "messages": [{"role": "user", "content": "Explain machine learning"}]},
    )
    assert r1.status_code == 200
    assert r1.headers["x-cache-status"] == "MISS"
    assert r1.json()["proxy_metadata"]["estimated_cost_usd"] > 0

    # Exact hit
    r2 = client.post(
        "/api/v1/chat/completions",
        headers=CLIENT_HEADERS,
        json={"model": "gpt-4o", "temperature": 0.7, "messages": [{"role": "user", "content": "Explain machine learning"}]},
    )
    assert r2.status_code == 200
    assert r2.headers["x-cache-status"] == "HIT_EXACT"
    assert r2.json()["proxy_metadata"]["estimated_cost_usd"] == 0.0
    assert r2.json()["proxy_metadata"]["estimated_savings_usd"] > 0.0

    # Semantic hit
    r3 = client.post(
        "/api/v1/chat/completions",
        headers=CLIENT_HEADERS,
        json={"model": "gpt-4o", "temperature": 0.7, "messages": [{"role": "user", "content": "What is machine learning in simple terms?"}]},
    )
    assert r3.status_code == 200
    assert r3.headers["x-cache-status"] == "HIT_SEMANTIC"

    # Cache clear
    cleared = client.delete("/api/v1/cache/clear", headers=ADMIN_HEADERS)
    assert cleared.status_code == 200
    assert cleared.json()["cleared"] is True


def test_08_09_budget_and_rate_limits(client):
    cfg = client.post(
        "/api/v1/guardrails/config",
        headers=ADMIN_HEADERS,
        json={"requests_per_minute": 2, "daily_budget": 0.00001},
    )
    assert cfg.status_code == 200

    first = client.post(
        "/api/v1/chat/completions",
        headers=CLIENT_HEADERS,
        json={"model": "gpt-4o", "messages": [{"role": "user", "content": "Explain Kubernetes pods"}]},
    )
    assert first.status_code == 200

    second = client.post(
        "/api/v1/chat/completions",
        headers=CLIENT_HEADERS,
        json={"model": "gpt-4o", "messages": [{"role": "user", "content": "Explain SQL indexes"}]},
    )
    assert second.status_code == 429
    assert second.json()["error"]["code"] == "daily_budget_exceeded"

    third = client.post(
        "/api/v1/chat/completions",
        headers=CLIENT_HEADERS,
        json={"model": "gpt-4o", "messages": [{"role": "user", "content": "Explain Prometheus"}]},
    )
    assert third.status_code == 429
    assert third.json()["error"]["code"] == "rate_limit_exceeded"


def test_10_11_14_fallback_timeout_and_analytics(client):
    fb = client.post(
        "/api/v1/chat/completions",
        headers={**CLIENT_HEADERS, "X-Simulate-Primary-Failure": "true"},
        json={"model": "gpt-4o", "messages": [{"role": "user", "content": "Explain Docker"}]},
    )
    assert fb.status_code == 200
    assert fb.headers["x-fallback-used"] == "true"
    assert fb.headers["x-proxy-model-used"] == "gpt-4o-mini"

    to = client.post(
        "/api/v1/chat/completions",
        headers={**CLIENT_HEADERS, "X-Simulate-Timeout": "true"},
        json={"model": "gpt-4o", "allow_fallback": False, "messages": [{"role": "user", "content": "Timeout test"}]},
    )
    assert to.status_code == 504

    overview = client.get("/api/v1/analytics/overview")
    assert overview.status_code == 200
    assert overview.json()["fallbackCount"] == 1

    metrics = client.get("/metrics")
    assert metrics.status_code == 200
    assert "proxy_requests_total" in metrics.text


def test_12_redis_unavailable_graceful_forwarding():
    Base.metadata.drop_all(bind=engine)
    init_db()
    app = create_app(redis_client=BrokenRedis(), enable_transformer=False)
    with TestClient(app) as tc:
        res = tc.post(
            "/api/v1/chat/completions",
            headers=CLIENT_HEADERS,
            json={"model": "gpt-4o-mini", "messages": [{"role": "user", "content": "Hello without Redis"}]},
        )
        assert res.status_code == 200
        assert res.headers["x-cache-status"] == "MISS"
