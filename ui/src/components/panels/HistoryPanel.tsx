import { useDashboardStore } from "../../state/dashboard-store";
import { Card } from "../ui/Card";

const PATH_GROUPS: Record<string, string[]> = {
  query: ["/query", "/v1/chat/completions", "/chat/completions"],
  search: ["/search"],
};

export default function HistoryPanel() {
  const history = useDashboardStore((s) => s.history);
  const historyFilter = useDashboardStore((s) => s.historyFilter);
  const setHistoryFilter = useDashboardStore((s) => s.setHistoryFilter);

  const filtered = history.filter((entry) => {
    if (historyFilter === "all") return true;
    if (historyFilter === "system") {
      return ![...PATH_GROUPS.query, ...PATH_GROUPS.search].includes(entry.path);
    }
    return PATH_GROUPS[historyFilter]?.includes(entry.path) ?? false;
  });

  return (
    <Card
      title="Recent Requests"
      subtitle="History"
      action={
        <select
          value={historyFilter}
          onChange={(e) => setHistoryFilter(e.target.value as typeof historyFilter)}
          className="rounded-xl border border-night-700 bg-night-900 px-3 py-1 text-xs text-slate-200"
        >
          <option value="all">All</option>
          <option value="query">/query + chat</option>
          <option value="search">/search</option>
          <option value="system">System</option>
        </select>
      }
    >
      <div className="max-h-80 overflow-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-400">
              <th className="py-2">Time</th>
              <th>Path</th>
              <th>Session</th>
              <th>Duration</th>
              <th>RAG</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td className="py-4 text-center text-slate-500" colSpan={6}>
                  No history entries.
                </td>
              </tr>
            )}
            {filtered.map((entry) => (
              <tr key={`${entry.ts}-${entry.path}`} className="border-t border-night-900">
                <td className="py-2 text-slate-300">{new Date(entry.ts).toLocaleTimeString()}</td>
                <td className="text-slate-200">{entry.path}</td>
                <td className="text-xs text-slate-500">{entry.sessionId || "—"}</td>
                <td className="text-slate-200">{entry.duration.toFixed(0)} ms</td>
                <td className="text-slate-200">{entry.ragHits}</td>
                <td className={entry.status === 200 ? "text-accent-success" : "text-accent-danger"}>{entry.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
