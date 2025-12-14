import { useNavigate } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import clsx from "clsx";
import type { ReactNode } from "react";
import { Settings } from "lucide-react";
import { updateEngine } from "../../lib/api";
import { useDashboardStore } from "../../state/dashboard-store";
import type { EngineSnapshot } from "../../types/dashboard";
import QuickStatsPanel from "../panels/QuickStatsPanel";
import { ToggleSwitch } from "../ui/ToggleSwitch";
import { Button } from "../ui/Button";

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
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-10 px-6">
      <header className="space-y-2">
        <p className="stat-label">Control deck</p>
        <h1 className="text-3xl font-semibold text-white">Middleware Engines</h1>
        <p className="text-white/70">
          Toggle runtime features, inspect health, and jump into the summary workspace when deeper context work is needed.
        </p>
        <div className="flex flex-wrap gap-3">
          <Button
            variant="danger"
            icon={<Settings className="h-4 w-4" />}
            onClick={() => navigate("/maintenance")}
          >
            Maintenance
          </Button>
        </div>
      </header>

      <section className="grid gap-6 lg:grid-cols-2">
        <EngineCard
          title="Retrieval Engine"
          subtitle="RAG control"
          description="Manages chunk indexing, FAISS search, and context stitching. Disable to run middleware without retrieval."
          state={ragState}
          disabled={status?.runtime?.cloud}
          onToggle={(next) => handleToggle("rag", next)}
          onNavigate={() => navigate("/summary")}
          busy={pendingEngine === "rag" && toggleMutation.isPending}
          stats={ragStats}
          icon={<RagIcon />}
          accent="cyan"
        />

        <EngineCard
          title="Rolling Summary"
          subtitle="Compressor"
          description="Maintains per-session memory and compresses context to fit long prompts. Use the workspace to inspect raw vs compressed prompts."
          state={summaryState}
          onToggle={(next) => handleToggle("summary", next)}
          onNavigate={() => navigate("/summary")}
          busy={pendingEngine === "summary" && toggleMutation.isPending}
          stats={summaryStats}
          icon={<SummaryIcon />}
          accent="emerald"
        />
      </section>

      <QuickStatsPanel />
    </div>
  );
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
}: EngineCardProps) {
  const enabled = state?.enabled ?? false;
  const borderClass = accent === "emerald" ? "border-emerald-400/40" : "border-cyan-400/40";
  const glowClass = accent === "emerald" ? "shadow-[0_0_45px_rgba(16,185,129,0.15)]" : "shadow-[0_0_45px_rgba(44,212,250,0.15)]";
  const statusLabel = enabled ? "Online" : "Offline";
  return (
    <article
      className={clsx(
        "glass-card relative flex h-full cursor-pointer flex-col gap-6 overflow-hidden border bg-night-900/80 p-6 transition hover:border-white/40",
        borderClass,
        glowClass
      )}
      onClick={onNavigate}
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
            label={enabled ? "Online" : "Standby"}
          />
        </div>
      </div>

      <p className="text-white/70">{description}</p>

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
