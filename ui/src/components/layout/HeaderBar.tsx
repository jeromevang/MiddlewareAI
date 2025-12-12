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
  const status = useDashboardStore((s) => s.status);
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

  const highlights = [
    {
      label: "Mode",
      value: status?.runtime.mode === "cloud" ? "Cloud" : "Local",
      hint: status?.runtime.rag_enabled ? "RAG enabled" : "RAG off",
    },
    {
      label: "Server",
      value: `:${status?.server.port ?? 0}`,
      hint: status?.lmstudio.healthy ? "LM Studio online" : "LM Studio offline",
    },
    {
      label: "Indexer",
      value: status?.indexingInProgress ? "Running" : "Idle",
      hint: `${status?.processing.max_chunk_size ?? 0} lines/chunk`,
    },
  ];

  return (
    <header className="sticky top-0 z-30 shadow-lg">
      <div className="bg-gradient-to-r from-[#070c18] via-[#101a2e] to-[#1a2f4c] px-8 py-5 text-white">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/15 text-white font-black text-lg">
              MW
            </div>
            <div>
              <p className="text-xs tracking-[0.35em] uppercase text-white/70">Middleware</p>
              <p className="text-2xl font-semibold">Ops Console</p>
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
                Telemetry {telemetry.enabled ? telemetry.source : "disabled"}
              </Badge>
            )}
          </div>

          <div className="ml-auto flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2 rounded-2xl bg-white/15 px-3 py-2 text-sm">
              <input
                value={draftKey}
                onChange={(e) => setDraftKey(e.target.value)}
                placeholder="Bearer token"
                className="bg-transparent text-white placeholder:text-white/60 outline-none"
                type="password"
                autoComplete="off"
              />
              <Button variant="secondary" onClick={saveKey} className="px-3 py-1 text-xs font-semibold text-white">
                Save
              </Button>
            </div>
            <Button
              variant={telemetry?.enabled ? "secondary" : "ghost"}
              onClick={() => telemetryMutation.mutate(!telemetry?.enabled)}
              loading={telemetryMutation.isPending}
              className="text-white"
            >
              {telemetry?.enabled ? "Disable telemetry" : "Enable telemetry"}
            </Button>
          </div>
        </div>
      </div>

      <div className="border-b border-white/10 bg-night-950/80 px-8 py-4 backdrop-blur">
        <div className="grid gap-4 md:grid-cols-3">
          {highlights.map((tile) => (
            <div key={tile.label} className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
              <p className="stat-label text-white/60">{tile.label}</p>
              <p className="text-xl font-semibold text-white">{tile.value}</p>
              <p className="text-xs text-white/60">{tile.hint}</p>
            </div>
          ))}
        </div>
      </div>
    </header>
  );
}
