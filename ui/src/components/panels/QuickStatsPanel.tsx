import { useDashboardStore } from "../../state/dashboard-store";
import { Card } from "../ui/Card";

const formatMs = (ms?: number) => (ms ? `${ms.toFixed(1)} ms` : "0 ms");

export default function QuickStatsPanel() {
  const metrics = useDashboardStore((s) => s.metrics);

  if (!metrics) return null;

  const stats = [
    { label: "Requests", value: metrics.totalRequests.toLocaleString(), hint: "since boot" },
    { label: "Errors", value: metrics.totalErrors.toLocaleString(), hint: "total" },
    { label: "Avg Duration", value: formatMs(metrics.avgDurationMs), hint: "moving avg" },
    {
      label: "Budget",
      value: metrics.lastBudget ? `${metrics.lastBudget.usedTokens ?? 0}/${metrics.lastBudget.budgetTokens ?? 0}` : "—",
      hint: "last request",
    },
  ];

  return (
    <Card title="Live Metrics" subtitle="Traffic" className="overflow-hidden">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((stat) => (
          <div key={stat.label} className="rounded-2xl border border-night-800/80 bg-night-900/60 px-4 py-3">
            <p className="stat-label">{stat.label}</p>
            <p className="text-2xl font-semibold text-white">{stat.value}</p>
            <p className="text-xs text-slate-500">{stat.hint}</p>
          </div>
        ))}
      </div>
    </Card>
  );
}
