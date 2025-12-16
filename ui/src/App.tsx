import { useEffect, useState, useCallback } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { bootstrapSnapshot } from "./lib/api";
import { useDashboardSocket } from "./hooks/use-dashboard-socket";
import { useDashboardStore } from "./state/dashboard-store";
import { useBootstrapStatus } from "./hooks/use-bootstrap-status";
import EngineLanding from "./components/workspaces/EngineLanding";
import SummaryWorkspace from "./components/workspaces/SummaryWorkspace";
import ConfigWorkspace from "./components/workspaces/ConfigWorkspace";
import DebugWorkspace from "./components/workspaces/DebugWorkspace";
import ModelsWorkspace from "./components/workspaces/ModelsWorkspace";
import { SettingsWorkspace } from "./components/workspaces/SettingsWorkspace";
import { CommandPalette } from "./components/ui/CommandPalette";
import { BootstrapLoadingScreen } from "./components/BootstrapLoadingScreen";
import { Toaster } from "sonner";

const RAW_BASE = import.meta.env.BASE_URL || "/";
const ROUTER_BASENAME = RAW_BASE === "/" ? undefined : RAW_BASE.replace(/\/$/, "");

function App() {
  const setSnapshot = useDashboardStore((s) => s.setSnapshot);
  const [dashboardError, setDashboardError] = useState<string | null>(null);
  const [dashboardReady, setDashboardReady] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [autoBootstrapEnabled, setAutoBootstrapEnabled] = useState(true);

  // Bootstrap status hook - manages the startup loading screen
  const { 
    status: bootstrapStatus, 
    isComplete: bootstrapComplete,
    retry: retryBootstrap,
    skip: skipBootstrap 
  } = useBootstrapStatus({
    enabled: autoBootstrapEnabled,
    onComplete: () => {
      console.log('[App] Bootstrap complete, loading dashboard...');
    },
    onError: (error) => {
      console.error('[App] Bootstrap error:', error);
    }
  });

  // Connect to dashboard WebSocket (for real-time updates after bootstrap)
  useDashboardSocket();

  // Check if auto-bootstrap is enabled in settings
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/config');
        if (res.ok) {
          const config = await res.json();
          const enabled = config.system?.autoBootstrapOnStartup !== false;
          setAutoBootstrapEnabled(enabled);
          
          // If disabled, skip straight to dashboard
          if (!enabled) {
            skipBootstrap();
          }
        }
      } catch (error) {
        // If we can't fetch config, assume bootstrap is enabled
        console.warn('[App] Could not fetch config, assuming auto-bootstrap enabled');
      }
    })();
  }, [skipBootstrap]);

  // Load dashboard data after bootstrap completes
  useEffect(() => {
    if (!bootstrapComplete) return;

    let mounted = true;
    (async () => {
      try {
        const snapshot = await bootstrapSnapshot();
        if (!mounted) return;
        setSnapshot(snapshot);
        setDashboardReady(true);
      } catch (err) {
        console.error('[App] Dashboard load error:', err);
        setDashboardError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      mounted = false;
    };
  }, [bootstrapComplete, setSnapshot]);

  // Global keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Command palette (Ctrl+K or Cmd+K)
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        setCommandPaletteOpen(true);
      }

      // Close command palette with Escape
      if (e.key === 'Escape' && commandPaletteOpen) {
        setCommandPaletteOpen(false);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [commandPaletteOpen]);

  // Handler for skipping bootstrap (only available if configured)
  const handleSkipBootstrap = useCallback(() => {
    skipBootstrap();
  }, [skipBootstrap]);

  // Show bootstrap loading screen while startup is in progress
  if (!bootstrapComplete) {
    return (
      <>
        <BootstrapLoadingScreen 
          status={bootstrapStatus}
          onRetry={retryBootstrap}
          onSkip={handleSkipBootstrap}
          canSkip={false} // Can be enabled via settings in the future
        />
        <Toaster 
          theme="dark" 
          position="bottom-right"
          toastOptions={{
            style: {
              background: '#1a1a2e',
              border: '1px solid rgba(255,255,255,0.1)',
              color: '#fff'
            }
          }}
        />
      </>
    );
  }

  // Show loading while dashboard data is being fetched
  if (!dashboardReady && !dashboardError) {
    return (
      <div className="min-h-screen text-slate-100 flex items-center justify-center bg-gradient-to-br from-gray-950 via-gray-900 to-gray-950">
        <div className="glass-card px-8 py-6 text-center">
          <p className="stat-label mb-2">Loading dashboard</p>
          <p className="text-2xl font-semibold text-accent-secondary">Almost ready…</p>
        </div>
      </div>
    );
  }

  // Show error if dashboard failed to load
  if (dashboardError) {
    return (
      <div className="min-h-screen text-slate-100 flex items-center justify-center bg-gradient-to-br from-gray-950 via-gray-900 to-gray-950">
        <div className="glass-card px-8 py-6 max-w-lg text-center space-y-4">
          <p className="stat-label mb-2">Dashboard failed to load</p>
          <p className="text-2xl font-semibold text-accent-danger">{dashboardError}</p>
          <p className="text-sm text-slate-400">
            Ensure the middleware server is running at the same origin and exposes /status, /metrics, /logs, and /history.
          </p>
          <button
            onClick={() => window.location.reload()}
            className="mt-4 px-4 py-2 bg-accent-primary/20 hover:bg-accent-primary/30 text-accent-primary rounded-lg text-sm transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  // Main app render
  return (
    <BrowserRouter basename={ROUTER_BASENAME}>
      <div className="min-h-screen bg-night-950 text-slate-50">
        <main className="py-10">
          <Routes>
            <Route path="/" element={<EngineLanding />} />
            <Route path="/summary" element={<SummaryWorkspace />} />
            <Route path="/config" element={<ConfigWorkspace />} />
            <Route path="/models" element={<ModelsWorkspace />} />
            <Route path="/debug" element={<DebugWorkspace />} />
            <Route path="/settings" element={<SettingsWorkspace />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>

        {/* Global Command Palette */}
        <CommandPalette
          isOpen={commandPaletteOpen}
          onClose={() => setCommandPaletteOpen(false)}
        />

        {/* Global Toast Notifications */}
        <Toaster 
          theme="dark" 
          position="bottom-right"
          toastOptions={{
            style: {
              background: '#1a1a2e',
              border: '1px solid rgba(255,255,255,0.1)',
              color: '#fff'
            }
          }}
        />
      </div>
    </BrowserRouter>
  );
}

export default App;
