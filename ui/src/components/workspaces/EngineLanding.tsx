import { useNavigate } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import clsx from "clsx";
import type { ReactNode } from "react";
import { Settings, Play, RefreshCw, Zap } from "lucide-react";
import { updateEngine, triggerAction } from "../../lib/api";
import { useDashboardStore } from "../../state/dashboard-store";
import type { EngineSnapshot } from "../../types/dashboard";
import QuickStatsPanel from "../panels/QuickStatsPanel";
import { ToggleSwitch } from "../ui/ToggleSwitch";
import { Button } from "../ui/Button";
import { SystemStatusBanner } from "../ui/SystemStatusBanner";

interface TogglePayload {
  engine: "rag" | "summary";
  enabled: boolean;
  extra?: { clearOnDisable?: boolean };
}

export default function EngineLanding() {
  const status = useDashboardStore((s) => s.status);
  const engines = status?.engines;
  const navigate = useNavigate();

  const toggleMutation = useMutation({
    mutationFn: (payload: TogglePayload) =>
      updateEngine(payload.engine, { enabled: payload.enabled, ...(payload.extra ?? {}) }),
    onSuccess: (data) => {
      if (data?.engines) {
        useDashboardStore.setState((prev) => {
          if (!prev.status) return {};
          return { status: { ...prev.status, engines: data.engines } };
        });
      }
    },
    onError: (err: unknown) => {
      window.alert(err instanceof Error ? err.message : "Failed to update engine state.");
    },
  });

  const ragState = engines?.rag;
  const summaryState = engines?.summary;
  const metricsSnapshot = status?.metrics;
  const storage = status?.storage;
  const contextBudget = status?.context ?? metricsSnapshot?.lastBudget ?? null;

  const ragStats = [
    { label: "Indexed docs", value: formatNumber(storage?.faiss_entries) },
    { label: "Hit rate", value: formatPercent(calcHitRate(metricsSnapshot)) },
  ];

  const summaryStats = [
    { label: "Compression", value: formatPercent(contextBudget?.compressionPct) },
    { label: "Pending", value: formatNumber(metricsSnapshot?.totalErrors) },
  ];

  // Quick actions mutations
  const reindexMutation = useMutation({
    mutationFn: () => triggerAction("reindex"),
    onSuccess: () => {
      // Handle success
    }
  });

  const handleToggle = (engine: "rag" | "summary", enabled: boolean) => {
    if (!engines) return;
    if (!enabled && engine === "rag") {
      const confirmDisable = window.confirm("Disable RAG engine? Indexing and retrieval will pause.");
      if (!confirmDisable) return;
      const clearArtifacts = window.confirm(
        "Clear cached RAG data as well? Choose OK to clear FAISS + SQLite entries, or Cancel to preserve."
      );
      toggleMutation.mutate({ engine, enabled, extra: { clearOnDisable: clearArtifacts } });
      return;
    }
    toggleMutation.mutate({ engine, enabled });
  };

  const pendingEngine = toggleMutation.variables?.engine;

  return (
    <div className="min-h-screen">
      {/* System Status Banner */}
      <SystemStatusBanner />

      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 pb-10">
        {/* Header Section */}
        <header className="space-y-4" role="banner">
          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
            <div>
              <p className="stat-label" id="page-subtitle">Control Center</p>
              <h1 className="text-2xl sm:text-3xl font-semibold text-white" id="page-title">AI Middleware Dashboard</h1>
              <p className="text-white/70 mt-2 text-sm sm:text-base" aria-describedby="page-title">
                Monitor system health, control AI engines, and manage your RAG infrastructure.
              </p>
            </div>

            {/* Quick Actions */}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="primary"
                size="sm"
                icon={<Play className="h-4 w-4" />}
                onClick={() => navigate("/config")}
                className="touch-manipulation min-h-[44px]"
              >
                <span className="hidden sm:inline">Quick Setup</span>
                <span className="sm:hidden">Setup</span>
              </Button>
              <Button
                variant="secondary"
                size="sm"
                icon={<Settings className="h-4 w-4" />}
                onClick={() => navigate("/config")}
                className="touch-manipulation min-h-[44px]"
              >
                <span className="hidden sm:inline">Full Config</span>
                <span className="sm:hidden">Config</span>
              </Button>
              <Button
                variant="ghost"
                size="sm"
                icon={<RefreshCw className="h-4 w-4" />}
                onClick={() => window.location.reload()}
                className="touch-manipulation min-h-[44px]"
              >
                Refresh
              </Button>
            </div>
          </div>
        </header>

        {/* Engine Control Grid */}
        <section className="grid gap-6 lg:grid-cols-2" aria-labelledby="engines-section" role="main">
          <h2 id="engines-section" className="sr-only">Engine Controls</h2>
          <EngineCard
            title="Retrieval Engine"
            subtitle="RAG System"
            description="Manages semantic search, vector indexing, and context retrieval. Powers your AI's knowledge base."
            state={ragState}
            disabled={status?.runtime?.cloud}
            onToggle={(next) => handleToggle("rag", next)}
            onNavigate={() => navigate("/summary")}
            busy={pendingEngine === "rag" && toggleMutation.isPending}
            stats={ragStats}
            icon={<RagIcon />}
            accent="cyan"
            actions={[
              {
                label: "Reindex",
                icon: <RefreshCw className="h-3 w-3" />,
                onClick: () => reindexMutation.mutate(),
                loading: reindexMutation.isPending
              }
            ]}
          />

          <EngineCard
            title="Rolling Summary"
            subtitle="Memory System"
            description="Maintains conversation context and compresses long chat histories for efficient AI responses."
            state={summaryState}
            onToggle={(next) => handleToggle("summary", next)}
            onNavigate={() => navigate("/summary")}
            busy={pendingEngine === "summary" && toggleMutation.isPending}
            stats={summaryStats}
            icon={<SummaryIcon />}
            accent="emerald"
          />
        </section>

        {/* Quick Links */}
        <section className="grid gap-4 lg:grid-cols-3" aria-labelledby="quick-links">
          <h2 id="quick-links" className="sr-only">Quick Links</h2>
          
          <button
            onClick={() => navigate("/config")}
            className="p-4 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 hover:border-white/20 transition-all text-left group"
          >
            <div className="flex items-center gap-3">
              <span className="text-2xl">⚙️</span>
              <div>
                <div className="font-medium text-white group-hover:text-accent-primary transition-colors">
                  Model Configuration
                </div>
                <div className="text-xs text-white/50">
                  Manage presets, models, and RAG pipeline
                </div>
              </div>
            </div>
          </button>
          
          <button
            onClick={() => navigate("/debug")}
            className="p-4 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 hover:border-white/20 transition-all text-left group"
          >
            <div className="flex items-center gap-3">
              <span className="text-2xl">🔧</span>
              <div>
                <div className="font-medium text-white group-hover:text-accent-primary transition-colors">
                  RAG Diagnostics
                </div>
                <div className="text-xs text-white/50">
                  Debug embedder, search, and indexed data
                </div>
              </div>
            </div>
          </button>
          
          <button
            onClick={() => navigate("/summary")}
            className="p-4 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 hover:border-white/20 transition-all text-left group"
          >
            <div className="flex items-center gap-3">
              <span className="text-2xl">📊</span>
              <div>
                <div className="font-medium text-white group-hover:text-accent-primary transition-colors">
                  Session History
                </div>
                <div className="text-xs text-white/50">
                  View conversation turns and summaries
                </div>
              </div>
            </div>
          </button>
          
          <button
            onClick={() => navigate("/settings")}
            className="p-4 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 hover:border-white/20 transition-all text-left group"
          >
            <div className="flex items-center gap-3">
              <span className="text-2xl">⚙️</span>
              <div>
                <div className="font-medium text-white group-hover:text-accent-primary transition-colors">
                  System Settings
                </div>
                <div className="text-xs text-white/50">
                  Context limits, VRAM, model filtering
                </div>
              </div>
            </div>
          </button>
        </section>

        {/* Performance Overview */}
        <section className="space-y-4">
          <h2 className="text-xl font-semibold text-white flex items-center gap-2">
            <Zap className="h-5 w-5 text-accent-secondary" />
            Performance Overview
          </h2>
          <QuickStatsPanel />
        </section>
      </div>
    </div>
  );
}

interface ActionButton {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  loading?: boolean;
  variant?: "primary" | "secondary" | "ghost" | "danger";
}

interface EngineCardProps {
  title: string;
  subtitle: string;
  description: string;
  state?: EngineSnapshot["rag"] | EngineSnapshot["summary"];
  disabled?: boolean;
  onToggle?: (enabled: boolean) => void;
  onNavigate: () => void;
  busy?: boolean;
  stats: StatTile[];
  icon: ReactNode;
  accent?: "cyan" | "emerald";
  actions?: ActionButton[];
}

interface StatTile {
  label: string;
  value: string;
}

function EngineCard({
  title,
  subtitle,
  description,
  state,
  disabled,
  onToggle,
  onNavigate,
  busy,
  stats,
  icon,
  accent = "cyan",
  actions = [],
}: EngineCardProps) {
  const enabled = state?.enabled ?? false;
  const borderClass = accent === "emerald" ? "border-emerald-400/40" : "border-cyan-400/40";
  const glowClass = accent === "emerald" ? "shadow-[0_0_45px_rgba(16,185,129,0.15)]" : "shadow-[0_0_45px_rgba(44,212,250,0.15)]";
  const statusLabel = enabled ? "Online" : "Offline";
  return (
    <article
      className={clsx(
        "glass-card relative flex h-full cursor-pointer flex-col gap-6 overflow-hidden border bg-night-900/80 p-6 transition hover:border-white/40 focus-within:ring-2 focus-within:ring-accent-secondary focus-within:ring-offset-2 focus-within:ring-offset-night-950",
        borderClass,
        glowClass
      )}
      onClick={onNavigate}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onNavigate();
        }
      }}
      tabIndex={0}
      role="button"
      aria-label={`${title} - ${enabled ? 'Enabled' : 'Disabled'}. ${description}`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          <div className="rounded-lg border border-white/10 bg-white/5 p-3 text-accent-secondary">
            {icon}
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.35em] text-white/50">{subtitle}</p>
            <h2 className="text-2xl font-semibold text-white">{title}</h2>
            <div className="flex items-center gap-2 text-xs font-semibold text-white/70">
              <span className={clsx("h-2 w-2 rounded-full", enabled ? "bg-emerald-400" : "bg-rose-400")} />
              {statusLabel}
            </div>
          </div>
        </div>
        <div onClick={(event) => event.stopPropagation()}>
          <ToggleSwitch
            checked={enabled}
            onCheckedChange={(next) => onToggle?.(next)}
            disabled={disabled}
            loading={busy}
            label={`${title} ${enabled ? "Online" : "Standby"}`}
            aria-describedby={`${title.toLowerCase().replace(/\s+/g, '-')}-description`}
          />
        </div>
      </div>

      <p className="text-white/70" id={`${title.toLowerCase().replace(/\s+/g, '-')}-description`}>{description}</p>

      {/* Quick Actions */}
      {actions.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {actions.map((action, index) => (
            <Button
              key={index}
              variant={action.variant || "secondary"}
              size="sm"
              icon={action.icon}
              onClick={(e) => {
                e.stopPropagation();
                action.onClick();
              }}
              loading={action.loading}
            >
              {action.label}
            </Button>
          ))}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {stats.map((tile) => (
          <div key={tile.label} className="rounded-lg border border-white/10 bg-night-950/70 p-4">
            <p className="stat-label mb-1">{tile.label}</p>
            <p className="text-2xl font-semibold text-white">{tile.value}</p>
          </div>
        ))}
      </div>
    </article>
  );
}

function formatNumber(value?: number | null) {
  if (value === null || value === undefined) {
    return "—";
  }
  return value.toLocaleString();
}

function formatPercent(value?: number | null) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "—";
  }
  return `${Math.round(value)}%`;
}

function calcHitRate(metrics?: { totalRequests?: number; totalErrors?: number } | null) {
  if (!metrics || !metrics.totalRequests) return null;
  const errors = metrics.totalErrors ?? 0;
  const hits = Math.max(metrics.totalRequests - errors, 0);
  return (hits / metrics.totalRequests) * 100;
}

function RagIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <path d="M6 4h4l2 4 4-4h2" />
      <path d="M6 20h4l2-4 4 4h2" />
      <path d="M4 9h4l2 6h4l2-6h4" />
    </svg>
  );
}

function SummaryIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <rect x="4" y="4" width="16" height="16" rx="4" />
      <path d="M8 9h8" />
      <path d="M8 12h6" />
      <path d="M8 15h5" />
    </svg>
  );
}
