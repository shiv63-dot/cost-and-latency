import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createProxyApp } from '../app.ts';

async function withTestServer(
  run: (baseUrl: string) => Promise<void>,
  configOverrides?: Record<string, unknown>
) {
  const ctx = createProxyApp({
    sqlitePath: ':memory:',
    seedInitialProbe: false,
    configOverrides: {
      mockProviderMode: true,
      adminPasscode: '',
      proxyClientApiKey: 'test-client-secret-key',
      ...configOverrides,
    },
  });

  const server = http.createServer(ctx.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind ephemeral test port');
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await run(baseUrl);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ctx.db.close();
  }
}

test('1 & 13. Authentication & Request Validation', async () => {
  await withTestServer(async (baseUrl) => {
    // Unauthenticated request rejected
    const unauth = await fetch(`${baseUrl}/api/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi' }] }),
    });
    assert.equal(unauth.status, 401);

    // Invalid messages rejected
    const invalid = await fetch(`${baseUrl}/api/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': 'test-client-secret-key',
      },
      body: JSON.stringify({ model: 'gpt-4o', messages: [] }),
    });
    assert.equal(invalid.status, 400);

    // Admin claim & lock
    const claim = await fetch(`${baseUrl}/api/v1/auth/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode: 'super-secure-admin-123' }),
    });
    assert.equal(claim.status, 201);
    const claimJson = (await claim.json()) as { token: string };
    assert.ok(claimJson.token);

    // Second claim attempt blocked
    const secondClaim = await fetch(`${baseUrl}/api/v1/auth/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode: 'another-passcode-123' }),
    });
    assert.equal(secondClaim.status, 409);
  });
});

test('2, 3, 4, 5, 6, 7. Cache Miss, Exact Hit, Semantic Hit, Isolation, Cost & Invalidation', async () => {
  await withTestServer(async (baseUrl) => {
    const claim = await fetch(`${baseUrl}/api/v1/auth/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode: 'admin-test-pass-999' }),
    });
    const { token } = (await claim.json()) as { token: string };

    // Cache MISS
    const r1 = await fetch(`${baseUrl}/api/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': 'test-client-secret-key',
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        temperature: 0.7,
        messages: [{ role: 'user', content: 'Explain machine learning' }],
      }),
    });
    assert.equal(r1.status, 200);
    assert.equal(r1.headers.get('x-cache-status'), 'MISS');
    const b1 = (await r1.json()) as {
      choices: Array<{ message: { content: string } }>;
      proxy_metadata: { estimated_cost_usd: number; cache_hit: boolean };
    };
    assert.equal(b1.proxy_metadata.cache_hit, false);
    assert.ok(b1.proxy_metadata.estimated_cost_usd > 0);

    // Exact-match HIT
    const r2 = await fetch(`${baseUrl}/api/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': 'test-client-secret-key',
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        temperature: 0.7,
        messages: [{ role: 'user', content: 'Explain machine learning' }],
      }),
    });
    assert.equal(r2.status, 200);
    assert.equal(r2.headers.get('x-cache-status'), 'HIT_EXACT');
    const b2 = (await r2.json()) as {
      proxy_metadata: { estimated_cost_usd: number; estimated_savings_usd: number };
    };
    assert.equal(b2.proxy_metadata.estimated_cost_usd, 0);
    assert.ok(b2.proxy_metadata.estimated_savings_usd > 0);

    // Semantic HIT
    const r3 = await fetch(`${baseUrl}/api/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': 'test-client-secret-key',
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        temperature: 0.7,
        messages: [{ role: 'user', content: 'What is machine learning in simple terms?' }],
      }),
    });
    assert.equal(r3.status, 200);
    assert.equal(r3.headers.get('x-cache-status'), 'HIT_SEMANTIC');

    // Incompatible temperature MUST NOT reuse cached entry
    const r4 = await fetch(`${baseUrl}/api/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': 'test-client-secret-key',
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        temperature: 0.1,
        messages: [{ role: 'user', content: 'Explain machine learning' }],
      }),
    });
    assert.equal(r4.headers.get('x-cache-status'), 'MISS');

    // Cache Invalidation
    const clearRes = await fetch(`${baseUrl}/api/v1/cache/clear`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(clearRes.status, 200);
    const clearBody = (await clearRes.json()) as { cleared: boolean; entriesRemoved: number };
    assert.equal(clearBody.cleared, true);
    assert.ok(clearBody.entriesRemoved >= 2);
  });
});

test('8 & 9. Rate Limit & Budget Guardrail Enforcement', async () => {
  await withTestServer(async (baseUrl) => {
    const claim = await fetch(`${baseUrl}/api/v1/auth/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode: 'admin-guardrail-123' }),
    });
    const { token } = (await claim.json()) as { token: string };

    // Set tight RPM = 2
    const cfgRes = await fetch(`${baseUrl}/api/v1/guardrails/config`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ requests_per_minute: 2, daily_budget: 0.0001 }),
    });
    assert.equal(cfgRes.status, 200);

    // 1st request passes (and spends > $0.0001 on gpt-4o)
    const first = await fetch(`${baseUrl}/api/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': 'test-client-secret-key',
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Explain Kubernetes cluster architecture in detail' }],
      }),
    });
    assert.equal(first.status, 200);

    // 2nd request blocked by daily budget guardrail
    const budgetBlocked = await fetch(`${baseUrl}/api/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': 'test-client-secret-key',
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Explain SQL indexing' }],
      }),
    });
    assert.equal(budgetBlocked.status, 429);
    const budgetErr = (await budgetBlocked.json()) as { error: { code: string } };
    assert.equal(budgetErr.error.code, 'daily_budget_exceeded');

    // 3rd request blocked by RPM rate limit (since RPM check runs before budget check)
    const rpmBlocked = await fetch(`${baseUrl}/api/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': 'test-client-secret-key',
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Explain Prometheus histograms' }],
      }),
    });
    assert.equal(rpmBlocked.status, 429);
    const rpmErr = (await rpmBlocked.json()) as { error: { code: string } };
    assert.equal(rpmErr.error.code, 'rate_limit_exceeded');
    assert.ok(rpmBlocked.headers.get('retry-after'));
  });
});

test('10, 11, 14. Fallback Routing, Provider Timeout & Analytics + Prometheus Metrics', async () => {
  await withTestServer(async (baseUrl) => {
    // Primary failure -> Fallback to gpt-4o-mini
    const fallbackRes = await fetch(`${baseUrl}/api/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': 'test-client-secret-key',
        'X-Simulate-Primary-Failure': 'true',
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Explain Kubernetes pods' }],
      }),
    });
    assert.equal(fallbackRes.status, 200);
    assert.equal(fallbackRes.headers.get('x-fallback-used'), 'true');
    assert.equal(fallbackRes.headers.get('x-proxy-model-used'), 'gpt-4o-mini');

    // Timeout with allow_fallback=false -> 504
    const timeoutRes = await fetch(`${baseUrl}/api/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': 'test-client-secret-key',
        'X-Simulate-Timeout': 'true',
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        allow_fallback: false,
        messages: [{ role: 'user', content: 'Explain timeout handling' }],
      }),
    });
    assert.equal(timeoutRes.status, 504);

    // Dashboard Analytics & /metrics endpoints
    const overview = await fetch(`${baseUrl}/api/v1/analytics/overview`);
    assert.equal(overview.status, 200);
    const overviewJson = (await overview.json()) as {
      totalRequests: number;
      fallbackCount: number;
      failedRequests: number;
    };
    assert.equal(overviewJson.totalRequests, 2);
    assert.equal(overviewJson.fallbackCount, 1);
    assert.equal(overviewJson.failedRequests, 1);

    const metricsRes = await fetch(`${baseUrl}/metrics`);
    assert.equal(metricsRes.status, 200);
    const metricsText = await metricsRes.text();
    assert.ok(metricsText.includes('proxy_requests_total'));
    assert.ok(metricsText.includes('proxy_fallback_used_total 1'));
  });
});
