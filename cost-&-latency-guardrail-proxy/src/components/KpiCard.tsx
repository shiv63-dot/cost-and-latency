import React from 'react';

interface KpiCardProps {
  label: string;
  value: string;
  detail?: string;
  tone?: 'default' | 'positive' | 'warning' | 'danger';
}

export const KpiCard: React.FC<KpiCardProps> = ({
  label,
  value,
  detail,
  tone = 'default',
}) => {
  const valueToneClass =
    tone === 'positive'
      ? 'text-emerald-700 dark:text-emerald-400'
      : tone === 'warning'
        ? 'text-amber-700 dark:text-amber-400'
        : tone === 'danger'
          ? 'text-rose-700 dark:text-rose-400'
          : 'text-slate-900 dark:text-slate-100';

  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
      <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
        {label}
      </div>
      <div
        className={`mt-2 text-2xl font-semibold tracking-tight font-mono tabular-nums ${valueToneClass}`}
      >
        {value}
      </div>
      {detail && (
        <div className="mt-1.5 text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
          {detail}
        </div>
      )}
    </div>
  );
};
