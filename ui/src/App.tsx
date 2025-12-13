import { useEffect, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { bootstrapSnapshot } from "./lib/api";
import { useDashboardSocket } from "./hooks/use-dashboard-socket";
import { useDashboardStore } from "./state/dashboard-store";
import EngineLanding from "./components/workspaces/EngineLanding";
import SummaryWorkspace from "./components/workspaces/SummaryWorkspace";
import MaintenancePage from "./components/workspaces/MaintenancePage";

const RAW_BASE = import.meta.env.BASE_URL || "/";
const ROUTER_BASENAME = RAW_BASE === "/" ? undefined : RAW_BASE.replace(/\/$/, "");

function App() {
  const setSnapshot = useDashboardStore((s) => s.setSnapshot);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [bootstrapped, setBootstrapped] = useState(false);

  useDashboardSocket();

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
      <div className="min-h-screen text-slate-100 flex items-center justify-center">
        <div className="glass-card px-8 py-6 text-center">
          <p className="stat-label mb-2">Initializing dashboard</p>
          <p className="text-2xl font-semibold text-accent-secondary">Connecting…</p>
        </div>
      </div>
    );
  }

  if (bootstrapError) {
    return (
      <div className="min-h-screen text-slate-100 flex items-center justify-center">
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
    <BrowserRouter basename={ROUTER_BASENAME}>
      <div className="min-h-screen bg-night-950 text-slate-50">
        <main className="py-10">
          <Routes>
            <Route path="/" element={<EngineLanding />} />
            <Route path="/summary" element={<SummaryWorkspace />} />
            <Route path="/maintenance" element={<MaintenancePage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}

export default App;
