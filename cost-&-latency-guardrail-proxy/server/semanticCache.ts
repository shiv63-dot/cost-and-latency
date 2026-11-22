import { sha256Hex } from './security.ts';
import { cosineSimilarity, generateEmbedding } from './embedding.ts';
import type { ProxyDatabase } from './database.ts';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CacheLookupParams {
  model: string;
  messages: ChatMessage[];
  temperature: number;
  maxTokens?: number;
  clientScope: string;
  similarityThreshold: number;
}

export interface CachedPayload {
  content: string;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
}

export interface CacheLookupResult {
  hit: boolean;
  cacheType: 'NONE' | 'EXACT' | 'SEMANTIC';
  similarityScore: number | null;
  lookupMs: number;
  payload?: CachedPayload;
  settingsHash: string;
  exactHash: string;
  promptText: string;
  embedding: number[];
}

export class SemanticCacheService {
  private db: ProxyDatabase;

  constructor(db: ProxyDatabase) {
    this.db = db;
  }

  private buildSettingsHash(params: {
    model: string;
    messages: ChatMessage[];
    temperature: number;
    maxTokens?: number;
    clientScope: string;
  }): string {
    const systemMessages = params.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content.trim());

    // Only reuse responses when system prompts, model, temperature bucket, maxTokens, and scope match
    const tempBucket = Math.round(params.temperature * 10) / 10;
    const settingsCanonical = JSON.stringify({
      model: params.model,
      system: systemMessages,
      temperature: tempBucket,
      maxTokens: params.maxTokens ?? null,
      scope: params.clientScope,
    });
    return sha256Hex(settingsCanonical);
  }

  private extractPromptText(messages: ChatMessage[]): string {
    return messages
      .filter((m) => m.role !== 'system')
      .map((m) => `${m.role}: ${m.content.trim()}`)
      .join('\n')
      .trim();
  }

  private normalizeExactKey(settingsHash: string, messages: ChatMessage[]): string {
    const canonicalMessages = messages.map((m) => ({
      role: m.role,
      content: m.content.trim().replace(/\s+/g, ' '),
    }));
    return sha256Hex(`${settingsHash}:${JSON.stringify(canonicalMessages)}`);
  }

  public lookup(params: CacheLookupParams): CacheLookupResult {
    const started = performance.now();
    const nowIso = new Date().toISOString();
    const settingsHash = this.buildSettingsHash(params);
    const exactHash = this.normalizeExactKey(settingsHash, params.messages);
    const promptText = this.extractPromptText(params.messages);

    // Purge expired rows lazily
    this.db.db.prepare('DELETE FROM cache_entries WHERE expires_at <= ?').run(nowIso);

    // Tier 1: Exact-match SHA-256 lookup
    const exactRow = this.db.db
      .prepare(`
        SELECT id, response_json, model, input_tokens, output_tokens
        FROM cache_entries
        WHERE exact_hash = ? AND expires_at > ?
        LIMIT 1
      `)
      .get(exactHash, nowIso) as
      | {
          id: number;
          response_json: string;
          model: string;
          input_tokens: number;
          output_tokens: number;
        }
      | undefined;

    if (exactRow) {
      this.db.db
        .prepare('UPDATE cache_entries SET hit_count = hit_count + 1 WHERE id = ?')
        .run(exactRow.id);

      const parsed = JSON.parse(exactRow.response_json) as CachedPayload;
      const lookupMs = Number((performance.now() - started).toFixed(3));
      return {
        hit: true,
        cacheType: 'EXACT',
        similarityScore: 1.0,
        lookupMs,
        payload: parsed,
        settingsHash,
        exactHash,
        promptText,
        embedding: [],
      };
    }

    // Tier 2: Semantic similarity search within identical settingsHash (and single-turn user prompts or matching history)
    const embedding = generateEmbedding(promptText);
    const candidates = this.db.db
      .prepare(`
        SELECT id, embedding_json, response_json
        FROM cache_entries
        WHERE settings_hash = ? AND expires_at > ?
        ORDER BY created_at DESC
        LIMIT 250
      `)
      .all(settingsHash, nowIso) as Array<{
        id: number;
        embedding_json: string;
        response_json: string;
      }>;

    let bestScore = 0;
    let bestCandidate: { id: number; response_json: string } | null = null;

    for (const row of candidates) {
      try {
        const candidateVec = JSON.parse(row.embedding_json) as number[];
        const score = cosineSimilarity(embedding, candidateVec);
        if (score > bestScore) {
          bestScore = score;
          bestCandidate = row;
        }
      } catch {
        // Ignore malformed embeddings
      }
    }

    const lookupMs = Number((performance.now() - started).toFixed(3));
    if (bestCandidate && bestScore >= params.similarityThreshold) {
      this.db.db
        .prepare('UPDATE cache_entries SET hit_count = hit_count + 1 WHERE id = ?')
        .run(bestCandidate.id);

      const parsed = JSON.parse(bestCandidate.response_json) as CachedPayload;
      return {
        hit: true,
        cacheType: 'SEMANTIC',
        similarityScore: Number(bestScore.toFixed(4)),
        lookupMs,
        payload: parsed,
        settingsHash,
        exactHash,
        promptText,
        embedding,
      };
    }

    return {
      hit: false,
      cacheType: 'NONE',
      similarityScore: bestCandidate ? Number(bestScore.toFixed(4)) : null,
      lookupMs,
      settingsHash,
      exactHash,
      promptText,
      embedding,
    };
  }

  public store(params: {
    exactHash: string;
    settingsHash: string;
    model: string;
    promptText: string;
    embedding: number[];
    payload: CachedPayload;
    ttlSeconds: number;
  }): void {
    const now = Date.now();
    const createdAt = new Date(now).toISOString();
    const expiresAt = new Date(now + params.ttlSeconds * 1000).toISOString();
    const preview =
      params.promptText.length > 160
        ? `${params.promptText.slice(0, 157)}...`
        : params.promptText;
    const embeddingToStore =
      params.embedding.length > 0 ? params.embedding : generateEmbedding(params.promptText);

    this.db.db
      .prepare(`
        INSERT INTO cache_entries (
          exact_hash, settings_hash, model, prompt_preview, embedding_json,
          response_json, input_tokens, output_tokens, hit_count, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
        ON CONFLICT(exact_hash) DO UPDATE SET
          embedding_json = excluded.embedding_json,
          response_json = excluded.response_json,
          input_tokens = excluded.input_tokens,
          output_tokens = excluded.output_tokens,
          expires_at = excluded.expires_at
      `)
      .run(
        params.exactHash,
        params.settingsHash,
        params.model,
        preview,
        JSON.stringify(embeddingToStore),
        JSON.stringify(params.payload),
        params.payload.inputTokens,
        params.payload.outputTokens,
        createdAt,
        expiresAt
      );
  }

  public clearAll(): number {
    const countRow = this.db.db
      .prepare('SELECT COUNT(*) as count FROM cache_entries')
      .get() as { count: number };
    this.db.db.prepare('DELETE FROM cache_entries').run();
    return countRow.count;
  }

  public getStats(): {
    cachedPromptCount: number;
    totalCacheHits: number;
    exactHits: number;
    semanticHits: number;
    totalMisses: number;
    hitRatio: number;
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
  } {
    const nowIso = new Date().toISOString();
    this.db.db.prepare('DELETE FROM cache_entries WHERE expires_at <= ?').run(nowIso);

    const countRow = this.db.db
      .prepare('SELECT COUNT(*) as count FROM cache_entries')
      .get() as { count: number };

    const hitBreakdown = this.db.db
      .prepare(`
        SELECT
          SUM(CASE WHEN cache_hit = 1 THEN 1 ELSE 0 END) as total_hits,
          SUM(CASE WHEN cache_type = 'EXACT' THEN 1 ELSE 0 END) as exact_hits,
          SUM(CASE WHEN cache_type = 'SEMANTIC' THEN 1 ELSE 0 END) as semantic_hits,
          SUM(CASE WHEN cache_hit = 0 AND status = 'success' THEN 1 ELSE 0 END) as total_misses
        FROM api_requests
      `)
      .get() as {
        total_hits: number | null;
        exact_hits: number | null;
        semantic_hits: number | null;
        total_misses: number | null;
      };

    const totalHits = hitBreakdown.total_hits ?? 0;
    const totalMisses = hitBreakdown.total_misses ?? 0;
    const denom = totalHits + totalMisses;

    const entries = this.db.db
      .prepare(`
        SELECT id, model, prompt_preview, hit_count, input_tokens, output_tokens, created_at, expires_at
        FROM cache_entries
        ORDER BY hit_count DESC, created_at DESC
        LIMIT 50
      `)
      .all() as Array<{
        id: number;
        model: string;
        prompt_preview: string;
        hit_count: number;
        input_tokens: number;
        output_tokens: number;
        created_at: string;
        expires_at: string;
      }>;

    return {
      cachedPromptCount: countRow.count,
      totalCacheHits: totalHits,
      exactHits: hitBreakdown.exact_hits ?? 0,
      semanticHits: hitBreakdown.semantic_hits ?? 0,
      totalMisses,
      hitRatio: denom > 0 ? Number((totalHits / denom).toFixed(4)) : 0,
      entries: entries.map((e) => ({
        id: e.id,
        model: e.model,
        promptPreview: e.prompt_preview,
        hitCount: e.hit_count,
        inputTokens: e.input_tokens,
        outputTokens: e.output_tokens,
        createdAt: e.created_at,
        expiresAt: e.expires_at,
      })),
    };
  }
}
