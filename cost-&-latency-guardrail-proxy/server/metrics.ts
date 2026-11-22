import type { ProxyDatabase } from './database.ts';

const LATENCY_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];

export function computePercentile(sortedValues: number[], percentile: number): number {
  if (sortedValues.length === 0) return 0;
  const idx = Math.ceil((percentile / 100) * sortedValues.length) - 1;
  const clamped = Math.max(0, Math.min(sortedValues.length - 1, idx));
  return Number(sortedValues[clamped].toFixed(2));
}

export function generatePrometheusMetrics(db: ProxyDatabase): string {
  const rows = db.db
    .prepare(`
      SELECT
        model, status, cache_hit, cache_type, input_tokens, output_tokens,
        estimated_cost, estimated_savings, latency_ms, fallback_used, error_message
      FROM api_requests
    `)
    .all() as Array<{
      model: string;
      status: string;
      cache_hit: number;
      cache_type: string;
      input_tokens: number;
      output_tokens: number;
      estimated_cost: number;
      estimated_savings: number;
      latency_ms: number;
      fallback_used: number;
      error_message: string | null;
    }>;

  const lines: string[] = [];

  lines.push('# HELP proxy_requests_total Total number of API requests handled by the gateway');
  lines.push('# TYPE proxy_requests_total counter');
  const reqCounts = new Map<string, number>();

  let cacheHitsExact = 0;
  let cacheHitsSemantic = 0;
  let cacheMisses = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCostUsd = 0;
  let totalSavingsUsd = 0;
  let providerErrors = 0;
  let fallbackTotal = 0;
  const latencies: number[] = [];

  for (const row of rows) {
    const cacheStatus = row.cache_hit === 1 ? 'hit' : 'miss';
    const labelKey = `model="${row.model}",status="${row.status}",cache_status="${cacheStatus}"`;
    reqCounts.set(labelKey, (reqCounts.get(labelKey) || 0) + 1);

    if (row.cache_hit === 1) {
      if (row.cache_type === 'EXACT') cacheHitsExact += 1;
      else cacheHitsSemantic += 1;
    } else if (row.status === 'success') {
      cacheMisses += 1;
    }

    totalInputTokens += row.input_tokens;
    totalOutputTokens += row.output_tokens;
    totalCostUsd += row.estimated_cost;
    totalSavingsUsd += row.estimated_savings;
    if (row.status === 'error') providerErrors += 1;
    if (row.fallback_used === 1) fallbackTotal += 1;
    latencies.push(row.latency_ms);
  }

  for (const [labels, count] of reqCounts.entries()) {
    lines.push(`proxy_requests_total{${labels}} ${count}`);
  }

  lines.push('# HELP proxy_cache_hits_total Total cache hits by cache lookup tier');
  lines.push('# TYPE proxy_cache_hits_total counter');
  lines.push(`proxy_cache_hits_total{cache_type="EXACT"} ${cacheHitsExact}`);
  lines.push(`proxy_cache_hits_total{cache_type="SEMANTIC"} ${cacheHitsSemantic}`);

  lines.push('# HELP proxy_cache_misses_total Total cache misses forwarded to upstream providers');
  lines.push('# TYPE proxy_cache_misses_total counter');
  lines.push(`proxy_cache_misses_total ${cacheMisses}`);

  lines.push('# HELP proxy_tokens_total Total tokens processed by type');
  lines.push('# TYPE proxy_tokens_total counter');
  lines.push(`proxy_tokens_total{type="input"} ${totalInputTokens}`);
  lines.push(`proxy_tokens_total{type="output"} ${totalOutputTokens}`);

  lines.push('# HELP proxy_estimated_cost_usd_total Estimated upstream API expenditure in USD');
  lines.push('# TYPE proxy_estimated_cost_usd_total counter');
  lines.push(`proxy_estimated_cost_usd_total ${totalCostUsd.toFixed(6)}`);

  lines.push('# HELP proxy_estimated_savings_usd_total Estimated API cost saved via caching in USD');
  lines.push('# TYPE proxy_estimated_savings_usd_total counter');
  lines.push(`proxy_estimated_savings_usd_total ${totalSavingsUsd.toFixed(6)}`);

  lines.push('# HELP proxy_provider_errors_total Total upstream LLM provider errors');
  lines.push('# TYPE proxy_provider_errors_total counter');
  lines.push(`proxy_provider_errors_total ${providerErrors}`);

  lines.push('# HELP proxy_fallback_used_total Total requests routed to fallback model');
  lines.push('# TYPE proxy_fallback_used_total counter');
  lines.push(`proxy_fallback_used_total ${fallbackTotal}`);

  lines.push('# HELP proxy_request_latency_ms Request latency histogram in milliseconds');
  lines.push('# TYPE proxy_request_latency_ms histogram');
  let sumLatency = 0;
  for (const l of latencies) sumLatency += l;
  for (const bucket of LATENCY_BUCKETS_MS) {
    const countInBucket = latencies.filter((l) => l <= bucket).length;
    lines.push(`proxy_request_latency_ms_bucket{le="${bucket}"} ${countInBucket}`);
  }
  lines.push(`proxy_request_latency_ms_bucket{le="+Inf"} ${latencies.length}`);
  lines.push(`proxy_request_latency_ms_sum ${sumLatency.toFixed(2)}`);
  lines.push(`proxy_request_latency_ms_count ${latencies.length}`);

  return `${lines.join('\n')}\n`;
}
