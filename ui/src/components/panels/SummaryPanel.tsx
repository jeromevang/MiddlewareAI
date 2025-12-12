import { useDashboardStore } from "../../state/dashboard-store";
import { Card } from "../ui/Card";

export default function SummaryPanel() {
  const summary = useDashboardStore((s) => s.metrics?.lastSummaryAction ?? s.status?.last_summary);

  return (
    <Card title="Rolling Summary" subtitle="Memory">
      {summary ? (
        <div className="space-y-3 text-sm text-white/80">
          <div className="flex items-center justify-between text-xs text-white/60">
            <span>Session {summary.sessionId}</span>
            <span>{new Date(summary.ts).toLocaleTimeString()}</span>
          </div>
          <div className="max-h-72 overflow-auto rounded-2xl border border-white/10 bg-white/5 p-4 text-white">
            {summary.summaryText || "No summary text."}
          </div>
          <p className="text-xs text-white/60">
            {summary.turnCount} turns · {summary.summaryLength} chars
          </p>
        </div>
      ) : (
        <p className="text-sm text-white/60">No summarizer activity yet.</p>
      )}
    </Card>
  );
}
