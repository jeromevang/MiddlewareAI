import { useMemo } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Card } from "../ui/Card";
import { Button } from "../ui/Button";
import { setTelemetry } from "../../lib/api";
import type { TelemetryStatus } from "../../types/dashboard";
import { Badge } from "../ui/Badge";

interface TelemetryPanelProps {
  telemetry: TelemetryStatus | null;
  isLoading: boolean;
}

export default function TelemetryPanel({ telemetry, isLoading }: TelemetryPanelProps) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (enabled: boolean) => setTelemetry(enabled),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["telemetry"] }),
  });

  const stateLabel = useMemo(() => {
    if (!telemetry) return "Unknown";
    return telemetry.enabled ? "Enabled" : "Disabled";
  }, [telemetry]);

  const envLabel = telemetry?.envFlag || "ENV var unset";
  const overrideLabel = telemetry
    ? telemetry.override === null
      ? "None"
      : telemetry.override
      ? "Force on"
      : "Force off"
    : "Unknown";

  const toggle = () => {
    if (!telemetry) return;
    mutation.mutate(!telemetry.enabled);
  };

  return (
    <Card title="Telemetry" subtitle="Debug logger + heartbeat">
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <Badge tone={telemetry?.enabled ? "info" : "warn"}>{stateLabel}</Badge>
          {telemetry && <Badge tone={telemetry.source === "override" ? "info" : "neutral"}>{telemetry.source}</Badge>}
        </div>
        <dl className="grid grid-cols-1 gap-3 text-sm text-white/80">
          <div className="rounded-2xl border border-white/10 bg-white/5 p-3">
            <dt className="stat-label text-white/60">Override</dt>
            <dd className="text-white">{overrideLabel}</dd>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/5 p-3">
            <dt className="stat-label text-white/60">Env flag</dt>
            <dd className="text-white">{envLabel}</dd>
          </div>
        </dl>
        <Button
          variant={telemetry?.enabled ? "secondary" : "primary"}
          disabled={!telemetry || mutation.isPending}
          loading={mutation.isPending || isLoading}
          onClick={toggle}
        >
          {telemetry?.enabled ? "Disable telemetry" : "Enable telemetry"}
        </Button>
        <p className="text-xs text-slate-500">
          Telemetry forwards lightweight lifecycle events to the local debug logger. Use this toggle when you want to opt in/out
          of the shared diagnostics feed without restarting the middleware server.
        </p>
      </div>
    </Card>
  );
}
