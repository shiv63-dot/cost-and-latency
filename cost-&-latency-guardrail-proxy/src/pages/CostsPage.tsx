import React from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { KpiCard } from '../components/KpiCard';
import type { CostAnalyticsResponse, TokenModelBreakdown } from '../types/proxy';

interface CostsPageProps {
  costs: CostAnalyticsResponse | null;
  tokens: TokenModelBreakdown[];
  loading: boolean;
  isDark: boolean;
}

export const CostsPage: React.FC<CostsPageProps> = ({
  costs,
  tokens,
  loading,
  isDark,
}) => {
  if (loading && !costs) {
    return (
      <div className="space-y-4">
        <div className="h-28 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 animate-pulse" />
        <div className="h-80 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 animate-pulse" />
      </div>
    );
  }

  const data = costs || {
    dailySpendUsd: 0,
    monthlySpendUsd: 0,
    byModel: [],
    dailySeries: [],
    disclaimer: '',
  };

  const totalSavings = data.byModel.reduce((acc, m) => acc + m.estimatedSavingsUsd, 0);
  const totalGrossWouldSpend = data.byModel.reduce(
    (acc, m) => acc + m.estimatedCostUsd + m.estimatedSavingsUsd,
    0
  );
  const reductionPct =
    totalGrossWouldSpend > 0 ? (totalSavings / totalGrossWouldSpend) * 100 : 0;

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
      <div>
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
          Cost Optimization &amp; Token Analytics
        </h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          Estimated API expenditure, cache-avoided cost, and per-model token consumption.
        </p>
      </div>

      {data.disclaimer && (
        <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-100/70 dark:bg-slate-900 px-4 py-2.5 text-xs text-slate-600 dark:text-slate-400">
          {data.disclaimer}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <KpiCard
          label="Daily Estimated Spend"
          value={`$${data.dailySpendUsd.toFixed(5)}`}
          detail="Current UTC day"
        />
        <KpiCard
          label="Monthly Estimated Spend"
          value={`$${data.monthlySpendUsd.toFixed(5)}`}
          detail="Current billing month"
        />
        <KpiCard
          label="Estimated Cache Savings"
          value={`$${totalSavings.toFixed(5)}`}
          detail="Avoided upstream token charges"
          tone="positive"
        />
        <KpiCard
          label="Observed Cost Reduction"
          value={`${reductionPct.toFixed(1)}%`}
          detail={`Uncached baseline $${totalGrossWouldSpend.toFixed(5)}`}
          tone={reductionPct > 0 ? 'positive' : 'default'}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-4">
            Model-Wise Estimated Cost vs. Savings ($)
          </h2>
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.byModel}>
                <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} />
                <XAxis dataKey="model" stroke={axisStroke} fontSize={11} />
                <YAxis stroke={axisStroke} fontSize={11} />
                <Tooltip contentStyle={tooltipStyle} />
                <Legend wrapperStyle={{ fontSize: '12px' }} />
                <Bar
                  dataKey="estimatedCostUsd"
                  name="Estimated Spend ($)"
                  fill="#0284c7"
                  radius={[3, 3, 0, 0]}
                />
                <Bar
                  dataKey="estimatedSavingsUsd"
                  name="Cache Savings ($)"
                  fill="#16a34a"
                  radius={[3, 3, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-4">
            Token Consumption by Model (Upstream vs. Cached)
          </h2>
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={tokens}>
                <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} />
                <XAxis dataKey="model" stroke={axisStroke} fontSize={11} />
                <YAxis stroke={axisStroke} fontSize={11} />
                <Tooltip contentStyle={tooltipStyle} />
                <Legend wrapperStyle={{ fontSize: '12px' }} />
                <Bar
                  dataKey="upstream_tokens"
                  name="Upstream Tokens"
                  stackId="a"
                  fill="#475569"
                />
                <Bar
                  dataKey="cached_tokens"
                  name="Cached Tokens (Zero Cost)"
                  stackId="a"
                  fill="#16a34a"
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Per-Model Cost Breakdown
          </h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/50 text-slate-500 dark:text-slate-400">
              <tr>
                <th className="py-2.5 px-4 font-medium">Model</th>
                <th className="py-2.5 px-4 font-medium text-right">Requests</th>
                <th className="py-2.5 px-4 font-medium text-right">Cache Hits</th>
                <th className="py-2.5 px-4 font-medium text-right">Input Tokens</th>
                <th className="py-2.5 px-4 font-medium text-right">Output Tokens</th>
                <th className="py-2.5 px-4 font-medium text-right">Estimated Spend</th>
                <th className="py-2.5 px-4 font-medium text-right">Cache Savings</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {data.byModel.map((row) => (
                <tr
                  key={row.model}
                  className="hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors"
                >
                  <td className="py-2.5 px-4 font-mono text-slate-900 dark:text-slate-100">
                    {row.model}
                  </td>
                  <td className="py-2.5 px-4 text-right font-mono tabular-nums text-slate-700 dark:text-slate-300">
                    {row.requests}
                  </td>
                  <td className="py-2.5 px-4 text-right font-mono tabular-nums text-emerald-700 dark:text-emerald-400">
                    {row.cacheHits}
                  </td>
                  <td className="py-2.5 px-4 text-right font-mono tabular-nums text-slate-700 dark:text-slate-300">
                    {row.inputTokens.toLocaleString()}
                  </td>
                  <td className="py-2.5 px-4 text-right font-mono tabular-nums text-slate-700 dark:text-slate-300">
                    {row.outputTokens.toLocaleString()}
                  </td>
                  <td className="py-2.5 px-4 text-right font-mono tabular-nums text-slate-900 dark:text-slate-100">
                    ${row.estimatedCostUsd.toFixed(5)}
                  </td>
                  <td className="py-2.5 px-4 text-right font-mono tabular-nums text-emerald-700 dark:text-emerald-400">
                    ${row.estimatedSavingsUsd.toFixed(5)}
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
