export type DashboardTab =
  | 'overview'
  | 'requests'
  | 'cache'
  | 'costs'
  | 'guardrails'
  | 'health'
  | 'playground';

export interface AuthStatus {
  configured: boolean;
  envManaged: boolean;
  authenticated: boolean;
}

export interface TimelinePoint {
  seq: number;
  requestId: string;
  time: string;
  model: string;
  latencyMs: number;
  cacheHit: boolean;
  cacheType: 'NONE' | 'EXACT' | 'SEMANTIC';
  costUsd: number;
  savingsUsd: number;
  tokens: number;
}

export interface OverviewAnalytics {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  cacheHits: number;
  exactHits: number;
  semanticHits: number;
  cacheHitRatio: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  estimatedSavingsUsd: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  avgCacheHitLatencyMs: number;
  avgCacheMissLatencyMs: number;
  fallbackCount: number;
  costNote: string;
  timeline: TimelinePoint[];
}

export interface ApiRequestLog {
  id: number;
  request_id: string;
  client_id: string;
  model: string;
  requested_model: string;
  status: 'success' | 'error' | 'rejected';
  status_code: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  estimated_cost: number;
  estimated_savings: number;
  latency_ms: number;
  cache_lookup_ms: number;
  cache_hit: number;
  cache_type: 'NONE' | 'EXACT' | 'SEMANTIC';
  similarity_score: number | null;
  provider: string;
  fallback_used: number;
  error_message: string | null;
  created_at: string;
}

export interface CacheStatsResponse {
  cachedPromptCount: number;
  totalCacheHits: number;
  exactHits: number;
  semanticHits: number;
  totalMisses: number;
  hitRatio: number;
  ttlSeconds: number;
  similarityThreshold: number;
  entries: Array<{
    id: number;
    model: string;
    promptPreview: string;
    hitCount: number;
    inputTokens: number;
    outputTokens: number;
    createdAt: string;
    expiresAt: string;
  }>;
}

export interface ModelCostBreakdown {
  model: string;
  requests: number;
  cacheHits: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  estimatedSavingsUsd: number;
}

export interface CostAnalyticsResponse {
  dailySpendUsd: number;
  monthlySpendUsd: number;
  byModel: ModelCostBreakdown[];
  dailySeries: Array<{
    date: string;
    requests: number;
    cache_hits: number;
    tokens: number;
    cost_usd: number;
    savings_usd: number;
  }>;
  disclaimer: string;
}

export interface TokenModelBreakdown {
  model: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cached_tokens: number;
  upstream_tokens: number;
}

export interface GuardrailsStatusResponse {
  config: {
    id: number;
    daily_budget: number;
    monthly_budget: number;
    requests_per_minute: number;
    max_tokens: number;
    similarity_threshold: number;
    cache_ttl_seconds: number;
    fallback_enabled: number;
    request_timeout_ms: number;
    max_retries: number;
    updated_at: string;
  };
  utilization: {
    dailySpendUsd: number;
    dailyBudgetUsd: number;
    dailyUtilizationPct: number;
    monthlySpendUsd: number;
    monthlyBudgetUsd: number;
    monthlyUtilizationPct: number;
    currentRpm: number;
    rpmLimit: number;
    rpmUtilizationPct: number;
  };
}

export interface ProviderConfig {
  id: number;
  provider_name: string;
  model_name: string;
  enabled: number;
  priority: number;
  input_price_per_1m: number;
  output_price_per_1m: number;
  max_tokens_limit: number;
}

export interface SystemStatusResponse {
  gateway: {
    status: string;
    runtime: string;
    primaryModel: string;
    fallbackModel: string;
    providerMode: string;
    openAiConfigured: boolean;
    geminiConfigured: boolean;
  };
  cache: {
    engine: string;
    status: string;
    cachedEntries: number;
    hitRatio: number;
  };
  database: {
    engine: string;
    status: string;
  };
  providers: {
    configured: number;
    enabled: number;
    status: string;
  };
  monitoring: {
    prometheusEndpoint: string;
    status: string;
  };
  timestamp: string;
}

export interface ClientKeySummary {
  id: number;
  key_name: string;
  client_id: string;
  key_prefix: string;
  rpm_limit: number;
  enabled: number;
  created_at: string;
  last_used_at: string | null;
}
