import { useDashboardStore } from "../../state/dashboard-store";
import { Card } from "../ui/Card";

export default function SummaryPanel() {
  const summary = useDashboardStore((s) => s.metrics?.lastSummaryAction ?? s.status?.last_summary);

  return (
    <Card title="Rolling Summary" subtitle="Memory">
      {summary ? (
        <div className="space-y-3 text-sm text-slate-200">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Session {summary.sessionId}</span>
            <span>{new Date(summary.ts).toLocaleTimeString()}</span>
          </div>
          <div className="max-h-72 overflow-auto rounded-2xl border border-night-800/70 bg-night-900/60 p-4 text-slate-100">
            {summary.summaryText || "No summary text."}
          </div>
          <p className="text-xs text-slate-400">
            {summary.turnCount} turns · {summary.summaryLength} chars
          </p>
        </div>
      ) : (
        <p className="text-sm text-slate-400">No summarizer activity yet.</p>
      )}
    </Card>
  );
}
