import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { useDashboardStore } from "../../state/dashboard-store";
import { usePreferencesStore } from "../../state/preferences-store";
import type { TelemetryStatus } from "../../types/dashboard";
import { setTelemetry } from "../../lib/api";
import { Activity, WifiOff, Wifi } from "lucide-react";

interface HeaderBarProps {
  telemetry: TelemetryStatus | null;
}

export default function HeaderBar({ telemetry }: HeaderBarProps) {
  const connection = useDashboardStore((s) => s.connection);
  const { apiKey, setApiKey } = usePreferencesStore();
  const [draftKey, setDraftKey] = useState(apiKey);
  const queryClient = useQueryClient();

  useEffect(() => {
    setDraftKey(apiKey);
  }, [apiKey]);

  const telemetryMutation = useMutation({
    mutationFn: setTelemetry,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["telemetry"] }),
  });

  const saveKey = () => {
    setApiKey(draftKey.trim());
  };

  const connectionTone = connection === "open" ? "positive" : connection === "connecting" ? "warn" : "danger";

  return (
    <header className="sticky top-0 z-20 border-b border-night-800/80 bg-night-950/80 backdrop-blur-xl">
      <div className="flex flex-wrap items-center gap-4 px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-accent-primary to-accent-secondary text-night-950 font-black tracking-tight">
            MW
          </div>
          <div>
            <p className="text-sm text-slate-400 uppercase tracking-[0.3em]">Middleware</p>
            <p className="text-xl font-semibold text-white">Ops Console</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Badge tone={connectionTone as never}>
            {connection === "open" ? (
              <span className="inline-flex items-center gap-1"><Wifi className="h-3.5 w-3.5" /> Live</span>
            ) : connection === "connecting" ? (
              <span className="inline-flex items-center gap-1"><Activity className="h-3.5 w-3.5" /> Syncing</span>
            ) : (
              <span className="inline-flex items-center gap-1"><WifiOff className="h-3.5 w-3.5" /> Offline</span>
            )}
          </Badge>
          {telemetry && (
            <Badge tone={telemetry.enabled ? "info" : "warn"}>
              Telemetry: {telemetry.enabled ? telemetry.source : "disabled"}
            </Badge>
          )}
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 rounded-2xl border border-slate-800 bg-night-900 px-3 py-2">
            <input
              value={draftKey}
              onChange={(e) => setDraftKey(e.target.value)}
              placeholder="Bearer token (optional)"
              className="bg-transparent text-sm text-slate-100 outline-none placeholder:text-slate-500"
              type="password"
              autoComplete="off"
            />
            <Button variant="secondary" onClick={saveKey} className="px-3 py-1 text-xs font-semibold">
              Save
            </Button>
          </div>
          <Button
            variant={telemetry?.enabled ? "secondary" : "ghost"}
            onClick={() => telemetryMutation.mutate(!telemetry?.enabled)}
            loading={telemetryMutation.isPending}
          >
            {telemetry?.enabled ? "Disable telemetry" : "Enable telemetry"}
          </Button>
        </div>
      </div>
    </header>
  );
}
