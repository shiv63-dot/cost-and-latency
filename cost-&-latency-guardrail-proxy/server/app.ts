import crypto from 'node:crypto';
import express, { type Express, type Request, type Response } from 'express';
import { loadConfig, type AppConfig } from './config.ts';
import { CostTrackerService } from './costTracker.ts';
import { ProxyDatabase } from './database.ts';
import { GuardrailEngine } from './guardrailEngine.ts';
import { LLMRouterService } from './llmRouter.ts';
import { computePercentile, generatePrometheusMetrics } from './metrics.ts';
import {
  authenticateGatewayClient,
  createSessionToken,
  extractBearerOrApiKey,
  hashPassword,
  isAdminConfigured,
  requireAdmin,
  sha256Hex,
  verifyAdminCredential,
  verifySessionToken,
} from './security.ts';
import { SemanticCacheService, type ChatMessage } from './semanticCache.ts';

export interface ProxyContext {
  app: Express;
  config: AppConfig;
  db: ProxyDatabase;
  cache: SemanticCacheService;
  costTracker: CostTrackerService;
  guardrails: GuardrailEngine;
  router: LLMRouterService;
  runWorkloadProbe: (clientId?: string) => Promise<Array<{
    requestId: string;
    label: string;
    model: string;
    cacheType: string;
    similarityScore: number | null;
    latencyMs: number;
    estimatedCost: number;
    estimatedSavings: number;
    fallbackUsed: boolean;
  }>>;
}

interface ChatCompletionBody {
  model?: unknown;
  messages?: unknown;
  temperature?: unknown;
  max_tokens?: unknown;
  allow_fallback?: unknown;
}

function validateChatMessages(raw: unknown): ChatMessage[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 64) return null;
  const normalized: ChatMessage[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') return null;
    const role = (item as { role?: unknown }).role;
    const content = (item as { content?: unknown }).content;
    if (role !== 'system' && role !== 'user' && role !== 'assistant') return null;
    if (typeof content !== 'string' || content.trim().length === 0 || content.length > 32000) {
      return null;
    }
    normalized.push({ role, content: content.trim() });
  }
  return normalized;
}

export function createProxyApp(options?: {
  sqlitePath?: string;
  configOverrides?: Partial<AppConfig>;
  seedInitialProbe?: boolean;
}): ProxyContext {
  const baseConfig = loadConfig();
  const config: AppConfig = { ...baseConfig, ...options?.configOverrides };
  const db = new ProxyDatabase(options?.sqlitePath || config.sqlitePath, config);
  const cache = new SemanticCacheService(db);
  const costTracker = new CostTrackerService(db);
  const guardrails = new GuardrailEngine(db, costTracker);
  const llmRouter = new LLMRouterService(config, db);

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));

  // Core request-processing pipeline shared by HTTP endpoint & live probe
  async function executeProxyPipeline(params: {
    clientId: string;
    clientRpmOverride?: number;
    requestedModel: string;
    messages: ChatMessage[];
    temperature: number;
    maxTokens?: number;
    allowFallback: boolean;
    bypassCache?: boolean;
    simulatePrimaryFailure?: boolean;
    simulateTimeout?: boolean;
  }): Promise<{
    statusCode: number;
    headers: Record<string, string>;
    body: Record<string, unknown>;
    summary: {
      requestId: string;
      model: string;
      cacheType: 'NONE' | 'EXACT' | 'SEMANTIC';
      similarityScore: number | null;
      latencyMs: number;
      estimatedCost: number;
      estimatedSavings: number;
      fallbackUsed: boolean;
    };
  }> {
    const requestStart = performance.now();
    const requestId = `req_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;

    // 1. Guardrails: Token limits, Rate limits, Daily & Monthly Budget
    const decision = guardrails.evaluateRequest({
      clientId: params.clientId,
      messages: params.messages,
      requestedMaxTokens: params.maxTokens,
      clientRpmOverride: params.clientRpmOverride,
    });

    if (!decision.allowed) {
      const latencyMs = Number((performance.now() - requestStart).toFixed(2));
      costTracker.recordRequest({
        requestId,
        clientId: params.clientId,
        model: params.requestedModel,
        requestedModel: params.requestedModel,
        status: 'rejected',
        statusCode: decision.statusCode || 429,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCost: 0,
        estimatedSavings: 0,
        latencyMs,
        cacheLookupMs: 0,
        cacheHit: false,
        cacheType: 'NONE',
        similarityScore: null,
        provider: 'guardrail-engine',
        fallbackUsed: false,
        errorMessage: decision.message,
      });

      const headers: Record<string, string> = {
        'X-Request-ID': requestId,
        'X-Cache-Status': 'BYPASS',
      };
      if (decision.retryAfterSeconds) {
        headers['Retry-After'] = String(decision.retryAfterSeconds);
      }

      return {
        statusCode: decision.statusCode || 429,
        headers,
        body: {
          error: {
            message: decision.message,
            type: decision.errorType || 'rate_limit_error',
            code: decision.errorCode || 'guardrail_rejected',
          },
        },
        summary: {
          requestId,
          model: params.requestedModel,
          cacheType: 'NONE',
          similarityScore: null,
          latencyMs,
          estimatedCost: 0,
          estimatedSavings: 0,
          fallbackUsed: false,
        },
      };
    }

    const guardrailCfg = db.getGuardrailConfig();

    // 2. Semantic & Exact Cache Lookup
    const cacheLookup = params.bypassCache
      ? {
          hit: false,
          cacheType: 'NONE' as const,
          similarityScore: null,
          lookupMs: 0,
          settingsHash: '',
          exactHash: '',
          promptText: '',
          embedding: [] as number[],
        }
      : cache.lookup({
          model: params.requestedModel,
          messages: params.messages,
          temperature: params.temperature,
          maxTokens: params.maxTokens,
          clientScope: params.clientId,
          similarityThreshold: guardrailCfg.similarity_threshold,
        });

    if (cacheLookup.hit && cacheLookup.payload) {
      const totalLatencyMs = Number((performance.now() - requestStart).toFixed(2));
      const avoidedCost = costTracker.calculateEstimatedCost(
        cacheLookup.payload.model,
        cacheLookup.payload.inputTokens,
        cacheLookup.payload.outputTokens
      );

      costTracker.recordRequest({
        requestId,
        clientId: params.clientId,
        model: cacheLookup.payload.model,
        requestedModel: params.requestedModel,
        status: 'success',
        statusCode: 200,
        inputTokens: cacheLookup.payload.inputTokens,
        outputTokens: cacheLookup.payload.outputTokens,
        estimatedCost: 0,
        estimatedSavings: avoidedCost,
        latencyMs: totalLatencyMs,
        cacheLookupMs: cacheLookup.lookupMs,
        cacheHit: true,
        cacheType: cacheLookup.cacheType,
        similarityScore: cacheLookup.similarityScore,
        provider: 'semantic-cache',
        fallbackUsed: false,
      });

      return {
        statusCode: 200,
        headers: {
          'X-Request-ID': requestId,
          'X-Cache-Status': `HIT_${cacheLookup.cacheType}`,
          'X-Cache-Lookup-Ms': String(cacheLookup.lookupMs),
          'X-Proxy-Model-Used': cacheLookup.payload.model,
        },
        body: {
          id: requestId,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: cacheLookup.payload.model,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: cacheLookup.payload.content,
              },
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: cacheLookup.payload.inputTokens,
            completion_tokens: cacheLookup.payload.outputTokens,
            total_tokens: cacheLookup.payload.inputTokens + cacheLookup.payload.outputTokens,
          },
          proxy_metadata: {
            request_id: requestId,
            cache_hit: true,
            cache_type: cacheLookup.cacheType,
            similarity_score: cacheLookup.similarityScore,
            cache_lookup_ms: cacheLookup.lookupMs,
            total_latency_ms: totalLatencyMs,
            estimated_cost_usd: 0,
            estimated_savings_usd: avoidedCost,
            fallback_used: false,
            provider: 'semantic-cache',
          },
        },
        summary: {
          requestId,
          model: cacheLookup.payload.model,
          cacheType: cacheLookup.cacheType,
          similarityScore: cacheLookup.similarityScore,
          latencyMs: totalLatencyMs,
          estimatedCost: 0,
          estimatedSavings: avoidedCost,
          fallbackUsed: false,
        },
      };
    }

    // 3. Cache MISS -> Route to LLM Provider with Retries & Fallback
    try {
      const routeResult = await llmRouter.routeAndExecute({
        requestedModel: params.requestedModel,
        messages: params.messages,
        temperature: params.temperature,
        maxTokens: params.maxTokens,
        allowFallback: params.allowFallback,
        simulatePrimaryFailure: params.simulatePrimaryFailure,
        simulateTimeout: params.simulateTimeout,
      });

      const totalLatencyMs = Number((performance.now() - requestStart).toFixed(2));
      const estimatedCost = costTracker.calculateEstimatedCost(
        routeResult.modelUsed,
        routeResult.inputTokens,
        routeResult.outputTokens
      );

      // Store in cache if not bypassed and response was from the requested model
      if (!params.bypassCache && routeResult.modelUsed === params.requestedModel) {
        cache.store({
          exactHash: cacheLookup.exactHash,
          settingsHash: cacheLookup.settingsHash,
          model: routeResult.modelUsed,
          promptText: cacheLookup.promptText,
          embedding: cacheLookup.embedding,
          payload: {
            content: routeResult.content,
            model: routeResult.modelUsed,
            provider: routeResult.providerUsed,
            inputTokens: routeResult.inputTokens,
            outputTokens: routeResult.outputTokens,
          },
          ttlSeconds: guardrailCfg.cache_ttl_seconds,
        });
      }

      costTracker.recordRequest({
        requestId,
        clientId: params.clientId,
        model: routeResult.modelUsed,
        requestedModel: params.requestedModel,
        status: 'success',
        statusCode: 200,
        inputTokens: routeResult.inputTokens,
        outputTokens: routeResult.outputTokens,
        estimatedCost,
        estimatedSavings: 0,
        latencyMs: totalLatencyMs,
        cacheLookupMs: cacheLookup.lookupMs,
        cacheHit: false,
        cacheType: 'NONE',
        similarityScore: cacheLookup.similarityScore,
        provider: routeResult.providerUsed,
        fallbackUsed: routeResult.fallbackUsed,
      });

      return {
        statusCode: 200,
        headers: {
          'X-Request-ID': requestId,
          'X-Cache-Status': 'MISS',
          'X-Cache-Lookup-Ms': String(cacheLookup.lookupMs),
          'X-Proxy-Model-Used': routeResult.modelUsed,
          'X-Fallback-Used': String(routeResult.fallbackUsed),
        },
        body: {
          id: requestId,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: routeResult.modelUsed,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: routeResult.content,
              },
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: routeResult.inputTokens,
            completion_tokens: routeResult.outputTokens,
            total_tokens: routeResult.inputTokens + routeResult.outputTokens,
          },
          proxy_metadata: {
            request_id: requestId,
            cache_hit: false,
            cache_type: 'NONE',
            similarity_score: cacheLookup.similarityScore,
            cache_lookup_ms: cacheLookup.lookupMs,
            total_latency_ms: totalLatencyMs,
            estimated_cost_usd: estimatedCost,
            estimated_savings_usd: 0,
            fallback_used: routeResult.fallbackUsed,
            attempts: routeResult.attempts,
            provider: routeResult.providerUsed,
          },
        },
        summary: {
          requestId,
          model: routeResult.modelUsed,
          cacheType: 'NONE',
          similarityScore: cacheLookup.similarityScore,
          latencyMs: totalLatencyMs,
          estimatedCost,
          estimatedSavings: 0,
          fallbackUsed: routeResult.fallbackUsed,
        },
      };
    } catch (err) {
      const totalLatencyMs = Number((performance.now() - requestStart).toFixed(2));
      const safeErrorMsg = err instanceof Error ? err.message : 'Upstream provider failure';
      const isTimeout = safeErrorMsg.toLowerCase().includes('timed out');
      const statusCode = isTimeout ? 504 : 502;

      costTracker.recordRequest({
        requestId,
        clientId: params.clientId,
        model: params.requestedModel,
        requestedModel: params.requestedModel,
        status: 'error',
        statusCode,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCost: 0,
        estimatedSavings: 0,
        latencyMs: totalLatencyMs,
        cacheLookupMs: cacheLookup.lookupMs,
        cacheHit: false,
        cacheType: 'NONE',
        similarityScore: cacheLookup.similarityScore,
        provider: 'upstream-error',
        fallbackUsed: false,
        errorMessage: safeErrorMsg.slice(0, 240),
      });

      return {
        statusCode,
        headers: {
          'X-Request-ID': requestId,
          'X-Cache-Status': 'MISS',
        },
        body: {
          error: {
            message: safeErrorMsg,
            type: isTimeout ? 'timeout_error' : 'upstream_provider_error',
            code: isTimeout ? 'provider_timeout' : 'provider_unavailable',
          },
        },
        summary: {
          requestId,
          model: params.requestedModel,
          cacheType: 'NONE',
          similarityScore: cacheLookup.similarityScore,
          latencyMs: totalLatencyMs,
          estimatedCost: 0,
          estimatedSavings: 0,
          fallbackUsed: false,
        },
      };
    }
  }

  async function runWorkloadProbe(clientId = 'probe-service') {
    const scenarios: Array<{
      label: string;
      model: string;
      messages: ChatMessage[];
      simulatePrimaryFailure?: boolean;
    }> = [
      {
        label: 'Initial cold request: Machine Learning',
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Explain machine learning' }],
      },
      {
        label: 'Exact-match repeat: Machine Learning',
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Explain machine learning' }],
      },
      {
        label: 'Semantic paraphrase: Machine Learning',
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'What is machine learning in simple terms?' }],
      },
      {
        label: 'Initial cold request: Semantic Caching',
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Explain semantic caching with Redis embeddings' }],
      },
      {
        label: 'Semantic paraphrase: Semantic Caching',
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'How does Redis semantic cache work with embeddings?' }],
      },
      {
        label: 'Initial cold request: Gradient Descent',
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Explain gradient descent optimization' }],
      },
      {
        label: 'Semantic paraphrase: Gradient Descent',
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'How does gradient descent optimization work?' }],
      },
      {
        label: 'Fallback routing test: Primary 503 failover',
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Explain Kubernetes cluster orchestration' }],
        simulatePrimaryFailure: true,
      },
    ];

    const results = [];
    for (const s of scenarios) {
      const outcome = await executeProxyPipeline({
        clientId,
        requestedModel: s.model,
        messages: s.messages,
        temperature: 0.7,
        maxTokens: 512,
        allowFallback: true,
        simulatePrimaryFailure: s.simulatePrimaryFailure,
      });
      results.push({
        label: s.label,
        ...outcome.summary,
      });
    }
    return results;
  }

  // =========================================================================
  // Auth & Admin Claim Endpoints
  // =========================================================================
  app.get('/api/v1/auth/status', (req: Request, res: Response) => {
    const token = extractBearerOrApiKey(req);
    const session = token ? verifySessionToken(token) : null;
    res.json({
      configured: isAdminConfigured(db, config),
      envManaged: config.adminPasscode.length > 0,
      authenticated: Boolean(session),
    });
  });

  app.post('/api/v1/auth/claim', (req: Request, res: Response) => {
    if (isAdminConfigured(db, config)) {
      res.status(409).json({
        error: {
          message: 'Admin credentials are already configured.',
          type: 'conflict_error',
          code: 'admin_already_claimed',
        },
      });
      return;
    }

    const passcode = typeof req.body?.passcode === 'string' ? req.body.passcode.trim() : '';
    if (passcode.length < 8 || passcode.length > 128) {
      res.status(400).json({
        error: {
          message: 'Passcode must be between 8 and 128 characters.',
          type: 'invalid_request_error',
          code: 'invalid_passcode',
        },
      });
      return;
    }

    const hash = hashPassword(passcode);
    const info = db.db
      .prepare('INSERT OR IGNORE INTO admin_auth (id, password_hash, created_at) VALUES (1, ?, ?)')
      .run(hash, new Date().toISOString());

    if (info.changes === 0) {
      res.status(409).json({
        error: {
          message: 'Admin credentials were claimed by another request.',
          type: 'conflict_error',
          code: 'admin_already_claimed',
        },
      });
      return;
    }

    const token = createSessionToken('admin');
    res.status(201).json({
      authenticated: true,
      token,
    });
  });

  app.post('/api/v1/auth/login', (req: Request, res: Response) => {
    if (!isAdminConfigured(db, config)) {
      res.status(400).json({
        error: {
          message: 'Admin credentials not claimed yet. Complete first-run setup.',
          type: 'invalid_request_error',
          code: 'admin_not_configured',
        },
      });
      return;
    }

    const passcode = typeof req.body?.passcode === 'string' ? req.body.passcode.trim() : '';
    if (!verifyAdminCredential(db, config, passcode)) {
      res.status(401).json({
        error: {
          message: 'Invalid admin passcode.',
          type: 'authentication_error',
          code: 'invalid_credentials',
        },
      });
      return;
    }

    const token = createSessionToken('admin');
    res.json({
      authenticated: true,
      token,
    });
  });

  // =========================================================================
  // Core Gateway Endpoint (OpenAI-Compatible)
  // =========================================================================
  app.post('/api/v1/chat/completions', async (req: Request, res: Response) => {
    const authClient = authenticateGatewayClient(db, config, req);
    if (!authClient) {
      res.status(401).json({
        error: {
          message: 'Valid client API key or authenticated operator session required.',
          type: 'authentication_error',
          code: 'unauthorized',
        },
      });
      return;
    }

    const body = (req.body || {}) as ChatCompletionBody;
    const messages = validateChatMessages(body.messages);
    if (!messages) {
      res.status(400).json({
        error: {
          message: 'Invalid "messages" array. Provide 1-64 messages with valid role and non-empty string content.',
          type: 'invalid_request_error',
          code: 'invalid_messages',
        },
      });
      return;
    }

    const requestedModel =
      typeof body.model === 'string' && body.model.trim().length > 0
        ? body.model.trim().slice(0, 64)
        : config.primaryModel;

    const temperature =
      typeof body.temperature === 'number' && Number.isFinite(body.temperature)
        ? Math.max(0, Math.min(2, body.temperature))
        : 0.7;

    const maxTokens =
      typeof body.max_tokens === 'number' && Number.isInteger(body.max_tokens) && body.max_tokens > 0
        ? body.max_tokens
        : undefined;

    const allowFallback = body.allow_fallback !== false;
    const bypassCache = req.header('x-bypass-cache') === 'true';
    const simulatePrimaryFailure = req.header('x-simulate-primary-failure') === 'true';
    const simulateTimeout = req.header('x-simulate-timeout') === 'true';

    const outcome = await executeProxyPipeline({
      clientId: authClient.clientId,
      clientRpmOverride: authClient.rpmLimit,
      requestedModel,
      messages,
      temperature,
      maxTokens,
      allowFallback,
      bypassCache,
      simulatePrimaryFailure,
      simulateTimeout,
    });

    for (const [k, v] of Object.entries(outcome.headers)) {
      res.setHeader(k, v);
    }
    res.status(outcome.statusCode).json(outcome.body);
  });

  // =========================================================================
  // Health & System Status Endpoints
  // =========================================================================
  app.get('/api/v1/health', (_req: Request, res: Response) => {
    let dbOk = false;
    try {
      db.db.prepare('SELECT 1').get();
      dbOk = true;
    } catch {
      dbOk = false;
    }

    res.status(dbOk ? 200 : 503).json({
      status: dbOk ? 'healthy' : 'degraded',
      service: 'cost-latency-guardrail-proxy',
      timestamp: new Date().toISOString(),
      database: dbOk ? 'connected' : 'disconnected',
      providerMode: config.mockProviderMode ? 'mock-local' : 'live-upstream',
    });
  });

  app.get('/api/v1/system/status', (_req: Request, res: Response) => {
    let dbStatus = 'connected';
    try {
      db.db.prepare('SELECT 1').get();
    } catch {
      dbStatus = 'error';
    }

    const providers = db.getProviders();
    const enabledCount = providers.filter((p) => p.enabled === 1).length;
    const cacheStats = cache.getStats();

    res.json({
      gateway: {
        status: 'online',
        runtime: 'express-node-sqlite',
        primaryModel: config.primaryModel,
        fallbackModel: config.fallbackModel,
        providerMode: config.mockProviderMode ? 'mock-local' : 'live-upstream',
        openAiConfigured: Boolean(config.openAiApiKey),
        geminiConfigured: Boolean(config.geminiApiKey),
      },
      cache: {
        engine: 'sqlite-vector-index (redis-compatible)',
        status: 'connected',
        cachedEntries: cacheStats.cachedPromptCount,
        hitRatio: cacheStats.hitRatio,
      },
      database: {
        engine: 'SQLite WAL',
        status: dbStatus,
      },
      providers: {
        configured: providers.length,
        enabled: enabledCount,
        status: enabledCount > 0 ? 'ready' : 'unavailable',
      },
      monitoring: {
        prometheusEndpoint: '/metrics',
        status: 'available',
      },
      timestamp: new Date().toISOString(),
    });
  });

  // =========================================================================
  // Analytics Endpoints
  // =========================================================================
  app.get('/api/v1/analytics/overview', (_req: Request, res: Response) => {
    const agg = db.db
      .prepare(`
        SELECT
          COUNT(*) as total_requests,
          SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successful_requests,
          SUM(CASE WHEN status != 'success' THEN 1 ELSE 0 END) as failed_requests,
          SUM(CASE WHEN cache_hit = 1 THEN 1 ELSE 0 END) as cache_hits,
          SUM(CASE WHEN cache_type = 'EXACT' THEN 1 ELSE 0 END) as exact_hits,
          SUM(CASE WHEN cache_type = 'SEMANTIC' THEN 1 ELSE 0 END) as semantic_hits,
          COALESCE(SUM(total_tokens), 0) as total_tokens,
          COALESCE(SUM(input_tokens), 0) as input_tokens,
          COALESCE(SUM(output_tokens), 0) as output_tokens,
          COALESCE(SUM(estimated_cost), 0) as total_cost,
          COALESCE(SUM(estimated_savings), 0) as total_savings,
          COALESCE(AVG(latency_ms), 0) as avg_latency_ms,
          SUM(CASE WHEN fallback_used = 1 THEN 1 ELSE 0 END) as fallback_count
        FROM api_requests
      `)
      .get() as {
        total_requests: number;
        successful_requests: number | null;
        failed_requests: number | null;
        cache_hits: number | null;
        exact_hits: number | null;
        semantic_hits: number | null;
        total_tokens: number;
        input_tokens: number;
        output_tokens: number;
        total_cost: number;
        total_savings: number;
        avg_latency_ms: number;
        fallback_count: number | null;
      };

    const latencies = (
      db.db
        .prepare('SELECT latency_ms FROM api_requests ORDER BY latency_ms ASC')
        .all() as Array<{ latency_ms: number }>
    ).map((r) => r.latency_ms);

    const hitLatencies = (
      db.db
        .prepare('SELECT latency_ms FROM api_requests WHERE cache_hit = 1 ORDER BY latency_ms ASC')
        .all() as Array<{ latency_ms: number }>
    ).map((r) => r.latency_ms);

    const missLatencies = (
      db.db
        .prepare(
          "SELECT latency_ms FROM api_requests WHERE cache_hit = 0 AND status = 'success' ORDER BY latency_ms ASC"
        )
        .all() as Array<{ latency_ms: number }>
    ).map((r) => r.latency_ms);

    const totalRequests = agg.total_requests || 0;
    const cacheHits = agg.cache_hits || 0;

    // Recent timeseries grouped by minute or sequence bucket for chart visualization
    const recentRequests = db.db
      .prepare(`
        SELECT request_id, model, latency_ms, cache_hit, cache_type, estimated_cost, estimated_savings, total_tokens, created_at
        FROM api_requests
        ORDER BY id DESC
        LIMIT 40
      `)
      .all() as Array<{
        request_id: string;
        model: string;
        latency_ms: number;
        cache_hit: number;
        cache_type: string;
        estimated_cost: number;
        estimated_savings: number;
        total_tokens: number;
        created_at: string;
      }>;

    res.json({
      totalRequests,
      successfulRequests: agg.successful_requests || 0,
      failedRequests: agg.failed_requests || 0,
      cacheHits,
      exactHits: agg.exact_hits || 0,
      semanticHits: agg.semantic_hits || 0,
      cacheHitRatio: totalRequests > 0 ? Number((cacheHits / totalRequests).toFixed(4)) : 0,
      totalTokens: agg.total_tokens,
      inputTokens: agg.input_tokens,
      outputTokens: agg.output_tokens,
      estimatedCostUsd: Number(agg.total_cost.toFixed(6)),
      estimatedSavingsUsd: Number(agg.total_savings.toFixed(6)),
      avgLatencyMs: Number(agg.avg_latency_ms.toFixed(2)),
      p50LatencyMs: computePercentile(latencies, 50),
      p95LatencyMs: computePercentile(latencies, 95),
      avgCacheHitLatencyMs:
        hitLatencies.length > 0
          ? Number((hitLatencies.reduce((a, b) => a + b, 0) / hitLatencies.length).toFixed(2))
          : 0,
      avgCacheMissLatencyMs:
        missLatencies.length > 0
          ? Number((missLatencies.reduce((a, b) => a + b, 0) / missLatencies.length).toFixed(2))
          : 0,
      fallbackCount: agg.fallback_count || 0,
      costNote: 'Estimated expenditure & savings calculated from configured model token rates.',
      timeline: recentRequests.reverse().map((r, index) => ({
        seq: index + 1,
        requestId: r.request_id,
        time: r.created_at.slice(11, 19),
        model: r.model,
        latencyMs: r.latency_ms,
        cacheHit: r.cache_hit === 1,
        cacheType: r.cache_type,
        costUsd: Number(r.estimated_cost.toFixed(6)),
        savingsUsd: Number(r.estimated_savings.toFixed(6)),
        tokens: r.total_tokens,
      })),
    });
  });

  app.get('/api/v1/analytics/requests', (req: Request, res: Response) => {
    const limitRaw = Number(req.query.limit || 100);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, limitRaw)) : 100;
    const statusFilter = typeof req.query.status === 'string' ? req.query.status : 'all';
    const cacheFilter = typeof req.query.cache === 'string' ? req.query.cache : 'all';

    let sql = 'SELECT * FROM api_requests WHERE 1=1';
    const params: Array<string | number> = [];

    if (statusFilter === 'success' || statusFilter === 'error' || statusFilter === 'rejected') {
      sql += ' AND status = ?';
      params.push(statusFilter);
    }
    if (cacheFilter === 'hit') {
      sql += ' AND cache_hit = 1';
    } else if (cacheFilter === 'miss') {
      sql += ' AND cache_hit = 0';
    }

    sql += ' ORDER BY id DESC LIMIT ?';
    params.push(limit);

    const rows = db.db.prepare(sql).all(...params);
    res.json({ requests: rows });
  });

  app.get('/api/v1/analytics/costs', (_req: Request, res: Response) => {
    const { dailySpendUsd, monthlySpendUsd } = costTracker.getSpendTotals();

    const byModel = db.db
      .prepare(`
        SELECT
          model,
          COUNT(*) as requests,
          SUM(CASE WHEN cache_hit = 1 THEN 1 ELSE 0 END) as cache_hits,
          COALESCE(SUM(input_tokens), 0) as input_tokens,
          COALESCE(SUM(output_tokens), 0) as output_tokens,
          COALESCE(SUM(estimated_cost), 0) as estimated_cost,
          COALESCE(SUM(estimated_savings), 0) as estimated_savings
        FROM api_requests
        GROUP BY model
        ORDER BY estimated_cost DESC
      `)
      .all() as Array<{
        model: string;
        requests: number;
        cache_hits: number;
        input_tokens: number;
        output_tokens: number;
        estimated_cost: number;
        estimated_savings: number;
      }>;

    const dailySeries = db.db
      .prepare(`
        SELECT
          date,
          COALESCE(SUM(total_requests), 0) as requests,
          COALESCE(SUM(cache_hits), 0) as cache_hits,
          COALESCE(SUM(total_tokens), 0) as tokens,
          COALESCE(SUM(total_cost), 0) as cost_usd,
          COALESCE(SUM(total_savings), 0) as savings_usd
        FROM usage_statistics
        GROUP BY date
        ORDER BY date ASC
        LIMIT 30
      `)
      .all();

    res.json({
      dailySpendUsd,
      monthlySpendUsd,
      byModel: byModel.map((m) => ({
        model: m.model,
        requests: m.requests,
        cacheHits: m.cache_hits,
        inputTokens: m.input_tokens,
        outputTokens: m.output_tokens,
        estimatedCostUsd: Number(m.estimated_cost.toFixed(6)),
        estimatedSavingsUsd: Number(m.estimated_savings.toFixed(6)),
      })),
      dailySeries,
      disclaimer:
        'Figures represent estimated API costs and avoided expenditure derived from configured per-model pricing, not provider invoice totals.',
    });
  });

  app.get('/api/v1/analytics/tokens', (_req: Request, res: Response) => {
    const byModel = db.db
      .prepare(`
        SELECT
          model,
          COALESCE(SUM(input_tokens), 0) as input_tokens,
          COALESCE(SUM(output_tokens), 0) as output_tokens,
          COALESCE(SUM(total_tokens), 0) as total_tokens,
          COALESCE(SUM(CASE WHEN cache_hit = 1 THEN total_tokens ELSE 0 END), 0) as cached_tokens,
          COALESCE(SUM(CASE WHEN cache_hit = 0 THEN total_tokens ELSE 0 END), 0) as upstream_tokens
        FROM api_requests
        GROUP BY model
        ORDER BY total_tokens DESC
      `)
      .all();

    res.json({ byModel });
  });

  // =========================================================================
  // Cache Management Endpoints
  // =========================================================================
  app.get('/api/v1/cache/stats', (_req: Request, res: Response) => {
    const cfg = db.getGuardrailConfig();
    const stats = cache.getStats();
    res.json({
      ...stats,
      ttlSeconds: cfg.cache_ttl_seconds,
      similarityThreshold: cfg.similarity_threshold,
    });
  });

  app.delete('/api/v1/cache/clear', requireAdmin, (_req: Request, res: Response) => {
    const clearedCount = cache.clearAll();
    res.json({
      cleared: true,
      entriesRemoved: clearedCount,
      timestamp: new Date().toISOString(),
    });
  });

  // =========================================================================
  // Guardrails & Provider Config Endpoints
  // =========================================================================
  app.get('/api/v1/guardrails/status', (_req: Request, res: Response) => {
    res.json(guardrails.getStatus());
  });

  app.post('/api/v1/guardrails/config', requireAdmin, (req: Request, res: Response) => {
    const current = db.getGuardrailConfig();
    const body = req.body || {};

    const dailyBudget =
      typeof body.daily_budget === 'number' && body.daily_budget > 0
        ? body.daily_budget
        : current.daily_budget;
    const monthlyBudget =
      typeof body.monthly_budget === 'number' && body.monthly_budget > 0
        ? body.monthly_budget
        : current.monthly_budget;
    const requestsPerMinute =
      typeof body.requests_per_minute === 'number' &&
      Number.isInteger(body.requests_per_minute) &&
      body.requests_per_minute > 0
        ? body.requests_per_minute
        : current.requests_per_minute;
    const maxTokens =
      typeof body.max_tokens === 'number' && Number.isInteger(body.max_tokens) && body.max_tokens >= 64
        ? body.max_tokens
        : current.max_tokens;
    const similarityThreshold =
      typeof body.similarity_threshold === 'number' &&
      body.similarity_threshold >= 0.5 &&
      body.similarity_threshold <= 0.99
        ? body.similarity_threshold
        : current.similarity_threshold;
    const cacheTtlSeconds =
      typeof body.cache_ttl_seconds === 'number' &&
      Number.isInteger(body.cache_ttl_seconds) &&
      body.cache_ttl_seconds >= 30
        ? body.cache_ttl_seconds
        : current.cache_ttl_seconds;
    const fallbackEnabled =
      typeof body.fallback_enabled === 'boolean'
        ? body.fallback_enabled
          ? 1
          : 0
        : current.fallback_enabled;
    const requestTimeoutMs =
      typeof body.request_timeout_ms === 'number' &&
      Number.isInteger(body.request_timeout_ms) &&
      body.request_timeout_ms >= 500
        ? body.request_timeout_ms
        : current.request_timeout_ms;
    const maxRetries =
      typeof body.max_retries === 'number' &&
      Number.isInteger(body.max_retries) &&
      body.max_retries >= 0 &&
      body.max_retries <= 5
        ? body.max_retries
        : current.max_retries;

    db.db
      .prepare(`
        UPDATE guardrail_config SET
          daily_budget = ?,
          monthly_budget = ?,
          requests_per_minute = ?,
          max_tokens = ?,
          similarity_threshold = ?,
          cache_ttl_seconds = ?,
          fallback_enabled = ?,
          request_timeout_ms = ?,
          max_retries = ?,
          updated_at = ?
        WHERE id = 1
      `)
      .run(
        dailyBudget,
        monthlyBudget,
        requestsPerMinute,
        maxTokens,
        similarityThreshold,
        cacheTtlSeconds,
        fallbackEnabled,
        requestTimeoutMs,
        maxRetries,
        new Date().toISOString()
      );

    res.json(guardrails.getStatus());
  });

  app.get('/api/v1/providers', (_req: Request, res: Response) => {
    res.json({
      primaryModel: config.primaryModel,
      fallbackModel: config.fallbackModel,
      providerMode: config.mockProviderMode ? 'mock-local' : 'live-upstream',
      providers: db.getProviders(),
    });
  });

  app.post('/api/v1/providers/config', requireAdmin, (req: Request, res: Response) => {
    const modelName = typeof req.body?.model_name === 'string' ? req.body.model_name.trim() : '';
    const existing = db.getProviderByModel(modelName);
    if (!existing) {
      res.status(404).json({
        error: {
          message: `Provider model "${modelName}" not found.`,
          type: 'invalid_request_error',
          code: 'model_not_found',
        },
      });
      return;
    }

    const enabled =
      typeof req.body?.enabled === 'boolean' ? (req.body.enabled ? 1 : 0) : existing.enabled;
    const priority =
      typeof req.body?.priority === 'number' && Number.isInteger(req.body.priority)
        ? req.body.priority
        : existing.priority;

    db.db
      .prepare('UPDATE provider_config SET enabled = ?, priority = ? WHERE model_name = ?')
      .run(enabled, priority, modelName);

    res.json({
      providers: db.getProviders(),
    });
  });

  // =========================================================================
  // Internal Client API Key Management (Admin Protected)
  // =========================================================================
  app.get('/api/v1/clients/keys', requireAdmin, (_req: Request, res: Response) => {
    const keys = db.db
      .prepare(
        'SELECT id, key_name, client_id, key_prefix, rpm_limit, enabled, created_at, last_used_at FROM client_keys ORDER BY id DESC'
      )
      .all();
    res.json({ keys });
  });

  app.post('/api/v1/clients/keys', requireAdmin, (req: Request, res: Response) => {
    const keyName =
      typeof req.body?.key_name === 'string' && req.body.key_name.trim()
        ? req.body.key_name.trim().slice(0, 64)
        : 'Internal Service';
    const clientId =
      typeof req.body?.client_id === 'string' && req.body.client_id.trim()
        ? req.body.client_id.trim().slice(0, 64)
        : `client-${crypto.randomBytes(3).toString('hex')}`;
    const rpmLimit =
      typeof req.body?.rpm_limit === 'number' && Number.isInteger(req.body.rpm_limit) && req.body.rpm_limit > 0
        ? req.body.rpm_limit
        : 60;

    const rawKey = `clgp_${crypto.randomBytes(24).toString('hex')}`;
    const keyHash = sha256Hex(rawKey);
    const keyPrefix = `${rawKey.slice(0, 11)}...`;

    db.db
      .prepare(`
        INSERT INTO client_keys (key_name, client_id, key_hash, key_prefix, rpm_limit, enabled, created_at)
        VALUES (?, ?, ?, ?, ?, 1, ?)
      `)
      .run(keyName, clientId, keyHash, keyPrefix, rpmLimit, new Date().toISOString());

    res.status(201).json({
      key_name: keyName,
      client_id: clientId,
      key_prefix: keyPrefix,
      raw_key: rawKey,
      note: 'Store this key securely now; only the SHA-256 hash is retained on the server.',
    });
  });

  app.delete('/api/v1/clients/keys/:id', requireAdmin, (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: { message: 'Invalid key id' } });
      return;
    }
    db.db.prepare('DELETE FROM client_keys WHERE id = ?').run(id);
    res.json({ deleted: true, id });
  });

  // =========================================================================
  // Live Workload Probe (Executes real requests through the proxy pipeline)
  // =========================================================================
  app.post('/api/v1/workload/probe', requireAdmin, async (_req: Request, res: Response) => {
    const results = await runWorkloadProbe('gateway-probe');
    res.json({ executed: results.length, results });
  });

  // =========================================================================
  // Prometheus Metrics Endpoint
  // =========================================================================
  app.get('/metrics', (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(generatePrometheusMetrics(db));
  });

  // Initial genuine pipeline smoke workload on fresh empty DB (unless disabled for tests)
  if (options?.seedInitialProbe !== false) {
    const countRow = db.db
      .prepare('SELECT COUNT(*) as count FROM api_requests')
      .get() as { count: number };
    if (countRow.count === 0) {
      void runWorkloadProbe('initial-smoke-probe');
    }
  }

  return {
    app,
    config,
    db,
    cache,
    costTracker,
    guardrails,
    router: llmRouter,
    runWorkloadProbe,
  };
}
