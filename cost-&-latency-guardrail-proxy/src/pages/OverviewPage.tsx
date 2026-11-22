import React, { useState } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Play } from 'lucide-react';
import { KpiCard } from '../components/KpiCard';
import { proxyApi } from '../services/api';
import type { OverviewAnalytics } from '../types/proxy';

interface OverviewPageProps {
  data: OverviewAnalytics | null;
  loading: boolean;
  adminToken: string | null;
  isDark: boolean;
  onDataUpdated: () => void;
  onNavigatePlayground: () => void;
}

export const OverviewPage: React.FC<OverviewPageProps> = ({
  data,
  loading,
  adminToken,
  isDark,
  onDataUpdated,
  onNavigatePlayground,
}) => {
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [probeInfo, setProbeInfo] = useState<string | null>(null);

  const handleRunProbe = async () => {
    if (!adminToken) {
      setProbeError('Sign in or claim admin access above to run a live workload probe.');
      return;
    }
    setProbing(true);
    setProbeError(null);
    setProbeInfo(null);
    try {
      const res = await proxyApi.runWorkloadProbe(adminToken);
      const hits = res.results.filter((r) => r.cacheType !== 'NONE').length;
      setProbeInfo(
        `Executed ${res.executed} live gateway requests (${hits} cache hits, including semantic similarity and fallback verification).`
      );
      onDataUpdated();
    } catch (err) {
      setProbeError(err instanceof Error ? err.message : 'Probe execution failed');
    } finally {
      setProbing(false);
    }
  };

  if (loading && !data) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, idx) => (
            <div
              key={idx}
              className="h-28 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 animate-pulse"
            />
          ))}
        </div>
        <div className="h-80 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 animate-pulse" />
      </div>
    );
  }

  const overview = data || {
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    cacheHits: 0,
    exactHits: 0,
    semanticHits: 0,
    cacheHitRatio: 0,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
    estimatedSavingsUsd: 0,
    avgLatencyMs: 0,
    p50LatencyMs: 0,
    p95LatencyMs: 0,
    avgCacheHitLatencyMs: 0,
    avgCacheMissLatencyMs: 0,
    fallbackCount: 0,
    costNote: '',
    timeline: [],
  };

  const axisStroke = isDark ? '#94a3b8' : '#64748b';
  const gridStroke = isDark ? '#1e293b' : '#e2e8f0';
  const tooltipStyle = {
    backgroundColor: isDark ? '#0f172a' : '#ffffff',
    border: `1px solid ${isDark ? '#1e293b' : '#e2e8f0'}`,
    borderRadius: '8px',
    color: isDark ? '#f1f5f9' : '#0f172a',
    fontSize: '12px',
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
            Infrastructure Overview
          </h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            Live proxy telemetry across semantic cache lookup, upstream routing, and guardrail enforcement.
          </p>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={handleRunProbe}
            disabled={probing}
            className="inline-flex items-center gap-2 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-4 py-2 text-xs font-medium text-slate-800 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
          >
            <Play className="h-3.5 w-3.5" />
            {probing ? 'Running Probe...' : 'Run Workload Probe'}
          </button>
          <button
            type="button"
            onClick={onNavigatePlayground}
            className="rounded-md bg-slate-900 dark:bg-slate-100 px-4 py-2 text-xs font-medium text-white dark:text-slate-900 hover:bg-slate-800 dark:hover:bg-slate-200 transition-colors whitespace-nowrap shrink-0"
          >
            Open Gateway Console
          </button>
        </div>
      </div>

      {probeError && (
        <div className="rounded-lg border border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/40 px-4 py-3 text-xs text-rose-800 dark:text-rose-300">
          {probeError}
        </div>
      )}
      {probeInfo && (
        <div className="rounded-lg border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/40 px-4 py-3 text-xs text-emerald-800 dark:text-emerald-300">
          {probeInfo}
        </div>
      )}

      {/* 6 Core KPI Metrics */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
        <KpiCard
          label="Total Requests"
          value={overview.totalRequests.toLocaleString()}
          detail={`${overview.successfulRequests} succeeded · ${overview.failedRequests} failed/rejected · ${overview.fallbackCount} fallbacks`}
        />
        <KpiCard
          label="Cache Hit Ratio"
          value={`${(overview.cacheHitRatio * 100).toFixed(1)}%`}
          detail={`${overview.exactHits} exact · ${overview.semanticHits} semantic · ${overview.cacheHits} total hits`}
          tone={overview.cacheHitRatio >= 0.4 ? 'positive' : 'default'}
        />
        <KpiCard
          label="Total Tokens Processed"
          value={overview.totalTokens.toLocaleString()}
          detail={`${overview.inputTokens.toLocaleString()} prompt · ${overview.outputTokens.toLocaleString()} completion`}
        />
        <KpiCard
          label="Estimated Upstream Cost"
          value={`$${overview.estimatedCostUsd.toFixed(5)}`}
          detail="Based on configured per-model token rates"
        />
        <KpiCard
          label="Estimated Cost Saved (Cache)"
          value={`$${overview.estimatedSavingsUsd.toFixed(5)}`}
          detail="Avoided upstream spend via exact & semantic hits"
          tone="positive"
        />
        <KpiCard
          label="Response Latency (Avg / P95)"
          value={`${overview.avgLatencyMs.toFixed(1)} ms`}
          detail={`P50 ${overview.p50LatencyMs} ms · P95 ${overview.p95LatencyMs} ms · Hit avg ${overview.avgCacheHitLatencyMs} ms`}
        />
      </div>

      {/* Charts */}
      {overview.timeline.length === 0 ? (
        <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-10 text-center">
          <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
            No proxy request telemetry recorded yet
          </p>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Send a request via the Gateway Console or run a Workload Probe to observe live cache hit latency and cost optimization.
          </p>
          <button
            type="button"
            onClick={onNavigatePlayground}
            className="mt-4 rounded-md bg-slate-900 dark:bg-slate-100 px-4 py-2 text-xs font-medium text-white dark:text-slate-900 hover:bg-slate-800 dark:hover:bg-slate-200 transition-colors"
          >
            Send First Request
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5">
            <div className="flex items-baseline justify-between mb-4">
              <div>
                <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  Request Latency Profile (ms)
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Cache hits resolve locally vs upstream provider round-trips
                </p>
              </div>
              <span className="text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400">
                Miss avg {overview.avgCacheMissLatencyMs} ms
              </span>
            </div>
            <div className="h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={overview.timeline}>
                  <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} />
                  <XAxis dataKey="seq" stroke={axisStroke} fontSize={11} />
                  <YAxis stroke={axisStroke} fontSize={11} unit=" ms" />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Area
                    type="monotone"
                    dataKey="latencyMs"
                    name="Latency (ms)"
                    stroke="#0284c7"
                    fill="#0284c7"
                    fillOpacity={0.14}
                    strokeWidth={2}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5">
            <div className="flex items-baseline justify-between mb-4">
              <div>
                <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  Estimated Spend vs. Cache Savings ($)
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Per-request upstream cost compared to avoided cost on cache hits
                </p>
              </div>
              <span className="text-xs font-mono tabular-nums text-emerald-700 dark:text-emerald-400">
                Saved ${overview.estimatedSavingsUsd.toFixed(5)}
              </span>
            </div>
            <div className="h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={overview.timeline}>
                  <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} />
                  <XAxis dataKey="seq" stroke={axisStroke} fontSize={11} />
                  <YAxis stroke={axisStroke} fontSize={11} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Bar dataKey="costUsd" name="Upstream Cost ($)" fill="#64748b" radius={[3, 3, 0, 0]} />
                  <Bar dataKey="savingsUsd" name="Cache Savings ($)" fill="#16a34a" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      )}

      {/* Pipeline Summary Table */}
      <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Recent Gateway Executions
          </h2>
          <span className="text-xs text-slate-500 dark:text-slate-400">
            {overview.costNote}
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/50 text-slate-500 dark:text-slate-400">
              <tr>
                <th className="py-2.5 px-4 font-medium">Request ID</th>
                <th className="py-2.5 px-4 font-medium">Time</th>
                <th className="py-2.5 px-4 font-medium">Model</th>
                <th className="py-2.5 px-4 font-medium">Cache Path</th>
                <th className="py-2.5 px-4 font-medium text-right">Tokens</th>
                <th className="py-2.5 px-4 font-medium text-right">Latency</th>
                <th className="py-2.5 px-4 font-medium text-right">Cost / Saved</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {overview.timeline.slice(-8).reverse().map((row) => (
                <tr
                  key={row.requestId}
                  className="hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors"
                >
                  <td className="py-2.5 px-4 font-mono tabular-nums text-slate-700 dark:text-slate-300">
                    {row.requestId}
                  </td>
                  <td className="py-2.5 px-4 font-mono tabular-nums text-slate-500 dark:text-slate-400">
                    {row.time}
                  </td>
                  <td className="py-2.5 px-4 font-mono text-slate-800 dark:text-slate-200">
                    {row.model}
                  </td>
                  <td className="py-2.5 px-4 font-mono">
                    {row.cacheHit ? (
                      <span className="text-emerald-700 dark:text-emerald-400">
                        HIT · {row.cacheType}
                      </span>
                    ) : (
                      <span className="text-slate-500 dark:text-slate-400">MISS</span>
                    )}
                  </td>
                  <td className="py-2.5 px-4 text-right font-mono tabular-nums text-slate-700 dark:text-slate-300">
                    {row.tokens.toLocaleString()}
                  </td>
                  <td className="py-2.5 px-4 text-right font-mono tabular-nums text-slate-700 dark:text-slate-300">
                    {row.latencyMs.toFixed(2)} ms
                  </td>
                  <td className="py-2.5 px-4 text-right font-mono tabular-nums">
                    {row.cacheHit ? (
                      <span className="text-emerald-700 dark:text-emerald-400">
                        Saved ${row.savingsUsd.toFixed(5)}
                      </span>
                    ) : (
                      <span className="text-slate-700 dark:text-slate-300">
                        ${row.costUsd.toFixed(5)}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
