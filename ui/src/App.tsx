import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { bootstrapSnapshot, getTelemetryStatus } from "./lib/api";
import { useDashboardSocket } from "./hooks/use-dashboard-socket";
import { useDashboardStore } from "./state/dashboard-store";
import HeaderBar from "./components/layout/HeaderBar";
import HealthGrid from "./components/panels/HealthGrid";
import ContextPanel from "./components/panels/ContextPanel";
import SummaryPanel from "./components/panels/SummaryPanel";
import LogsPanel from "./components/panels/LogsPanel";
import HistoryPanel from "./components/panels/HistoryPanel";
import SessionsPanel from "./components/panels/SessionsPanel";
import ConfigPanel from "./components/panels/ConfigPanel";
import ActionPanel from "./components/panels/ActionPanel";
import TelemetryPanel from "./components/panels/TelemetryPanel";
import QuickStatsPanel from "./components/panels/QuickStatsPanel";

function App() {
  const setSnapshot = useDashboardStore((s) => s.setSnapshot);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [bootstrapped, setBootstrapped] = useState(false);

  useDashboardSocket();

  const telemetryQuery = useQuery({
    queryKey: ["telemetry"],
    queryFn: getTelemetryStatus,
    staleTime: 60_000,
  });

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const snapshot = await bootstrapSnapshot();
        if (!mounted) return;
        setSnapshot(snapshot);
        setBootstrapped(true);
      } catch (err) {
        console.error(err);
        setBootstrapError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      mounted = false;
    };
  }, [setSnapshot]);

  if (!bootstrapped && !bootstrapError) {
    return (
      <div className="min-h-screen bg-night-950 text-slate-100 flex items-center justify-center">
        <div className="glass-card px-8 py-6 text-center">
          <p className="stat-label mb-2">Initializing dashboard</p>
          <p className="text-2xl font-semibold text-accent-secondary">Connecting…</p>
        </div>
      </div>
    );
  }

  if (bootstrapError) {
    return (
      <div className="min-h-screen bg-night-950 text-slate-100 flex items-center justify-center">
        <div className="glass-card px-8 py-6 max-w-lg text-center space-y-4">
          <p className="stat-label mb-2">Dashboard failed to load</p>
          <p className="text-2xl font-semibold text-accent-danger">{bootstrapError}</p>
          <p className="text-sm text-slate-400">
            Ensure the middleware server is running at the same origin and exposes /status, /metrics, /logs, and /history.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-night-950 text-slate-50">
      <div className="flex min-h-screen">
        <SessionsPanel />
        <div className="flex-1 flex flex-col">
          <HeaderBar telemetry={telemetryQuery.data ?? null} />
          <main className="flex-1 p-6 lg:p-8 space-y-6">
            <HealthGrid />
            <QuickStatsPanel />
            <div className="grid gap-6 xl:grid-cols-3">
              <ContextPanel className="xl:col-span-2" />
              <SummaryPanel />
            </div>
            <div className="grid gap-6 lg:grid-cols-2">
              <HistoryPanel />
              <LogsPanel />
            </div>
            <div className="grid gap-6 xl:grid-cols-3">
              <ConfigPanel className="xl:col-span-2" />
              <TelemetryPanel telemetry={telemetryQuery.data ?? null} isLoading={telemetryQuery.isLoading} />
            </div>
            <ActionPanel />
          </main>
        </div>
      </div>
    </div>
  );
}

export default App;
