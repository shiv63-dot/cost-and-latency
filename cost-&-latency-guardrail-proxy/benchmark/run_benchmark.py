#!/usr/bin/env python3
"""
Benchmarking suite for Cost & Latency Guardrail Proxy.

Compares four execution modes against a running gateway instance:
  A. Direct upstream baseline (simulated/bypassed proxy overhead)
  B. Proxy without caching (X-Bypass-Cache: true)
  C. Proxy with exact-match caching
  D. Proxy with semantic similarity caching

Usage:
  python3 benchmark/run_benchmark.py --base-url http://localhost:3000 --api-key <KEY>
"""

import argparse
import json
import statistics
import time
import urllib.error
import urllib.request
from typing import Any, Dict, List


WORKLOAD_PROMPTS = [
    "Explain machine learning",
    "Explain machine learning",
    "What is machine learning in simple terms?",
    "Explain semantic caching with Redis embeddings",
    "How does Redis semantic cache work with embeddings?",
    "Explain gradient descent optimization",
    "How does gradient descent optimization work?",
    "Explain Kubernetes cluster orchestration",
    "What is Kubernetes container orchestration?",
    "Explain gradient descent optimization",
]


def percentile(values: List[float], pct: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    idx = max(0, min(len(ordered) - 1, int((pct / 100.0) * len(ordered) + 0.999) - 1))
    return round(ordered[idx], 2)


def post_completion(
    base_url: str,
    api_key: str,
    prompt: str,
    model: str = "gpt-4o",
    bypass_cache: bool = False,
) -> Dict[str, Any]:
    url = f"{base_url.rstrip('/')}/api/v1/chat/completions"
    payload = json.dumps(
        {
            "model": model,
            "temperature": 0.7,
            "messages": [{"role": "user", "content": prompt}],
        }
    ).encode("utf-8")

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
        "X-Client-Id": "benchmark-runner",
    }
    if bypass_cache:
        headers["X-Bypass-Cache"] = "true"

    req = urllib.request.Request(url, data=payload, headers=headers, method="POST")
    t0 = time.perf_counter()
    with urllib.request.urlopen(req, timeout=30) as resp:
        body = json.loads(resp.read().decode("utf-8"))
        client_ms = round((time.perf_counter() - t0) * 1000, 2)
        return {
            "client_ms": client_ms,
            "cache_status": resp.headers.get("X-Cache-Status", "MISS"),
            "cache_lookup_ms": float(resp.headers.get("X-Cache-Lookup-Ms", "0") or 0),
            "meta": body.get("proxy_metadata", {}),
        }


def run_scenario(
    name: str,
    prompts: List[str],
    base_url: str,
    api_key: str,
    bypass_cache: bool,
) -> Dict[str, Any]:
    latencies: List[float] = []
    lookup_latencies: List[float] = []
    hits = 0
    provider_calls = 0
    total_cost = 0.0
    total_savings = 0.0

    for prompt in prompts:
        res = post_completion(base_url, api_key, prompt, bypass_cache=bypass_cache)
        latencies.append(res["client_ms"])
        lookup_latencies.append(res["cache_lookup_ms"])
        meta = res["meta"]
        if meta.get("cache_hit"):
            hits += 1
        else:
            provider_calls += 1
        total_cost += float(meta.get("estimated_cost_usd", 0.0))
        total_savings += float(meta.get("estimated_savings_usd", 0.0))

    total = len(prompts)
    return {
        "scenario": name,
        "requests": total,
        "avg_client_latency_ms": round(statistics.mean(latencies), 2) if latencies else 0.0,
        "p50_latency_ms": percentile(latencies, 50),
        "p95_latency_ms": percentile(latencies, 95),
        "avg_local_lookup_ms": round(statistics.mean(lookup_latencies), 3) if lookup_latencies else 0.0,
        "cache_hit_rate_pct": round((hits / total) * 100, 1) if total else 0.0,
        "external_provider_calls": provider_calls,
        "estimated_cost_usd": round(total_cost, 6),
        "estimated_savings_usd": round(total_savings, 6),
    }


def main():
    parser = argparse.ArgumentParser(description="Benchmark Cost & Latency Guardrail Proxy")
    parser.add_argument("--base-url", default="http://localhost:3000")
    parser.add_argument("--api-key", required=True)
    args = parser.parse_args()

    # Scenario B: Proxy without caching
    b = run_scenario("B. Proxy (No Cache)", WORKLOAD_PROMPTS, args.base_url, args.api_key, bypass_cache=True)

    # Scenario C: Exact-match only (exact repeats of first prompt)
    exact_prompts = ["Explain machine learning"] * 10
    c = run_scenario("C. Proxy (Exact Cache)", exact_prompts, args.base_url, args.api_key, bypass_cache=False)

    # Scenario D: Semantic + Exact mixed workload
    d = run_scenario("D. Proxy (Semantic Cache)", WORKLOAD_PROMPTS, args.base_url, args.api_key, bypass_cache=False)

    report = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "base_url": args.base_url,
        "results": [b, c, d],
    }
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
