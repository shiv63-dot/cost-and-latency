export interface ModelPricing {
  provider: string;
  model: string;
  inputPricePer1M: number;
  outputPricePer1M: number;
  maxTokensLimit: number;
}

export const DEFAULT_MODEL_PRICING: Record<string, ModelPricing> = {
  'gpt-4o': {
    provider: 'openai',
    model: 'gpt-4o',
    inputPricePer1M: 2.5,
    outputPricePer1M: 10.0,
    maxTokensLimit: 128000,
  },
  'gpt-4o-mini': {
    provider: 'openai',
    model: 'gpt-4o-mini',
    inputPricePer1M: 0.15,
    outputPricePer1M: 0.6,
    maxTokensLimit: 128000,
  },
  'gpt-4.1-mini': {
    provider: 'openai',
    model: 'gpt-4.1-mini',
    inputPricePer1M: 0.4,
    outputPricePer1M: 1.6,
    maxTokensLimit: 128000,
  },
  'gemini-2.5-flash': {
    provider: 'google',
    model: 'gemini-2.5-flash',
    inputPricePer1M: 0.15,
    outputPricePer1M: 0.6,
    maxTokensLimit: 1000000,
  },
  'claude-3-5-sonnet': {
    provider: 'anthropic-compat',
    model: 'claude-3-5-sonnet',
    inputPricePer1M: 3.0,
    outputPricePer1M: 15.0,
    maxTokensLimit: 200000,
  },
};

export interface AppConfig {
  port: number;
  nodeEnv: string;
  sqlitePath: string;
  openAiApiKey: string;
  openAiBaseUrl: string;
  geminiApiKey: string;
  mockProviderMode: boolean;
  primaryModel: string;
  fallbackModel: string;
  fallbackEnabled: boolean;
  requestTimeoutMs: number;
  maxRetries: number;
  adminPasscode: string;
  proxyClientApiKey: string;
  semanticSimilarityThreshold: number;
  cacheTtlSeconds: number;
  defaultDailyBudgetUsd: number;
  defaultMonthlyBudgetUsd: number;
  defaultRequestsPerMinute: number;
  defaultMaxTokens: number;
  logPrompts: boolean;
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return value.toLowerCase() === 'true' || value === '1';
}

function isPlaceholderKey(val: string): boolean {
  return !val || val.startsWith('MY_') || val === 'changeme';
}

export function loadConfig(): AppConfig {
  const rawOpenAi = process.env.OPENAI_API_KEY?.trim() || '';
  const rawGemini = process.env.GEMINI_API_KEY?.trim() || '';
  const openAiApiKey = isPlaceholderKey(rawOpenAi) ? '' : rawOpenAi;
  const geminiApiKey = isPlaceholderKey(rawGemini) ? '' : rawGemini;
  const explicitMock = process.env.MOCK_PROVIDER_MODE;

  return {
    port: parseNumber(process.env.PORT, 3000),
    nodeEnv: process.env.NODE_ENV || 'development',
    sqlitePath: process.env.SQLITE_PATH || './data/proxy.db',
    openAiApiKey,
    openAiBaseUrl: (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
    geminiApiKey,
    mockProviderMode: explicitMock !== undefined && explicitMock !== ''
      ? parseBool(explicitMock, true)
      : !openAiApiKey,
    primaryModel: process.env.PRIMARY_MODEL || 'gpt-4o',
    fallbackModel: process.env.FALLBACK_MODEL || 'gpt-4o-mini',
    fallbackEnabled: parseBool(process.env.FALLBACK_ENABLED, true),
    requestTimeoutMs: parseNumber(process.env.REQUEST_TIMEOUT_MS, 15000),
    maxRetries: parseNumber(process.env.MAX_RETRIES, 2),
    adminPasscode: process.env.ADMIN_PASSCODE?.trim() || '',
    proxyClientApiKey: process.env.PROXY_CLIENT_API_KEY?.trim() || '',
    semanticSimilarityThreshold: parseNumber(process.env.SEMANTIC_SIMILARITY_THRESHOLD, 0.84),
    cacheTtlSeconds: parseNumber(process.env.CACHE_TTL_SECONDS, 3600),
    defaultDailyBudgetUsd: parseNumber(process.env.DEFAULT_DAILY_BUDGET_USD, 25.0),
    defaultMonthlyBudgetUsd: parseNumber(process.env.DEFAULT_MONTHLY_BUDGET_USD, 500.0),
    defaultRequestsPerMinute: parseNumber(process.env.DEFAULT_REQUESTS_PER_MINUTE, 60),
    defaultMaxTokens: parseNumber(process.env.DEFAULT_MAX_TOKENS, 4096),
    logPrompts: parseBool(process.env.LOG_PROMPTS, false),
  };
}
