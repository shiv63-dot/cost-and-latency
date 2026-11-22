import React, { useState } from 'react';
import { Lock, ShieldCheck, LogOut } from 'lucide-react';
import type { AuthStatus } from '../types/proxy';
import { proxyApi } from '../services/api';

interface AdminAuthBarProps {
  authStatus: AuthStatus;
  token: string | null;
  onAuthenticated: (token: string) => void;
  onSignOut: () => void;
}

export const AdminAuthBar: React.FC<AdminAuthBarProps> = ({
  authStatus,
  token,
  onAuthenticated,
  onSignOut,
}) => {
  const [passcode, setPasscode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (token && authStatus.authenticated) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-4 py-3">
        <div className="flex items-center gap-2.5 text-sm text-slate-700 dark:text-slate-300">
          <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
          <span>Admin session active in memory</span>
          <span aria-hidden="true" className="text-slate-400">·</span>
          <span className="text-xs text-slate-500 dark:text-slate-400">
            Authorized for guardrail updates, cache clear, and gateway tests
          </span>
        </div>
        <button
          type="button"
          onClick={onSignOut}
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 dark:border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
        >
          <LogOut className="h-3.5 w-3.5" />
          Sign Out
        </button>
      </div>
    );
  }

  const isFirstRunClaim = !authStatus.configured;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = isFirstRunClaim
        ? await proxyApi.claimAdmin(passcode)
        : await proxyApi.loginAdmin(passcode);
      setPasscode('');
      onAuthenticated(res.token);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-4 py-3">
      <form
        onSubmit={handleSubmit}
        className="flex flex-col lg:flex-row lg:items-center justify-between gap-3"
      >
        <div className="flex items-start lg:items-center gap-2.5 text-sm text-slate-700 dark:text-slate-300">
          <Lock className="h-4 w-4 text-slate-500 dark:text-slate-400 mt-0.5 lg:mt-0 shrink-0" />
          <div>
            <span className="font-medium text-slate-900 dark:text-slate-100">
              {isFirstRunClaim
                ? 'First-Run Admin Setup'
                : 'Operator Sign-In Required for Mutations'}
            </span>
            <span className="mx-2 text-slate-400" aria-hidden="true">·</span>
            <span className="text-xs text-slate-500 dark:text-slate-400">
              {isFirstRunClaim
                ? 'Create an admin passcode (min 8 chars) to lock configuration and gateway controls.'
                : authStatus.envManaged
                  ? 'Enter the configured ADMIN_PASSCODE to unlock administrative actions.'
                  : 'Enter your claimed admin passcode to unlock administrative actions.'}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <input
            type="password"
            value={passcode}
            onChange={(e) => setPasscode(e.target.value)}
            placeholder={isFirstRunClaim ? 'Set admin passcode (8+ chars)' : 'Enter admin passcode'}
            minLength={isFirstRunClaim ? 8 : 1}
            required
            className="w-56 rounded-md border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-1.5 text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-900 dark:focus:ring-slate-400"
          />
          <button
            type="submit"
            disabled={submitting}
            className="rounded-md bg-slate-900 dark:bg-slate-100 px-4 py-1.5 text-xs font-medium text-white dark:text-slate-900 hover:bg-slate-800 dark:hover:bg-slate-200 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
          >
            {submitting
              ? 'Verifying...'
              : isFirstRunClaim
                ? 'Claim Admin Access'
                : 'Sign In'}
          </button>
        </div>
      </form>
      {error && (
        <div className="mt-2 text-xs text-rose-600 dark:text-rose-400">{error}</div>
      )}
    </div>
  );
};
