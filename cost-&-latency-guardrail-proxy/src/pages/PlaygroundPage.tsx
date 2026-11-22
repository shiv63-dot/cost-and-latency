import React, { useState } from 'react';
import { Send } from 'lucide-react';
import { proxyApi } from '../services/api';
import type { ProviderConfig } from '../types/proxy';

interface PlaygroundPageProps {
  providers: ProviderConfig[];
  adminToken: string | null;
  onRequestCompleted: () => void;
}

const PRESETS = [
  {
    label: 'Cold Prompt (ML)',
    model: 'gpt-4o',
    prompt: 'Explain machine learning',
    simulateFailure: false,
  },
  {
    label: 'Semantic Paraphrase (ML)',
    model: 'gpt-4o',
    prompt: 'What is machine learning in simple terms?',
    simulateFailure: false,
  },
  {
    label: 'Semantic Cache Info',
    model: 'gpt-4o',
    prompt: 'How does Redis semantic caching reduce LLM latency?',
    simulateFailure: false,
  },
  {
    label: 'Primary 503 -> Fallback',
    model: 'gpt-4o',
    prompt: 'Summarize how Prometheus histograms measure P95 latency',
    simulateFailure: true,
  },
];

export const PlaygroundPage: React.FC<PlaygroundPageProps> = ({
  providers,
  adminToken,
  onRequestCompleted,
}) => {
  const [model, setModel] = useState('gpt-4o');
  const [systemPrompt, setSystemPrompt] = useState('You are a concise infrastructure engineering assistant.');
  const [userPrompt, setUserPrompt] = useState('Explain machine learning');
  const [temperature, setTemperature] = useState('0.7');
  const [maxTokens, setMaxTokens] = useState('512');
  const [bypassCache, setBypassCache] = useState(false);
  const [simulateFailure, setSimulateFailure] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    status: number;
    headers: Record<string, string>;
    data: unknown;
  } | null>(null);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!adminToken) {
      setError('Sign in or claim admin access above to execute live gateway requests.');
      return;
    }
    setSending(true);
    setError(null);
    try {
      const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
      if (systemPrompt.trim()) {
        messages.push({ role: 'system', content: systemPrompt.trim() });
      }
      messages.push({ role: 'user', content: userPrompt.trim() });

      const res = await proxyApi.sendChatCompletion(
        adminToken,
        {
          model,
          messages,
          temperature: Number(temperature),
          max_tokens: Number(maxTokens),
          allow_fallback: true,
        },
        {
          bypassCache,
          simulatePrimaryFailure: simulateFailure,
          clientId: 'console-tester',
        }
      );

      setResult({
        status: res.status,
        headers: res.responseHeaders,
        data: res.data,
      });
      onRequestCompleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
          Gateway Request Console
        </h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          Send live OpenAI-compatible requests to POST /api/v1/chat/completions and inspect cache lookup, routing, and cost headers.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-slate-500 dark:text-slate-400 mr-1">
          Test scenarios:
        </span>
        {PRESETS.map((preset) => (
          <button
            key={preset.label}
            type="button"
            onClick={() => {
              setModel(preset.model);
              setUserPrompt(preset.prompt);
              setSimulateFailure(preset.simulateFailure);
              setBypassCache(false);
            }}
            className="rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors whitespace-nowrap"
          >
            {preset.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <form
          onSubmit={handleSend}
          className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4"
        >
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <label className="block space-y-1">
              <span className="text-xs font-medium text-slate-600 dark:text-slate-400">
                Requested Model
              </span>
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="w-full rounded-md border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-xs font-mono text-slate-900 dark:text-slate-100"
              >
                {providers.map((p) => (
                  <option key={p.model_name} value={p.model_name}>
                    {p.model_name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-slate-600 dark:text-slate-400">
                Temperature
              </span>
              <input
                type="number"
                step="0.1"
                min="0"
                max="2"
                value={temperature}
                onChange={(e) => setTemperature(e.target.value)}
                className="w-full rounded-md border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-xs font-mono text-slate-900 dark:text-slate-100"
              />
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-slate-600 dark:text-slate-400">
                Max Tokens
              </span>
              <input
                type="number"
                min="1"
                value={maxTokens}
                onChange={(e) => setMaxTokens(e.target.value)}
                className="w-full rounded-md border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-xs font-mono text-slate-900 dark:text-slate-100"
              />
            </label>
          </div>

          <label className="block space-y-1">
            <span className="text-xs font-medium text-slate-600 dark:text-slate-400">
              System Prompt (isolated in cache settings key)
            </span>
            <input
              type="text"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              className="w-full rounded-md border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-xs text-slate-900 dark:text-slate-100"
            />
          </label>

          <label className="block space-y-1">
            <span className="text-xs font-medium text-slate-600 dark:text-slate-400">
              User Prompt
            </span>
            <textarea
              rows={4}
              required
              value={userPrompt}
              onChange={(e) => setUserPrompt(e.target.value)}
              className="w-full rounded-md border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-xs text-slate-900 dark:text-slate-100"
            />
          </label>

          <div className="flex flex-wrap items-center gap-4 text-xs text-slate-700 dark:text-slate-300">
            <label className="inline-flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={bypassCache}
                onChange={(e) => setBypassCache(e.target.checked)}
              />
              <span>Bypass Cache (X-Bypass-Cache)</span>
            </label>
            <label className="inline-flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={simulateFailure}
                onChange={(e) => setSimulateFailure(e.target.checked)}
              />
              <span>Simulate Primary Failure (Test Fallback)</span>
            </label>
          </div>

          {error && (
            <div className="text-xs text-rose-600 dark:text-rose-400">{error}</div>
          )}

          <button
            type="submit"
            disabled={sending}
            className="inline-flex items-center gap-2 rounded-md bg-slate-900 dark:bg-slate-100 px-4 py-2 text-xs font-medium text-white dark:text-slate-900 hover:bg-slate-800 dark:hover:bg-slate-200 disabled:opacity-50 transition-colors"
          >
            <Send className="h-3.5 w-3.5" />
            {sending ? 'Dispatching...' : 'Send POST /api/v1/chat/completions'}
          </button>
        </form>

        <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden flex flex-col">
          <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Gateway Response &amp; Proxy Telemetry
            </h2>
            {result && (
              <span className="text-xs font-mono tabular-nums text-slate-600 dark:text-slate-400">
                HTTP {result.status} · {result.headers.cacheStatus || 'N/A'}
              </span>
            )}
          </div>

          {!result ? (
            <div className="p-8 text-xs text-slate-500 dark:text-slate-400">
              Dispatch a completion request to inspect the standardized OpenAI-compatible payload, cache similarity score, lookup duration, and estimated cost savings.
            </div>
          ) : (
            <div className="p-5 space-y-4 flex-1 overflow-auto">
              <div className="grid grid-cols-2 gap-2 text-xs font-mono">
                <div>
                  <span className="text-slate-500 dark:text-slate-400">X-Request-ID: </span>
                  <span className="text-slate-900 dark:text-slate-100">{result.headers.requestId}</span>
                </div>
                <div>
                  <span className="text-slate-500 dark:text-slate-400">X-Cache-Status: </span>
                  <span className="text-slate-900 dark:text-slate-100">{result.headers.cacheStatus}</span>
                </div>
                <div>
                  <span className="text-slate-500 dark:text-slate-400">X-Proxy-Model-Used: </span>
                  <span className="text-slate-900 dark:text-slate-100">{result.headers.modelUsed || 'N/A'}</span>
                </div>
                <div>
                  <span className="text-slate-500 dark:text-slate-400">X-Cache-Lookup-Ms: </span>
                  <span className="text-slate-900 dark:text-slate-100">{result.headers.cacheLookupMs || '0'} ms</span>
                </div>
              </div>
              <pre className="rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-3 text-xs font-mono overflow-x-auto text-slate-800 dark:text-slate-200 max-h-80">
                {JSON.stringify(result.data, null, 2)}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
