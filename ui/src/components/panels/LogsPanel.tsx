import clsx from "clsx";
import { useDashboardStore } from "../../state/dashboard-store";
import { Card } from "../ui/Card";

const LEVEL_COLORS: Record<string, string> = {
  info: "text-accent-secondary",
  warn: "text-accent-warning",
  error: "text-accent-danger",
};

export default function LogsPanel() {
  const logs = useDashboardStore((s) => s.logs);
  const logLevel = useDashboardStore((s) => s.logLevel);
  const setLogLevel = useDashboardStore((s) => s.setLogLevel);

  const filtered = logLevel === "all" ? logs : logs.filter((log) => log.level?.toLowerCase() === logLevel);

  return (
    <Card
      title="Logs"
      subtitle="Live"
      action={
        <select
          value={logLevel}
          onChange={(e) => setLogLevel(e.target.value as typeof logLevel)}
          className="rounded-xl border border-night-700 bg-night-900 px-3 py-1 text-xs text-slate-200"
        >
          <option value="all">All</option>
          <option value="info">Info</option>
          <option value="warn">Warning</option>
          <option value="error">Error</option>
        </select>
      }
    >
      <div className="max-h-80 overflow-auto space-y-2 text-sm font-mono">
        {filtered.length === 0 && <p className="text-slate-500">No log entries.</p>}
        {filtered.map((log) => (
          <div key={`${log.ts}-${log.message}`} className="rounded-xl border border-night-800/60 bg-night-900/60 px-3 py-2">
            <p className="flex items-center justify-between text-xs text-slate-500">
              <span>{new Date(log.ts).toLocaleTimeString()}</span>
              <span className={clsx("uppercase", LEVEL_COLORS[log.level] ?? "text-slate-400")}>{log.level}</span>
            </p>
            <p className="text-slate-100">{log.message}</p>
          </div>
        ))}
      </div>
    </Card>
  );
}
