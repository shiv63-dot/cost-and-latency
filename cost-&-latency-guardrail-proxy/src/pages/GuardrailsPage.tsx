import React, { useEffect, useState } from 'react';
import { KeyRound, Trash2 } from 'lucide-react';
import { proxyApi } from '../services/api';
import type {
  ClientKeySummary,
  GuardrailsStatusResponse,
  ProviderConfig,
} from '../types/proxy';

interface GuardrailsPageProps {
  guardrails: GuardrailsStatusResponse | null;
  providers: ProviderConfig[];
  adminToken: string | null;
  onUpdated: () => void;
}

export const GuardrailsPage: React.FC<GuardrailsPageProps> = ({
  guardrails,
  providers,
  adminToken,
  onUpdated,
}) => {
  const [dailyBudget, setDailyBudget] = useState('25');
  const [monthlyBudget, setMonthlyBudget] = useState('500');
  const [rpm, setRpm] = useState('60');
  const [maxTokens, setMaxTokens] = useState('4096');
  const [similarityThreshold, setSimilarityThreshold] = useState('0.84');
  const [cacheTtl, setCacheTtl] = useState('3600');
  const [timeoutMs, setTimeoutMs] = useState('15000');
  const [maxRetries, setMaxRetries] = useState('2');
  const [fallbackEnabled, setFallbackEnabled] = useState(true);

  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [clientKeys, setClientKeys] = useState<ClientKeySummary[]>([]);
  const [newKeyName, setNewKeyName] = useState('Backend Service');
  const [newClientId, setNewClientId] = useState('billing-api');
  const [newKeyRpm, setNewKeyRpm] = useState('60');
  const [issuedRawKey, setIssuedRawKey] = useState<string | null>(null);

  useEffect(() => {
    if (guardrails?.config) {
      const c = guardrails.config;
      setDailyBudget(String(c.daily_budget));
      setMonthlyBudget(String(c.monthly_budget));
      setRpm(String(c.requests_per_minute));
      setMaxTokens(String(c.max_tokens));
      setSimilarityThreshold(String(c.similarity_threshold));
      setCacheTtl(String(c.cache_ttl_seconds));
      setTimeoutMs(String(c.request_timeout_ms));
      setMaxRetries(String(c.max_retries));
      setFallbackEnabled(c.fallback_enabled === 1);
    }
  }, [guardrails]);

  useEffect(() => {
    if (!adminToken) {
      setClientKeys([]);
      return;
    }
    proxyApi
      .getClientKeys(adminToken)
      .then((res) => setClientKeys(res.keys))
      .catch(() => {});
  }, [adminToken]);

  const handleSaveConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!adminToken) {
      setError('Sign in or claim admin access above to update guardrail limits.');
      return;
    }
    setSaving(true);
    setError(null);
    setSaveMessage(null);
    try {
      await proxyApi.updateGuardrailsConfig(adminToken, {
        daily_budget: Number(dailyBudget),
        monthly_budget: Number(monthlyBudget),
        requests_per_minute: Number(rpm),
        max_tokens: Number(maxTokens),
        similarity_threshold: Number(similarityThreshold),
        cache_ttl_seconds: Number(cacheTtl),
        request_timeout_ms: Number(timeoutMs),
        max_retries: Number(maxRetries),
        fallback_enabled: fallbackEnabled,
      });
      setSaveMessage('Guardrail limits and routing thresholds updated.');
      onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save guardrails');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleProvider = async (modelName: string, nextEnabled: boolean) => {
    if (!adminToken) {
      setError('Sign in or claim admin access above to toggle provider models.');
      return;
    }
    setError(null);
    try {
      await proxyApi.updateProviderConfig(adminToken, {
        model_name: modelName,
        enabled: nextEnabled,
      });
      onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update provider');
    }
  };

  const handleCreateKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!adminToken) {
      setError('Sign in or claim admin access above to issue client keys.');
      return;
    }
    setError(null);
    try {
      const res = await proxyApi.createClientKey(adminToken, {
        key_name: newKeyName,
        client_id: newClientId,
        rpm_limit: Number(newKeyRpm),
      });
      setIssuedRawKey(res.raw_key);
      const updated = await proxyApi.getClientKeys(adminToken);
      setClientKeys(updated.keys);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create client key');
    }
  };

  const handleRevokeKey = async (id: number) => {
    if (!adminToken) return;
    await proxyApi.revokeClientKey(adminToken, id);
    const updated = await proxyApi.getClientKeys(adminToken);
    setClientKeys(updated.keys);
  };

  const util = guardrails?.utilization;

  const meterColor = (pct: number) =>
    pct >= 90
      ? 'bg-rose-600'
      : pct >= 70
        ? 'bg-amber-600'
        : 'bg-emerald-600';

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
          Cost, Rate &amp; Routing Guardrails
        </h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          Enforce spending ceilings, per-client RPM rate limits, maximum token windows, and automatic fallback policies.
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/40 px-4 py-3 text-xs text-rose-800 dark:text-rose-300">
          {error}
        </div>
      )}
      {saveMessage && (
        <div className="rounded-lg border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/40 px-4 py-3 text-xs text-emerald-800 dark:text-emerald-300">
          {saveMessage}
        </div>
      )}

      {/* Live Utilization Meters */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {[
          {
            label: 'Daily Budget Utilization',
            value: `$${(util?.dailySpendUsd ?? 0).toFixed(5)} / $${(util?.dailyBudgetUsd ?? 25).toFixed(2)}`,
            pct: util?.dailyUtilizationPct ?? 0,
          },
          {
            label: 'Monthly Budget Utilization',
            value: `$${(util?.monthlySpendUsd ?? 0).toFixed(5)} / $${(util?.monthlyBudgetUsd ?? 500).toFixed(2)}`,
            pct: util?.monthlyUtilizationPct ?? 0,
          },
          {
            label: 'Current Minute Rate Limit',
            value: `${util?.currentRpm ?? 0} / ${util?.rpmLimit ?? 60} RPM`,
            pct: util?.rpmUtilizationPct ?? 0,
          },
        ].map((meter) => (
          <div
            key={meter.label}
            className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4"
          >
            <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
              <span>{meter.label}</span>
              <span className="font-mono tabular-nums">{meter.pct.toFixed(1)}%</span>
            </div>
            <div className="mt-2 text-sm font-semibold font-mono tabular-nums text-slate-900 dark:text-slate-100">
              {meter.value}
            </div>
            <div className="mt-3 h-2 w-full rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
              <div
                className={`h-full transition-all ${meterColor(meter.pct)}`}
                style={{ width: `${Math.max(2, Math.min(100, meter.pct))}%` }}
              />
            </div>
          </div>
        ))}
      </div>

      {/* Policy Config Form */}
      <form
        onSubmit={handleSaveConfig}
        className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-5"
      >
        <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-3">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Policy Limits &amp; Cache Thresholds
          </h2>
          <button
            type="submit"
            disabled={saving}
            className="rounded-md bg-slate-900 dark:bg-slate-100 px-4 py-1.5 text-xs font-medium text-white dark:text-slate-900 hover:bg-slate-800 dark:hover:bg-slate-200 disabled:opacity-50 transition-colors"
          >
            {saving ? 'Saving...' : 'Save Guardrails'}
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {[
            { label: 'Daily Budget (USD)', val: dailyBudget, set: setDailyBudget, step: '0.01', min: '0.001' },
            { label: 'Monthly Budget (USD)', val: monthlyBudget, set: setMonthlyBudget, step: '1', min: '0.01' },
            { label: 'Requests Per Minute', val: rpm, set: setRpm, step: '1', min: '1' },
            { label: 'Max Tokens Per Request', val: maxTokens, set: setMaxTokens, step: '64', min: '64' },
            { label: 'Semantic Similarity (0.50–0.99)', val: similarityThreshold, set: setSimilarityThreshold, step: '0.01', min: '0.5', max: '0.99' },
            { label: 'Cache TTL (Seconds)', val: cacheTtl, set: setCacheTtl, step: '60', min: '30' },
            { label: 'Provider Timeout (ms)', val: timeoutMs, set: setTimeoutMs, step: '500', min: '500' },
            { label: 'Max Retry Attempts (0–5)', val: maxRetries, set: setMaxRetries, step: '1', min: '0', max: '5' },
          ].map((field) => (
            <label key={field.label} className="block space-y-1.5">
              <span className="block text-xs font-medium text-slate-600 dark:text-slate-400">
                {field.label}
              </span>
              <input
                type="number"
                step={field.step}
                min={field.min}
                max={field.max}
                value={field.val}
                onChange={(e) => field.set(e.target.value)}
                className="w-full rounded-md border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-xs font-mono tabular-nums text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-900 dark:focus:ring-slate-400"
              />
            </label>
          ))}
        </div>

        <label className="inline-flex items-center gap-2.5 text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
          <input
            type="checkbox"
            checked={fallbackEnabled}
            onChange={(e) => setFallbackEnabled(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300 dark:border-slate-700"
          />
          <span>
            Enable automatic fallback model routing when primary upstream provider fails after retries
          </span>
        </label>
      </form>

      {/* Model Routing & Pricing Table */}
      <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Configured Models &amp; Token Pricing Rates
          </h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/50 text-slate-500 dark:text-slate-400">
              <tr>
                <th className="py-2.5 px-4 font-medium">Priority</th>
                <th className="py-2.5 px-4 font-medium">Model</th>
                <th className="py-2.5 px-4 font-medium">Provider</th>
                <th className="py-2.5 px-4 font-medium text-right">Input / 1M</th>
                <th className="py-2.5 px-4 font-medium text-right">Output / 1M</th>
                <th className="py-2.5 px-4 font-medium text-right">Context Limit</th>
                <th className="py-2.5 px-4 font-medium text-right">Routing State</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {providers.map((p) => (
                <tr key={p.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                  <td className="py-2.5 px-4 font-mono tabular-nums text-slate-600 dark:text-slate-400">
                    #{p.priority}
                  </td>
                  <td className="py-2.5 px-4 font-mono text-slate-900 dark:text-slate-100">
                    {p.model_name}
                  </td>
                  <td className="py-2.5 px-4 text-slate-600 dark:text-slate-400">
                    {p.provider_name}
                  </td>
                  <td className="py-2.5 px-4 text-right font-mono tabular-nums text-slate-700 dark:text-slate-300">
                    ${p.input_price_per_1m.toFixed(2)}
                  </td>
                  <td className="py-2.5 px-4 text-right font-mono tabular-nums text-slate-700 dark:text-slate-300">
                    ${p.output_price_per_1m.toFixed(2)}
                  </td>
                  <td className="py-2.5 px-4 text-right font-mono tabular-nums text-slate-600 dark:text-slate-400">
                    {p.max_tokens_limit.toLocaleString()}
                  </td>
                  <td className="py-2.5 px-4 text-right">
                    <button
                      type="button"
                      onClick={() => handleToggleProvider(p.model_name, p.enabled === 0)}
                      className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                        p.enabled === 1
                          ? 'bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-900'
                          : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700'
                      }`}
                    >
                      {p.enabled === 1 ? 'Enabled' : 'Disabled'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Internal Client Keys Management */}
      <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4">
        <div className="flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-slate-500 dark:text-slate-400" />
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Internal Client Gateway Keys
          </h2>
        </div>

        <form onSubmit={handleCreateKey} className="grid grid-cols-1 sm:grid-cols-4 gap-3 items-end">
          <label className="block space-y-1">
            <span className="text-xs text-slate-600 dark:text-slate-400">Service Name</span>
            <input
              type="text"
              value={newKeyName}
              onChange={(e) => setNewKeyName(e.target.value)}
              required
              className="w-full rounded-md border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-1.5 text-xs text-slate-900 dark:text-slate-100"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-slate-600 dark:text-slate-400">Client ID</span>
            <input
              type="text"
              value={newClientId}
              onChange={(e) => setNewClientId(e.target.value)}
              required
              className="w-full rounded-md border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-1.5 text-xs font-mono text-slate-900 dark:text-slate-100"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-slate-600 dark:text-slate-400">Client RPM Limit</span>
            <input
              type="number"
              min="1"
              value={newKeyRpm}
              onChange={(e) => setNewKeyRpm(e.target.value)}
              required
              className="w-full rounded-md border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-1.5 text-xs font-mono text-slate-900 dark:text-slate-100"
            />
          </label>
          <button
            type="submit"
            className="rounded-md bg-slate-900 dark:bg-slate-100 px-4 py-1.5 text-xs font-medium text-white dark:text-slate-900 hover:bg-slate-800 dark:hover:bg-slate-200 transition-colors"
          >
            Issue Client Key
          </button>
        </form>

        {issuedRawKey && (
          <div className="rounded-md border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/40 p-3 text-xs">
            <div className="font-medium text-emerald-800 dark:text-emerald-300">
              Issued New Client API Key (copy now — only SHA-256 hash is stored):
            </div>
            <div className="mt-1 font-mono select-all text-emerald-900 dark:text-emerald-200">
              {issuedRawKey}
            </div>
          </div>
        )}

        {adminToken ? (
          clientKeys.length === 0 ? (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              No custom client keys issued yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400">
                  <tr>
                    <th className="py-2 pr-4 font-medium">Name</th>
                    <th className="py-2 pr-4 font-medium">Client ID</th>
                    <th className="py-2 pr-4 font-medium">Key Prefix</th>
                    <th className="py-2 pr-4 font-medium text-right">RPM Limit</th>
                    <th className="py-2 text-right font-medium">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                  {clientKeys.map((k) => (
                    <tr key={k.id}>
                      <td className="py-2 pr-4 text-slate-800 dark:text-slate-200">{k.key_name}</td>
                      <td className="py-2 pr-4 font-mono text-slate-600 dark:text-slate-400">{k.client_id}</td>
                      <td className="py-2 pr-4 font-mono text-slate-500 dark:text-slate-400">{k.key_prefix}</td>
                      <td className="py-2 pr-4 text-right font-mono tabular-nums text-slate-700 dark:text-slate-300">
                        {k.rpm_limit}
                      </td>
                      <td className="py-2 text-right">
                        <button
                          type="button"
                          onClick={() => handleRevokeKey(k.id)}
                          className="inline-flex items-center gap-1 text-rose-600 dark:text-rose-400 hover:underline"
                        >
                          <Trash2 className="h-3 w-3" />
                          Revoke
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : (
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Sign in as admin to view and manage internal client API keys.
          </p>
        )}
      </div>
    </div>
  );
};
