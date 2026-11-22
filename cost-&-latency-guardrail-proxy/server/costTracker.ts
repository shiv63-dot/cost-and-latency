import { DEFAULT_MODEL_PRICING } from './config.ts';
import type { ProxyDatabase } from './database.ts';

export class CostTrackerService {
  private db: ProxyDatabase;

  constructor(db: ProxyDatabase) {
    this.db = db;
  }

  public calculateEstimatedCost(
    model: string,
    inputTokens: number,
    outputTokens: number
  ): number {
    const providerRow = this.db.getProviderByModel(model);
    const pricing = providerRow
      ? {
          inputPricePer1M: providerRow.input_price_per_1m,
          outputPricePer1M: providerRow.output_price_per_1m,
        }
      : DEFAULT_MODEL_PRICING[model] || DEFAULT_MODEL_PRICING['gpt-4o-mini'];

    const inputCost = (inputTokens / 1_000_000) * pricing.inputPricePer1M;
    const outputCost = (outputTokens / 1_000_000) * pricing.outputPricePer1M;
    return Number((inputCost + outputCost).toFixed(8));
  }

  public recordRequest(entry: {
    requestId: string;
    clientId: string;
    model: string;
    requestedModel: string;
    status: 'success' | 'error' | 'rejected';
    statusCode: number;
    inputTokens: number;
    outputTokens: number;
    estimatedCost: number;
    estimatedSavings: number;
    latencyMs: number;
    cacheLookupMs: number;
    cacheHit: boolean;
    cacheType: 'NONE' | 'EXACT' | 'SEMANTIC';
    similarityScore: number | null;
    provider: string;
    fallbackUsed: boolean;
    errorMessage?: string | null;
    createdAt?: string;
  }): void {
    const createdAt = entry.createdAt || new Date().toISOString();
    const dateOnly = createdAt.slice(0, 10);
    const totalTokens = entry.inputTokens + entry.outputTokens;

    this.db.db
      .prepare(`
        INSERT INTO api_requests (
          request_id, client_id, model, requested_model, status, status_code,
          input_tokens, output_tokens, total_tokens, estimated_cost, estimated_savings,
          latency_ms, cache_lookup_ms, cache_hit, cache_type, similarity_score,
          provider, fallback_used, error_message, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        entry.requestId,
        entry.clientId,
        entry.model,
        entry.requestedModel,
        entry.status,
        entry.statusCode,
        entry.inputTokens,
        entry.outputTokens,
        totalTokens,
        entry.estimatedCost,
        entry.estimatedSavings,
        entry.latencyMs,
        entry.cacheLookupMs,
        entry.cacheHit ? 1 : 0,
        entry.cacheType,
        entry.similarityScore,
        entry.provider,
        entry.fallbackUsed ? 1 : 0,
        entry.errorMessage || null,
        createdAt
      );

    this.db.db
      .prepare(`
        INSERT INTO usage_statistics (
          client_id, date, total_requests, cache_hits, total_tokens, total_cost, total_savings
        ) VALUES (?, ?, 1, ?, ?, ?, ?)
        ON CONFLICT(client_id, date) DO UPDATE SET
          total_requests = total_requests + 1,
          cache_hits = cache_hits + excluded.cache_hits,
          total_tokens = total_tokens + excluded.total_tokens,
          total_cost = total_cost + excluded.total_cost,
          total_savings = total_savings + excluded.total_savings
      `)
      .run(
        entry.clientId,
        dateOnly,
        entry.cacheHit ? 1 : 0,
        totalTokens,
        entry.estimatedCost,
        entry.estimatedSavings
      );
  }

  public getSpendTotals(): { dailySpendUsd: number; monthlySpendUsd: number } {
    const now = new Date();
    const todayPrefix = now.toISOString().slice(0, 10);
    const monthPrefix = now.toISOString().slice(0, 7);

    const dailyRow = this.db.db
      .prepare(`
        SELECT COALESCE(SUM(total_cost), 0) as total
        FROM usage_statistics
        WHERE date = ?
      `)
      .get(todayPrefix) as { total: number };

    const monthlyRow = this.db.db
      .prepare(`
        SELECT COALESCE(SUM(total_cost), 0) as total
        FROM usage_statistics
        WHERE substr(date, 1, 7) = ?
      `)
      .get(monthPrefix) as { total: number };

    return {
      dailySpendUsd: Number(dailyRow.total.toFixed(6)),
      monthlySpendUsd: Number(monthlyRow.total.toFixed(6)),
    };
  }
}
