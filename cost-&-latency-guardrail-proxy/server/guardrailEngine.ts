import type { CostTrackerService } from './costTracker.ts';
import type { GuardrailConfigRow, ProxyDatabase } from './database.ts';
import { estimateTokenCount } from './embedding.ts';
import type { ChatMessage } from './semanticCache.ts';

export interface GuardrailDecision {
  allowed: boolean;
  statusCode?: number;
  errorCode?: string;
  errorType?: string;
  message?: string;
  retryAfterSeconds?: number;
}

export class GuardrailEngine {
  private db: ProxyDatabase;
  private costTracker: CostTrackerService;
  private requestTimestampsByClient = new Map<string, number[]>();

  constructor(db: ProxyDatabase, costTracker: CostTrackerService) {
    this.db = db;
    this.costTracker = costTracker;
  }

  public evaluateRequest(params: {
    clientId: string;
    messages: ChatMessage[];
    requestedMaxTokens?: number;
    clientRpmOverride?: number;
  }): GuardrailDecision {
    const config = this.db.getGuardrailConfig();

    // 1. Token limit check
    const combinedContent = params.messages.map((m) => m.content).join(' ');
    const estimatedInputTokens = estimateTokenCount(combinedContent);
    const effectiveMaxTokens = params.requestedMaxTokens ?? 512;

    if (estimatedInputTokens > config.max_tokens) {
      return {
        allowed: false,
        statusCode: 400,
        errorCode: 'max_input_tokens_exceeded',
        errorType: 'invalid_request_error',
        message: `Estimated input tokens (${estimatedInputTokens}) exceed configured guardrail limit (${config.max_tokens}).`,
      };
    }

    if (effectiveMaxTokens > config.max_tokens) {
      return {
        allowed: false,
        statusCode: 400,
        errorCode: 'max_tokens_exceeded',
        errorType: 'invalid_request_error',
        message: `Requested max_tokens (${effectiveMaxTokens}) exceeds configured guardrail limit (${config.max_tokens}).`,
      };
    }

    // 2. Sliding-window rate limit check (per-client and global)
    const now = Date.now();
    const windowStart = now - 60_000;
    const rpmLimit = params.clientRpmOverride ?? config.requests_per_minute;

    const existing = (this.requestTimestampsByClient.get(params.clientId) || []).filter(
      (ts) => ts > windowStart
    );
    if (existing.length >= rpmLimit) {
      const oldestInWindow = existing[0] ?? now;
      const retryAfterSeconds = Math.max(1, Math.ceil((oldestInWindow + 60_000 - now) / 1000));
      this.requestTimestampsByClient.set(params.clientId, existing);
      return {
        allowed: false,
        statusCode: 429,
        errorCode: 'rate_limit_exceeded',
        errorType: 'rate_limit_error',
        message: `Rate limit exceeded for client "${params.clientId}" (${rpmLimit} requests/minute).`,
        retryAfterSeconds,
      };
    }
    existing.push(now);
    this.requestTimestampsByClient.set(params.clientId, existing);

    // 3. Daily & Monthly budget guardrails
    const { dailySpendUsd, monthlySpendUsd } = this.costTracker.getSpendTotals();
    if (dailySpendUsd >= config.daily_budget) {
      return {
        allowed: false,
        statusCode: 429,
        errorCode: 'daily_budget_exceeded',
        errorType: 'insufficient_quota',
        message: `Daily spending guardrail reached ($${dailySpendUsd.toFixed(4)} / $${config.daily_budget.toFixed(2)}).`,
      };
    }

    if (monthlySpendUsd >= config.monthly_budget) {
      return {
        allowed: false,
        statusCode: 429,
        errorCode: 'monthly_budget_exceeded',
        errorType: 'insufficient_quota',
        message: `Monthly spending guardrail reached ($${monthlySpendUsd.toFixed(4)} / $${config.monthly_budget.toFixed(2)}).`,
      };
    }

    return { allowed: true };
  }

  public getCurrentRpmCount(): number {
    const windowStart = Date.now() - 60_000;
    let total = 0;
    for (const [clientId, timestamps] of this.requestTimestampsByClient.entries()) {
      const active = timestamps.filter((ts) => ts > windowStart);
      if (active.length === 0) {
        this.requestTimestampsByClient.delete(clientId);
      } else {
        this.requestTimestampsByClient.set(clientId, active);
        total += active.length;
      }
    }
    return total;
  }

  public getStatus(): {
    config: GuardrailConfigRow;
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
  } {
    const config = this.db.getGuardrailConfig();
    const { dailySpendUsd, monthlySpendUsd } = this.costTracker.getSpendTotals();
    const currentRpm = this.getCurrentRpmCount();

    return {
      config,
      utilization: {
        dailySpendUsd,
        dailyBudgetUsd: config.daily_budget,
        dailyUtilizationPct:
          config.daily_budget > 0
            ? Number(Math.min(100, (dailySpendUsd / config.daily_budget) * 100).toFixed(2))
            : 0,
        monthlySpendUsd,
        monthlyBudgetUsd: config.monthly_budget,
        monthlyUtilizationPct:
          config.monthly_budget > 0
            ? Number(Math.min(100, (monthlySpendUsd / config.monthly_budget) * 100).toFixed(2))
            : 0,
        currentRpm,
        rpmLimit: config.requests_per_minute,
        rpmUtilizationPct:
          config.requests_per_minute > 0
            ? Number(Math.min(100, (currentRpm / config.requests_per_minute) * 100).toFixed(2))
            : 0,
      },
    };
  }
}
