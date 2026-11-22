import type {
  ApiRequestLog,
  AuthStatus,
  CacheStatsResponse,
  ClientKeySummary,
  CostAnalyticsResponse,
  GuardrailsStatusResponse,
  OverviewAnalytics,
  ProviderConfig,
  SystemStatusResponse,
  TokenModelBreakdown,
} from '../types/proxy';

async function requestJson<T>(
  url: string,
  options?: RequestInit & { token?: string | null }
): Promise<T> {
  const headers = new Headers(options?.headers);
  if (options?.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (options?.token) {
    headers.set('Authorization', `Bearer ${options.token}`);
  }

  const res = await fetch(url, {
    ...options,
    headers,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const errMsg =
      (data as { error?: { message?: string } })?.error?.message ||
      `Request failed with status ${res.status}`;
    throw new Error(errMsg);
  }
  return data as T;
}

export const proxyApi = {
  getAuthStatus: (token: string | null) =>
    requestJson<AuthStatus>('/api/v1/auth/status', { token }),

  claimAdmin: (passcode: string) =>
    requestJson<{ authenticated: boolean; token: string }>('/api/v1/auth/claim', {
      method: 'POST',
      body: JSON.stringify({ passcode }),
    }),

  loginAdmin: (passcode: string) =>
    requestJson<{ authenticated: boolean; token: string }>('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ passcode }),
    }),

  getOverview: () => requestJson<OverviewAnalytics>('/api/v1/analytics/overview'),

  getRequests: (params?: { status?: string; cache?: string; limit?: number }) => {
    const qs = new URLSearchParams();
    if (params?.status) qs.set('status', params.status);
    if (params?.cache) qs.set('cache', params.cache);
    if (params?.limit) qs.set('limit', String(params.limit));
    return requestJson<{ requests: ApiRequestLog[] }>(
      `/api/v1/analytics/requests?${qs.toString()}`
    );
  },

  getCosts: () => requestJson<CostAnalyticsResponse>('/api/v1/analytics/costs'),

  getTokens: () =>
    requestJson<{ byModel: TokenModelBreakdown[] }>('/api/v1/analytics/tokens'),

  getCacheStats: () => requestJson<CacheStatsResponse>('/api/v1/cache/stats'),

  clearCache: (token: string) =>
    requestJson<{ cleared: boolean; entriesRemoved: number }>(
      '/api/v1/cache/clear',
      { method: 'DELETE', token }
    ),

  getGuardrailsStatus: () =>
    requestJson<GuardrailsStatusResponse>('/api/v1/guardrails/status'),

  updateGuardrailsConfig: (
    token: string,
    payload: {
      daily_budget?: number;
      monthly_budget?: number;
      requests_per_minute?: number;
      max_tokens?: number;
      similarity_threshold?: number;
      cache_ttl_seconds?: number;
      fallback_enabled?: boolean;
      request_timeout_ms?: number;
      max_retries?: number;
    }
  ) =>
    requestJson<GuardrailsStatusResponse>('/api/v1/guardrails/config', {
      method: 'POST',
      token,
      body: JSON.stringify(payload),
    }),

  getProviders: () =>
    requestJson<{
      primaryModel: string;
      fallbackModel: string;
      providerMode: string;
      providers: ProviderConfig[];
    }>('/api/v1/providers'),

  updateProviderConfig: (
    token: string,
    payload: { model_name: string; enabled?: boolean; priority?: number }
  ) =>
    requestJson<{ providers: ProviderConfig[] }>('/api/v1/providers/config', {
      method: 'POST',
      token,
      body: JSON.stringify(payload),
    }),

  getSystemStatus: () => requestJson<SystemStatusResponse>('/api/v1/system/status'),

  getPrometheusMetrics: async (): Promise<string> => {
    const res = await fetch('/metrics');
    if (!res.ok) throw new Error('Failed to load Prometheus metrics');
    return res.text();
  },

  getClientKeys: (token: string) =>
    requestJson<{ keys: ClientKeySummary[] }>('/api/v1/clients/keys', { token }),

  createClientKey: (
    token: string,
    payload: { key_name: string; client_id: string; rpm_limit: number }
  ) =>
    requestJson<{
      key_name: string;
      client_id: string;
      key_prefix: string;
      raw_key: string;
      note: string;
    }>('/api/v1/clients/keys', {
      method: 'POST',
      token,
      body: JSON.stringify(payload),
    }),

  revokeClientKey: (token: string, id: number) =>
    requestJson<{ deleted: boolean }>(`/api/v1/clients/keys/${id}`, {
      method: 'DELETE',
      token,
    }),

  runWorkloadProbe: (token: string) =>
    requestJson<{
      executed: number;
      results: Array<{
        requestId: string;
        label: string;
        model: string;
        cacheType: string;
        similarityScore: number | null;
        latencyMs: number;
        estimatedCost: number;
        estimatedSavings: number;
        fallbackUsed: boolean;
      }>;
    }>('/api/v1/workload/probe', { method: 'POST', token }),

  sendChatCompletion: async (
    tokenOrApiKey: string,
    payload: {
      model: string;
      messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
      temperature: number;
      max_tokens?: number;
      allow_fallback?: boolean;
    },
    headers?: {
      bypassCache?: boolean;
      simulatePrimaryFailure?: boolean;
      simulateTimeout?: boolean;
      clientId?: string;
    }
  ) => {
    const reqHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${tokenOrApiKey}`,
    };
    if (headers?.bypassCache) reqHeaders['X-Bypass-Cache'] = 'true';
    if (headers?.simulatePrimaryFailure) reqHeaders['X-Simulate-Primary-Failure'] = 'true';
    if (headers?.simulateTimeout) reqHeaders['X-Simulate-Timeout'] = 'true';
    if (headers?.clientId) reqHeaders['X-Client-Id'] = headers.clientId;

    const res = await fetch('/api/v1/chat/completions', {
      method: 'POST',
      headers: reqHeaders,
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    const responseHeaders = {
      requestId: res.headers.get('X-Request-ID') || '',
      cacheStatus: res.headers.get('X-Cache-Status') || '',
      cacheLookupMs: res.headers.get('X-Cache-Lookup-Ms') || '',
      modelUsed: res.headers.get('X-Proxy-Model-Used') || '',
      fallbackUsed: res.headers.get('X-Fallback-Used') || '',
    };
    return { ok: res.ok, status: res.status, data, responseHeaders };
  },
};
