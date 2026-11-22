import { GoogleGenAI } from '@google/genai';
import type { AppConfig } from './config.ts';
import type { ProxyDatabase } from './database.ts';
import { estimateTokenCount } from './embedding.ts';
import { isSafeExternalUrl } from './security.ts';
import type { ChatMessage } from './semanticCache.ts';

export interface RouteRequestParams {
  requestedModel: string;
  messages: ChatMessage[];
  temperature: number;
  maxTokens?: number;
  allowFallback: boolean;
  simulatePrimaryFailure?: boolean;
  simulateTimeout?: boolean;
}

export interface RouteResult {
  content: string;
  modelUsed: string;
  providerUsed: string;
  inputTokens: number;
  outputTokens: number;
  fallbackUsed: boolean;
  attempts: number;
}

const KNOWLEDGE_TOPICS: Array<{ keywords: string[]; answer: string }> = [
  {
    keywords: ['machine learning', 'ml'],
    answer:
      'Machine learning is a subfield of artificial intelligence where statistical models learn patterns from historical data rather than following hardcoded rules. During training, an optimization loop minimizes a loss function over labeled or unlabeled examples so the resulting model generalizes to unseen inputs at inference time.',
  },
  {
    keywords: ['semantic cache', 'semantic caching', 'redis', 'embedding', 'cosine'],
    answer:
      'Semantic caching stores dense vector embeddings of previous prompts alongside their generated completions. Incoming prompts are embedded and compared via cosine similarity against stored vectors; when similarity exceeds the configured threshold under compatible model settings, the cached completion is served in milliseconds without calling an upstream LLM.',
  },
  {
    keywords: ['gradient descent', 'optimization', 'backprop'],
    answer:
      'Gradient descent iteratively updates model parameters in the opposite direction of the loss function gradient with respect to those parameters. Controlled by a learning rate schedule, each step reduces prediction error until convergence at a local or global minimum.',
  },
  {
    keywords: ['kubernetes', 'k8s', 'container', 'docker'],
    answer:
      'Kubernetes orchestrates containerized workloads across clusters by declarative desired-state reconciliation. It automates pod scheduling, horizontal autoscaling, health probes, rolling deployments, and service discovery across distributed nodes.',
  },
  {
    keywords: ['sql', 'postgres', 'postgresql', 'database', 'index'],
    answer:
      'Relational databases enforce structured schemas, ACID transactions, and declarative SQL querying. B-tree and GIN indexes accelerate selective lookups and joins while query planners optimize execution paths based on table cardinality statistics.',
  },
  {
    keywords: ['latency', 'p95', 'p99', 'observability', 'prometheus'],
    answer:
      'Tail latency metrics such as P95 and P99 capture worst-case user experience that averages conceal. Prometheus histograms aggregate request durations into cumulative buckets so Grafana dashboards can track tail latency spikes alongside cache hit ratios and upstream error rates.',
  },
];

function buildMockResponseText(messages: ChatMessage[], model: string): string {
  const userMessages = messages.filter((m) => m.role === 'user');
  const latestPrompt = userMessages[userMessages.length - 1]?.content.trim() || '';
  const lower = latestPrompt.toLowerCase();

  for (const topic of KNOWLEDGE_TOPICS) {
    if (topic.keywords.some((kw) => lower.includes(kw))) {
      return `${topic.answer} (Served via ${model} in local mock provider mode.)`;
    }
  }

  return `Processed request "${latestPrompt.slice(0, 120)}" using ${model} via Cost & Latency Guardrail Proxy local provider mode. Configure OPENAI_API_KEY or GEMINI_API_KEY in server environment variables to route directly to live upstream models.`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class LLMRouterService {
  private config: AppConfig;
  private db: ProxyDatabase;

  constructor(config: AppConfig, db: ProxyDatabase) {
    this.config = config;
    this.db = db;
  }

  private async invokeSingleModel(params: {
    model: string;
    messages: ChatMessage[];
    temperature: number;
    maxTokens?: number;
    timeoutMs: number;
    simulateFailure?: boolean;
    simulateTimeout?: boolean;
  }): Promise<{
    content: string;
    provider: string;
    inputTokens: number;
    outputTokens: number;
  }> {
    if (params.simulateTimeout) {
      await sleep(Math.min(params.timeoutMs + 40, 400));
      throw new Error(`Provider request timed out after ${params.timeoutMs}ms`);
    }

    if (params.simulateFailure) {
      throw new Error(`Simulated upstream 503 failure for model ${params.model}`);
    }

    const providerRow = this.db.getProviderByModel(params.model);
    if (providerRow && providerRow.enabled === 0) {
      throw new Error(`Model ${params.model} is disabled in provider configuration`);
    }

    // 1. Live Google Gemini API if configured and requested (and mock mode off)
    if (
      !this.config.mockProviderMode &&
      this.config.geminiApiKey &&
      params.model.startsWith('gemini-')
    ) {
      const ai = new GoogleGenAI({ apiKey: this.config.geminiApiKey });
      const systemInstruction = params.messages
        .filter((m) => m.role === 'system')
        .map((m) => m.content)
        .join('\n');
      const promptBody = params.messages
        .filter((m) => m.role !== 'system')
        .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
        .join('\n');

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), params.timeoutMs);
      try {
        const targetGeminiModel = params.model.startsWith('gemini-')
          ? params.model
          : 'gemini-2.5-flash';
        const response = await ai.models.generateContent({
          model: targetGeminiModel,
          contents: promptBody,
          config: {
            systemInstruction: systemInstruction || undefined,
            temperature: params.temperature,
            maxOutputTokens: params.maxTokens,
          },
        });
        const text = response.text || '';
        const inputTokens =
          response.usageMetadata?.promptTokenCount ?? estimateTokenCount(promptBody);
        const outputTokens =
          response.usageMetadata?.candidatesTokenCount ?? estimateTokenCount(text);

        return {
          content: text,
          provider: 'google-gemini',
          inputTokens,
          outputTokens,
        };
      } finally {
        clearTimeout(timer);
      }
    }

    // 2. Live OpenAI-compatible API if configured (and mock mode off)
    if (!this.config.mockProviderMode && this.config.openAiApiKey) {
      if (!isSafeExternalUrl(this.config.openAiBaseUrl)) {
        throw new Error('Blocked unsafe OPENAI_BASE_URL destination.');
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), params.timeoutMs);
      try {
        const res = await fetch(`${this.config.openAiBaseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.config.openAiApiKey}`,
          },
          body: JSON.stringify({
            model: params.model,
            messages: params.messages,
            temperature: params.temperature,
            max_tokens: params.maxTokens,
          }),
          signal: controller.signal,
        });
        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`Upstream provider error (${res.status}): ${errText.slice(0, 200)}`);
        }
        const data = (await res.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const content = data.choices?.[0]?.message?.content || '';
        const inputTokens =
          data.usage?.prompt_tokens ??
          estimateTokenCount(params.messages.map((m) => m.content).join(' '));
        const outputTokens = data.usage?.completion_tokens ?? estimateTokenCount(content);
        return {
          content,
          provider: providerRow?.provider_name || 'openai',
          inputTokens,
          outputTokens,
        };
      } finally {
        clearTimeout(timer);
      }
    }

    // 3. Local Mock Provider Mode (realistic simulated upstream latency)
    const simulatedDelayMs = params.model.includes('mini') || params.model.includes('flash')
      ? 85 + Math.floor(Math.random() * 55)
      : 165 + Math.floor(Math.random() * 95);
    await sleep(simulatedDelayMs);

    const content = buildMockResponseText(params.messages, params.model);
    const inputText = params.messages.map((m) => m.content).join(' ');
    const inputTokens = estimateTokenCount(inputText) + params.messages.length * 4;
    const outputTokens = estimateTokenCount(content);

    return {
      content,
      provider: `mock-${providerRow?.provider_name || 'openai'}`,
      inputTokens,
      outputTokens,
    };
  }

  public async routeAndExecute(params: RouteRequestParams): Promise<RouteResult> {
    const guardrailCfg = this.db.getGuardrailConfig();
    const providers = this.db.getProviders().filter((p) => p.enabled === 1);
    const fallbackAllowed = guardrailCfg.fallback_enabled === 1 && params.allowFallback;

    const primaryModel = params.requestedModel || this.config.primaryModel;
    const fallbackModel =
      providers.find((p) => p.model_name === this.config.fallbackModel)?.model_name ||
      providers.find((p) => p.model_name !== primaryModel)?.model_name ||
      this.config.fallbackModel;

    const maxRetries = Math.max(0, Math.min(3, guardrailCfg.max_retries));
    const timeoutMs = guardrailCfg.request_timeout_ms;

    let attempts = 0;
    let lastError: Error | null = null;

    // Attempt primary model with controlled retry policy
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      attempts += 1;
      try {
        const res = await this.invokeSingleModel({
          model: primaryModel,
          messages: params.messages,
          temperature: params.temperature,
          maxTokens: params.maxTokens,
          timeoutMs,
          simulateFailure: params.simulatePrimaryFailure,
          simulateTimeout: params.simulateTimeout,
        });
        return {
          content: res.content,
          modelUsed: primaryModel,
          providerUsed: res.provider,
          inputTokens: res.inputTokens,
          outputTokens: res.outputTokens,
          fallbackUsed: false,
          attempts,
        };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < maxRetries && !params.simulateTimeout) {
          await sleep(60 * (attempt + 1));
        }
      }
    }

    // Attempt fallback model if enabled and distinct
    if (fallbackAllowed && fallbackModel && fallbackModel !== primaryModel) {
      attempts += 1;
      const res = await this.invokeSingleModel({
        model: fallbackModel,
        messages: params.messages,
        temperature: params.temperature,
        maxTokens: params.maxTokens,
        timeoutMs,
        simulateFailure: false,
        simulateTimeout: false,
      });
      return {
        content: res.content,
        modelUsed: fallbackModel,
        providerUsed: res.provider,
        inputTokens: res.inputTokens,
        outputTokens: res.outputTokens,
        fallbackUsed: true,
        attempts,
      };
    }

    throw lastError || new Error('All configured LLM providers failed');
  }
}
