import { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  Database,
  DollarSign,
  LayoutDashboard,
  ListChecks,
  Moon,
  RefreshCw,
  Shield,
  Sun,
  Terminal,
} from 'lucide-react';
import { AdminAuthBar } from './components/AdminAuthBar';
import { CachePage } from './pages/CachePage';
import { CostsPage } from './pages/CostsPage';
import { GuardrailsPage } from './pages/GuardrailsPage';
import { HealthPage } from './pages/HealthPage';
import { OverviewPage } from './pages/OverviewPage';
import { PlaygroundPage } from './pages/PlaygroundPage';
import { RequestsPage } from './pages/RequestsPage';
import { proxyApi } from './services/api';
import type {
  ApiRequestLog,
  AuthStatus,
  CacheStatsResponse,
  CostAnalyticsResponse,
  DashboardTab,
  GuardrailsStatusResponse,
  OverviewAnalytics,
  ProviderConfig,
  SystemStatusResponse,
  TokenModelBreakdown,
} from './types/proxy';

const NAV_ITEMS: Array<{ id: DashboardTab; label: string; icon: typeof LayoutDashboard }> = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'requests', label: 'API Requests', icon: ListChecks },
  { id: 'cache', label: 'Cache Management', icon: Database },
  { id: 'costs', label: 'Cost Analytics', icon: DollarSign },
  { id: 'guardrails', label: 'Guardrails', icon: Shield },
  { id: 'health', label: 'System Health', icon: Activity },
  { id: 'playground', label: 'Gateway Console', icon: Terminal },
];

export default function App() {
  const [activeTab, setActiveTab] = useState<DashboardTab>('overview');
  const [isDark, setIsDark] = useState<boolean>(true);
  const [adminToken, setAdminToken] = useState<string | null>(null);
  const [authStatus, setAuthStatus] = useState<AuthStatus>({
    configured: false,
    envManaged: false,
    authenticated: false,
  });

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [overview, setOverview] = useState<OverviewAnalytics | null>(null);
  const [requests, setRequests] = useState<ApiRequestLog[]>([]);
  const [cacheStats, setCacheStats] = useState<CacheStatsResponse | null>(null);
  const [costs, setCosts] = useState<CostAnalyticsResponse | null>(null);
  const [tokens, setTokens] = useState<TokenModelBreakdown[]>([]);
  const [guardrails, setGuardrails] = useState<GuardrailsStatusResponse | null>(null);
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [systemStatus, setSystemStatus] = useState<SystemStatusResponse | null>(null);

  useEffect(() => {
    const root = document.documentElement;
    if (isDark) {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
  }, [isDark]);

  const fetchAllData = useCallback(
    async (silent = false) => {
      if (!silent) setRefreshing(true);
      try {
        const [
          authRes,
          overviewRes,
          reqRes,
          cacheRes,
          costsRes,
          tokensRes,
          guardrailsRes,
          providersRes,
          sysRes,
        ] = await Promise.all([
          proxyApi.getAuthStatus(adminToken),
          proxyApi.getOverview(),
          proxyApi.getRequests({ limit: 150 }),
          proxyApi.getCacheStats(),
          proxyApi.getCosts(),
          proxyApi.getTokens(),
          proxyApi.getGuardrailsStatus(),
          proxyApi.getProviders(),
          proxyApi.getSystemStatus(),
        ]);

        setAuthStatus(authRes);
        setOverview(overviewRes);
        setRequests(reqRes.requests);
        setCacheStats(cacheRes);
        setCosts(costsRes);
        setTokens(tokensRes.byModel);
        setGuardrails(guardrailsRes);
        setProviders(providersRes.providers);
        setSystemStatus(sysRes);
      } catch {
        // Keep current rendered data on transient poll failure
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [adminToken]
  );

  useEffect(() => {
    void fetchAllData(false);
    const interval = setInterval(() => {
      void fetchAllData(true);
    }, 10000);
    return () => clearInterval(interval);
  }, [fetchAllData]);

  const activeNav = NAV_ITEMS.find((item) => item.id === activeTab);

  return (
    <div className="min-h-screen flex bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100">
      {/* Left Sidebar (Desktop 256px) */}
      <aside className="hidden md:flex md:w-64 md:flex-col border-r border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shrink-0">
        <div className="h-14 px-5 flex items-center border-b border-slate-200 dark:border-slate-800">
          <span className="font-display text-sm font-semibold tracking-tight text-slate-900 dark:text-slate-100 whitespace-nowrap">
            Guardrail Proxy
          </span>
        </div>

        <nav className="flex-1 p-3 space-y-1">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveTab(item.id)}
                className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                  active
                    ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                    : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-slate-100'
                }`}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="p-4 border-t border-slate-200 dark:border-slate-800 text-xs text-slate-500 dark:text-slate-400 space-y-1">
          <div className="font-medium text-slate-700 dark:text-slate-300">
            Provider Mode
          </div>
          <div className="font-mono">
            {systemStatus?.gateway.providerMode || 'initializing'}
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top Bar Contract */}
        <header className="h-14 px-6 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex items-center justify-between gap-8">
          <div className="flex items-center gap-2 text-xs min-w-0">
            <span className="font-medium text-slate-500 dark:text-slate-400 whitespace-nowrap">
              Cost &amp; Latency Proxy
            </span>
            <span className="text-slate-400" aria-hidden="true">/</span>
            <span className="font-semibold text-slate-900 dark:text-slate-100 truncate">
              {activeNav?.label}
            </span>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={() => setIsDark((prev) => !prev)}
              aria-label="Toggle dark or light theme"
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 dark:border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
            >
              {isDark ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
              <span>{isDark ? 'Light' : 'Dark'}</span>
            </button>

            <button
              type="button"
              onClick={() => void fetchAllData(false)}
              disabled={refreshing}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 dark:border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
              <span>Refresh</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('playground')}
              className="rounded-md bg-slate-900 dark:bg-slate-100 px-4 py-1.5 text-xs font-medium text-white dark:text-slate-900 hover:bg-slate-800 dark:hover:bg-slate-200 transition-colors whitespace-nowrap shrink-0"
            >
              Test Gateway
            </button>
          </div>
        </header>

        {/* Mobile Nav Bar */}
        <div className="md:hidden flex items-center gap-1 overflow-x-auto px-4 py-2 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setActiveTab(item.id)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap shrink-0 ${
                activeTab === item.id
                  ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                  : 'text-slate-600 dark:text-slate-400'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>

        {/* Viewport Content */}
        <main className="flex-1 p-6 max-w-[1440px] w-full mx-auto space-y-6">
          <AdminAuthBar
            authStatus={authStatus}
            token={adminToken}
            onAuthenticated={(token) => {
              setAdminToken(token);
              setAuthStatus((prev) => ({ ...prev, configured: true, authenticated: true }));
            }}
            onSignOut={() => {
              setAdminToken(null);
              setAuthStatus((prev) => ({ ...prev, authenticated: false }));
            }}
          />

          {activeTab === 'overview' && (
            <OverviewPage
              data={overview}
              loading={loading}
              adminToken={adminToken}
              isDark={isDark}
              onDataUpdated={() => void fetchAllData(false)}
              onNavigatePlayground={() => setActiveTab('playground')}
            />
          )}

          {activeTab === 'requests' && (
            <RequestsPage
              requests={requests}
              loading={loading}
              onNavigatePlayground={() => setActiveTab('playground')}
            />
          )}

          {activeTab === 'cache' && (
            <CachePage
              stats={cacheStats}
              loading={loading}
              adminToken={adminToken}
              onCacheCleared={() => void fetchAllData(false)}
            />
          )}

          {activeTab === 'costs' && (
            <CostsPage
              costs={costs}
              tokens={tokens}
              loading={loading}
              isDark={isDark}
            />
          )}

          {activeTab === 'guardrails' && (
            <GuardrailsPage
              guardrails={guardrails}
              providers={providers}
              adminToken={adminToken}
              onUpdated={() => void fetchAllData(false)}
            />
          )}

          {activeTab === 'health' && (
            <HealthPage
              status={systemStatus}
              loading={loading}
              onRefresh={() => void fetchAllData(false)}
            />
          )}

          {activeTab === 'playground' && (
            <PlaygroundPage
              providers={providers}
              adminToken={adminToken}
              onRequestCompleted={() => void fetchAllData(false)}
            />
          )}
        </main>
      </div>
    </div>
  );
}
