import React, { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import type { ApiRequestLog } from '../types/proxy';

interface RequestsPageProps {
  requests: ApiRequestLog[];
  loading: boolean;
  onNavigatePlayground: () => void;
}

type CacheFilter = 'all' | 'hit' | 'miss' | 'error';

export const RequestsPage: React.FC<RequestsPageProps> = ({
  requests,
  loading,
  onNavigatePlayground,
}) => {
  const [filter, setFilter] = useState<CacheFilter>('all');
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return requests.filter((r) => {
      if (filter === 'hit' && r.cache_hit !== 1) return false;
      if (filter === 'miss' && (r.cache_hit !== 0 || r.status !== 'success')) return false;
      if (filter === 'error' && r.status === 'success') return false;
      if (q) {
        return (
          r.request_id.toLowerCase().includes(q) ||
          r.model.toLowerCase().includes(q) ||
          r.client_id.toLowerCase().includes(q) ||
          r.provider.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [requests, filter, query]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
            API Request Ledger
          </h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            End-to-end audit log of every request ID, selected model, cache decision, latency, and estimated cost.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="relative">
            <Search className="h-3.5 w-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter request ID, model, client..."
              className="w-64 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 pl-8 pr-3 py-1.5 text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-900 dark:focus:ring-slate-400"
            />
          </div>

          <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md">
            {(
              [
                { id: 'all', label: 'All' },
                { id: 'hit', label: 'Cache Hits' },
                { id: 'miss', label: 'Cache Misses' },
                { id: 'error', label: 'Rejected / Errors' },
              ] as Array<{ id: CacheFilter; label: string }>
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setFilter(tab.id)}
                className={`px-3 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                  filter === tab.id
                    ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-sm'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
        {loading && requests.length === 0 ? (
          <div className="p-6 space-y-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="h-9 rounded bg-slate-100 dark:bg-slate-800 animate-pulse"
              />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-10 text-center">
            <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
              No matching requests found
            </p>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              Adjust your search filter or dispatch a request from the Gateway Console.
            </p>
            <button
              type="button"
              onClick={onNavigatePlayground}
              className="mt-4 rounded-md bg-slate-900 dark:bg-slate-100 px-4 py-2 text-xs font-medium text-white dark:text-slate-900 hover:bg-slate-800 dark:hover:bg-slate-200 transition-colors"
            >
              Open Gateway Console
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/50 text-slate-500 dark:text-slate-400">
                <tr>
                  <th className="py-2.5 px-4 font-medium">Request ID</th>
                  <th className="py-2.5 px-4 font-medium">Client</th>
                  <th className="py-2.5 px-4 font-medium">Model &amp; Provider</th>
                  <th className="py-2.5 px-4 font-medium">Status</th>
                  <th className="py-2.5 px-4 font-medium">Cache Decision</th>
                  <th className="py-2.5 px-4 font-medium text-right">Tokens (In/Out)</th>
                  <th className="py-2.5 px-4 font-medium text-right">Latency</th>
                  <th className="py-2.5 px-4 font-medium text-right">Est. Cost / Saved</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {filtered.map((req) => (
                  <tr
                    key={req.id}
                    className="hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors"
                  >
                    <td className="py-2.5 px-4 font-mono tabular-nums text-slate-800 dark:text-slate-200">
                      <div>{req.request_id}</div>
                      <div className="text-[11px] text-slate-400">
                        {req.created_at.replace('T', ' ').slice(0, 19)}
                      </div>
                    </td>
                    <td className="py-2.5 px-4 text-slate-600 dark:text-slate-300">
                      {req.client_id}
                    </td>
                    <td className="py-2.5 px-4 font-mono">
                      <div className="text-slate-900 dark:text-slate-100">
                        {req.model}
                        {req.fallback_used === 1 && (
                          <span className="ml-2 text-amber-700 dark:text-amber-400">
                            (Fallback from {req.requested_model})
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-slate-500 dark:text-slate-400">
                        {req.provider}
                      </div>
                    </td>
                    <td className="py-2.5 px-4 font-mono">
                      {req.status === 'success' ? (
                        <span className="text-emerald-700 dark:text-emerald-400">
                          {req.status_code} OK
                        </span>
                      ) : req.status === 'rejected' ? (
                        <span className="text-amber-700 dark:text-amber-400">
                          {req.status_code} Guardrail
                        </span>
                      ) : (
                        <span className="text-rose-700 dark:text-rose-400">
                          {req.status_code} Error
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 px-4 font-mono tabular-nums">
                      {req.cache_hit === 1 ? (
                        <span className="text-emerald-700 dark:text-emerald-400">
                          HIT · {req.cache_type}
                          {req.similarity_score !== null
                            ? ` (${req.similarity_score.toFixed(3)})`
                            : ''}
                        </span>
                      ) : (
                        <span className="text-slate-500 dark:text-slate-400">
                          MISS
                          {req.similarity_score !== null
                            ? ` (max sim ${req.similarity_score.toFixed(3)})`
                            : ''}
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 px-4 text-right font-mono tabular-nums text-slate-700 dark:text-slate-300">
                      {req.input_tokens} / {req.output_tokens}
                    </td>
                    <td className="py-2.5 px-4 text-right font-mono tabular-nums text-slate-700 dark:text-slate-300">
                      <div>{req.latency_ms.toFixed(2)} ms</div>
                      <div className="text-[11px] text-slate-400">
                        lookup {req.cache_lookup_ms.toFixed(2)} ms
                      </div>
                    </td>
                    <td className="py-2.5 px-4 text-right font-mono tabular-nums">
                      {req.cache_hit === 1 ? (
                        <span className="text-emerald-700 dark:text-emerald-400">
                          Saved ${req.estimated_savings.toFixed(5)}
                        </span>
                      ) : (
                        <span className="text-slate-700 dark:text-slate-300">
                          ${req.estimated_cost.toFixed(5)}
                        </span>
                      )}
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
