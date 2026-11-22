import React, { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { proxyApi } from '../services/api';
import type { SystemStatusResponse } from '../types/proxy';

interface HealthPageProps {
  status: SystemStatusResponse | null;
  loading: boolean;
  onRefresh: () => void;
}

export const HealthPage: React.FC<HealthPageProps> = ({
  status,
  loading,
  onRefresh,
}) => {
  const [metricsText, setMetricsText] = useState<string>('');
  const [metricsLoading, setMetricsLoading] = useState(false);

  const loadMetrics = async () => {
    setMetricsLoading(true);
    try {
      const text = await proxyApi.getPrometheusMetrics();
      setMetricsText(text);
    } catch {
      setMetricsText('# Failed to fetch /metrics endpoint');
    } finally {
      setMetricsLoading(false);
    }
  };

  useEffect(() => {
    void loadMetrics();
  }, []);

  if (loading && !status) {
    return (
      <div className="space-y-4">
        <div className="h-40 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 animate-pulse" />
        <div className="h-64 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 animate-pulse" />
      </div>
    );
  }

  const components = status
    ? [
        {
          name: 'API Gateway',
          state: status.gateway.status,
          detail: `Runtime: ${status.gateway.runtime} · Primary: ${status.gateway.primaryModel} · Fallback: ${status.gateway.fallbackModel}`,
        },
        {
          name: 'Semantic Cache Store',
          state: status.cache.status,
          detail: `Engine: ${status.cache.engine} · Indexed entries: ${status.cache.cachedEntries} · Hit ratio: ${(status.cache.hitRatio * 100).toFixed(1)}%`,
        },
        {
          name: 'Relational Persistence',
          state: status.database.status,
          detail: `Engine: ${status.database.engine}`,
        },
        {
          name: 'LLM Upstream Router',
          state: status.providers.status,
          detail: `Mode: ${status.gateway.providerMode} · ${status.providers.enabled}/${status.providers.configured} models enabled`,
        },
        {
          name: 'Prometheus Exporter',
          state: status.monitoring.status,
          detail: `Exposition endpoint: ${status.monitoring.prometheusEndpoint}`,
        },
      ]
    : [];

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
            System Health &amp; Prometheus Metrics
          </h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            Live dependency verification across gateway, cache, database, upstream providers, and /metrics exposition.
          </p>
        </div>

        <button
          type="button"
          onClick={() => {
            onRefresh();
            void loadMetrics();
          }}
          className="inline-flex items-center gap-2 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-4 py-2 text-xs font-medium text-slate-800 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Check Dependencies
        </button>
      </div>

      <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 divide-y divide-slate-200 dark:divide-slate-800">
        {components.map((item) => {
          const healthy =
            item.state === 'online' ||
            item.state === 'connected' ||
            item.state === 'ready' ||
            item.state === 'available';

          return (
            <div
              key={item.name}
              className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 px-5 py-4"
            >
              <div>
                <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                  {item.name}
                </div>
                <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400 font-mono">
                  {item.detail}
                </div>
              </div>
              <div
                className={`text-xs font-mono uppercase tracking-wide ${
                  healthy
                    ? 'text-emerald-700 dark:text-emerald-400'
                    : 'text-rose-700 dark:text-rose-400'
                }`}
              >
                {healthy ? 'Nominal · ' : 'Degraded · '}
                {item.state}
              </div>
            </div>
          );
        })}
      </div>

      <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Live Prometheus Exposition (GET /metrics)
          </h2>
          <span className="text-xs font-mono text-slate-500 dark:text-slate-400">
            {metricsLoading ? 'Refreshing...' : 'text/plain; version=0.0.4'}
          </span>
        </div>
        <pre className="p-5 overflow-x-auto text-xs font-mono leading-relaxed text-slate-800 dark:text-slate-200 bg-slate-50 dark:bg-slate-950/70 max-h-96">
          {metricsText}
        </pre>
      </div>
    </div>
  );
};
