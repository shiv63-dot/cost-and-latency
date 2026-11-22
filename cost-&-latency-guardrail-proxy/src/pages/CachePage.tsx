import React, { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { KpiCard } from '../components/KpiCard';
import { proxyApi } from '../services/api';
import type { CacheStatsResponse } from '../types/proxy';

interface CachePageProps {
  stats: CacheStatsResponse | null;
  loading: boolean;
  adminToken: string | null;
  onCacheCleared: () => void;
}

export const CachePage: React.FC<CachePageProps> = ({
  stats,
  loading,
  adminToken,
  onCacheCleared,
}) => {
  const [clearing, setClearing] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleClearCache = async () => {
    if (!adminToken) {
      setError('Sign in or claim admin access above before clearing the cache.');
      return;
    }
    setClearing(true);
    setError(null);
    setFeedback(null);
    try {
      const res = await proxyApi.clearCache(adminToken);
      setFeedback(`Cleared ${res.entriesRemoved} cached prompt entries.`);
      onCacheCleared();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to clear cache');
    } finally {
      setClearing(false);
    }
  };

  if (loading && !stats) {
    return (
      <div className="space-y-4">
        <div className="h-28 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 animate-pulse" />
        <div className="h-64 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 animate-pulse" />
      </div>
    );
  }

  const cache = stats || {
    cachedPromptCount: 0,
    totalCacheHits: 0,
    exactHits: 0,
    semanticHits: 0,
    totalMisses: 0,
    hitRatio: 0,
    ttlSeconds: 3600,
    similarityThreshold: 0.84,
    entries: [],
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
            Semantic Cache Management
          </h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            Two-tier SHA-256 exact match and cosine-similarity vector cache isolated by model, system prompt, and temperature.
          </p>
        </div>

        <button
          type="button"
          onClick={handleClearCache}
          disabled={clearing}
          className="inline-flex items-center gap-2 rounded-md border border-rose-300 dark:border-rose-800 bg-white dark:bg-slate-900 px-4 py-2 text-xs font-medium text-rose-700 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
        >
          <Trash2 className="h-3.5 w-3.5" />
          {clearing ? 'Clearing...' : 'Clear Cache Entries'}
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/40 px-4 py-3 text-xs text-rose-800 dark:text-rose-300">
          {error}
        </div>
      )}
      {feedback && (
        <div className="rounded-lg border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/40 px-4 py-3 text-xs text-emerald-800 dark:text-emerald-300">
          {feedback}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <KpiCard
          label="Cached Prompt Vectors"
          value={String(cache.cachedPromptCount)}
          detail={`TTL ${cache.ttlSeconds}s`}
        />
        <KpiCard
          label="Hit / Miss Ratio"
          value={`${(cache.hitRatio * 100).toFixed(1)}%`}
          detail={`${cache.totalCacheHits} hits · ${cache.totalMisses} misses`}
          tone={cache.hitRatio >= 0.4 ? 'positive' : 'default'}
        />
        <KpiCard
          label="Exact vs. Semantic Hits"
          value={`${cache.exactHits} / ${cache.semanticHits}`}
          detail="SHA-256 exact · Vector cosine"
        />
        <KpiCard
          label="Similarity Threshold"
          value={cache.similarityThreshold.toFixed(2)}
          detail="Configurable in Guardrails"
        />
      </div>

      <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Active Cached Prompts
          </h2>
          <span className="text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400">
            {cache.entries.length} entries stored
          </span>
        </div>

        {cache.entries.length === 0 ? (
          <div className="p-10 text-center">
            <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
              Cache store is currently empty
            </p>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              Successful upstream responses are automatically embedded and indexed here for future reuse.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/50 text-slate-500 dark:text-slate-400">
                <tr>
                  <th className="py-2.5 px-4 font-medium">Prompt Preview</th>
                  <th className="py-2.5 px-4 font-medium">Model</th>
                  <th className="py-2.5 px-4 font-medium text-right">Reuse Hits</th>
                  <th className="py-2.5 px-4 font-medium text-right">Tokens (In/Out)</th>
                  <th className="py-2.5 px-4 font-medium text-right">Expires At (UTC)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {cache.entries.map((entry) => (
                  <tr
                    key={entry.id}
                    className="hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors"
                  >
                    <td className="py-2.5 px-4 max-w-md truncate text-slate-800 dark:text-slate-200">
                      {entry.promptPreview}
                    </td>
                    <td className="py-2.5 px-4 font-mono text-slate-700 dark:text-slate-300">
                      {entry.model}
                    </td>
                    <td className="py-2.5 px-4 text-right font-mono tabular-nums text-emerald-700 dark:text-emerald-400">
                      {entry.hitCount}
                    </td>
                    <td className="py-2.5 px-4 text-right font-mono tabular-nums text-slate-600 dark:text-slate-400">
                      {entry.inputTokens} / {entry.outputTokens}
                    </td>
                    <td className="py-2.5 px-4 text-right font-mono tabular-nums text-slate-500 dark:text-slate-400">
                      {entry.expiresAt.replace('T', ' ').slice(0, 19)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
