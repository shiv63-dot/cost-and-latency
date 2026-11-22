import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type AppConfig, DEFAULT_MODEL_PRICING } from './config.ts';

export interface GuardrailConfigRow {
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
}

export interface ProviderConfigRow {
  id: number;
  provider_name: string;
  model_name: string;
  enabled: number;
  priority: number;
  input_price_per_1m: number;
  output_price_per_1m: number;
  max_tokens_limit: number;
}

export class ProxyDatabase {
  public readonly db: DatabaseSync;

  constructor(dbPath: string, config: AppConfig) {
    if (dbPath !== ':memory:') {
      const dir = path.dirname(path.resolve(dbPath));
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.initializeSchema();
    this.seedDefaults(config);
  }

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS api_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL UNIQUE,
        client_id TEXT NOT NULL,
        model TEXT NOT NULL,
        requested_model TEXT NOT NULL,
        status TEXT NOT NULL,
        status_code INTEGER NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        estimated_cost REAL NOT NULL DEFAULT 0,
        estimated_savings REAL NOT NULL DEFAULT 0,
        latency_ms REAL NOT NULL DEFAULT 0,
        cache_lookup_ms REAL NOT NULL DEFAULT 0,
        cache_hit INTEGER NOT NULL DEFAULT 0,
        cache_type TEXT NOT NULL DEFAULT 'NONE',
        similarity_score REAL,
        provider TEXT NOT NULL,
        fallback_used INTEGER NOT NULL DEFAULT 0,
        error_message TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_api_requests_created_at ON api_requests(created_at);
      CREATE INDEX IF NOT EXISTS idx_api_requests_client_id ON api_requests(client_id);
      CREATE INDEX IF NOT EXISTS idx_api_requests_model ON api_requests(model);
      CREATE INDEX IF NOT EXISTS idx_api_requests_cache_hit ON api_requests(cache_hit);

      CREATE TABLE IF NOT EXISTS usage_statistics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id TEXT NOT NULL,
        date TEXT NOT NULL,
        total_requests INTEGER NOT NULL DEFAULT 0,
        cache_hits INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        total_cost REAL NOT NULL DEFAULT 0,
        total_savings REAL NOT NULL DEFAULT 0,
        UNIQUE(client_id, date)
      );

      CREATE INDEX IF NOT EXISTS idx_usage_stats_date ON usage_statistics(date);

      CREATE TABLE IF NOT EXISTS guardrail_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        daily_budget REAL NOT NULL,
        monthly_budget REAL NOT NULL,
        requests_per_minute INTEGER NOT NULL,
        max_tokens INTEGER NOT NULL,
        similarity_threshold REAL NOT NULL,
        cache_ttl_seconds INTEGER NOT NULL,
        fallback_enabled INTEGER NOT NULL DEFAULT 1,
        request_timeout_ms INTEGER NOT NULL DEFAULT 15000,
        max_retries INTEGER NOT NULL DEFAULT 2,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS provider_config (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider_name TEXT NOT NULL,
        model_name TEXT NOT NULL UNIQUE,
        enabled INTEGER NOT NULL DEFAULT 1,
        priority INTEGER NOT NULL DEFAULT 10,
        input_price_per_1m REAL NOT NULL,
        output_price_per_1m REAL NOT NULL,
        max_tokens_limit INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cache_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        exact_hash TEXT NOT NULL UNIQUE,
        settings_hash TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt_preview TEXT NOT NULL,
        embedding_json TEXT NOT NULL,
        response_json TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        hit_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_cache_settings_expires ON cache_entries(settings_hash, expires_at);

      CREATE TABLE IF NOT EXISTS admin_auth (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS client_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key_name TEXT NOT NULL,
        client_id TEXT NOT NULL,
        key_hash TEXT NOT NULL UNIQUE,
        key_prefix TEXT NOT NULL,
        rpm_limit INTEGER NOT NULL DEFAULT 60,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        last_used_at TEXT
      );
    `);
  }

  private seedDefaults(config: AppConfig): void {
    const existingGuardrail = this.db
      .prepare('SELECT id FROM guardrail_config WHERE id = 1')
      .get();
    if (!existingGuardrail) {
      this.db
        .prepare(`
          INSERT INTO guardrail_config (
            id, daily_budget, monthly_budget, requests_per_minute, max_tokens,
            similarity_threshold, cache_ttl_seconds, fallback_enabled,
            request_timeout_ms, max_retries, updated_at
          ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          config.defaultDailyBudgetUsd,
          config.defaultMonthlyBudgetUsd,
          config.defaultRequestsPerMinute,
          config.defaultMaxTokens,
          config.semanticSimilarityThreshold,
          config.cacheTtlSeconds,
          config.fallbackEnabled ? 1 : 0,
          config.requestTimeoutMs,
          config.maxRetries,
          new Date().toISOString()
        );
    }

    const countProviders = this.db
      .prepare('SELECT COUNT(*) as count FROM provider_config')
      .get() as { count: number };

    if (countProviders.count === 0) {
      const insertProvider = this.db.prepare(`
        INSERT INTO provider_config (
          provider_name, model_name, enabled, priority,
          input_price_per_1m, output_price_per_1m, max_tokens_limit
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const priorities: Record<string, number> = {
        'gpt-4o': 1,
        'gpt-4o-mini': 2,
        'gemini-2.5-flash': 3,
        'gpt-4.1-mini': 4,
        'claude-3-5-sonnet': 5,
      };
      for (const pricing of Object.values(DEFAULT_MODEL_PRICING)) {
        insertProvider.run(
          pricing.provider,
          pricing.model,
          1,
          priorities[pricing.model] ?? 10,
          pricing.inputPricePer1M,
          pricing.outputPricePer1M,
          pricing.maxTokensLimit
        );
      }
    }
  }

  public getGuardrailConfig(): GuardrailConfigRow {
    return this.db
      .prepare('SELECT * FROM guardrail_config WHERE id = 1')
      .get() as unknown as GuardrailConfigRow;
  }

  public getProviders(): ProviderConfigRow[] {
    return this.db
      .prepare('SELECT * FROM provider_config ORDER BY priority ASC, id ASC')
      .all() as unknown as ProviderConfigRow[];
  }

  public getProviderByModel(modelName: string): ProviderConfigRow | undefined {
    return this.db
      .prepare('SELECT * FROM provider_config WHERE model_name = ?')
      .get(modelName) as ProviderConfigRow | undefined;
  }

  public close(): void {
    this.db.close();
  }
}
