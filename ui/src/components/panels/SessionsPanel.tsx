import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { purgeSessions } from "../../lib/api";
import { useDashboardStore } from "../../state/dashboard-store";
import { Button } from "../ui/Button";

export default function SessionsPanel() {
  const sessions = useDashboardStore((s) => s.status?.sessions ?? []);
  const history = useDashboardStore((s) => s.history);
  const selected = useDashboardStore((s) => s.selectedSession);
  const selectSession = useDashboardStore((s) => s.selectSession);
  const [cutoff, setCutoff] = useState("");
  const [panelMessage, setPanelMessage] = useState("Rolling summaries stored in SQLite. Purge responsibly.");

  const activeId = selected ?? sessions[0]?.conversation_id ?? null;

  const recentForSession = useMemo(
    () => history.filter((entry) => (activeId ? entry.sessionId === activeId : true)).slice(0, 5),
    [history, activeId]
  );

  const purgeMutation = useMutation({
    mutationFn: (payload: { conversationId?: string | null; beforeTs?: string | null }) => purgeSessions(payload),
    onSuccess: (_data, variables) => {
      if (variables?.conversationId) {
        setPanelMessage(`Purge queued for session ${variables.conversationId}.`);
      } else if (variables?.beforeTs) {
        setPanelMessage(`Purged sessions before ${new Date(variables.beforeTs).toLocaleString()}.`);
      } else {
        setPanelMessage("All sessions purged.");
      }
    },
    onError: (err: unknown) => {
      setPanelMessage(err instanceof Error ? err.message : "Failed to purge sessions.");
    },
  });

  const handlePurgeSelected = () => {
    if (!activeId) return;
    purgeMutation.mutate({ conversationId: activeId });
  };

  const handlePurgeAll = () => {
    purgeMutation.mutate({});
  };

  const handlePurgeBefore = () => {
    if (!cutoff) {
      setPanelMessage("Select a cutoff timestamp first.");
      return;
    }
    const parsed = new Date(cutoff);
    if (Number.isNaN(parsed.getTime())) {
      setPanelMessage("Invalid cutoff timestamp.");
      return;
    }
    purgeMutation.mutate({ beforeTs: parsed.toISOString() });
  };

  return (
    <aside className="hidden lg:flex w-80 flex-col border-r border-night-900 bg-night-950/80">
      <div className="px-5 py-4 border-b border-night-900">
        <p className="stat-label mb-2">Sessions</p>
        <div className="flex items-center justify-between">
          <p className="text-2xl font-semibold text-white">{sessions.length}</p>
          <Button variant="ghost" onClick={() => selectSession(null)} className="text-xs px-3 py-1">
            View all
          </Button>
        </div>
      </div>
      <div className="px-5 py-4 border-b border-night-900 space-y-3">
        <p className="stat-label">Maintenance</p>
        <div className="flex flex-wrap gap-3">
          <Button variant="secondary" onClick={handlePurgeAll} loading={purgeMutation.isPending}>
            Purge all
          </Button>
          <div className="flex flex-1 items-center gap-2">
            <input
              type="datetime-local"
              value={cutoff}
              onChange={(e) => setCutoff(e.target.value)}
              className="flex-1 rounded-xl border border-night-800 bg-night-900 px-3 py-2 text-sm text-slate-100"
            />
            <Button variant="ghost" onClick={handlePurgeBefore} loading={purgeMutation.isPending}>
              Purge before
            </Button>
          </div>
        </div>
      </div>
      <div className="flex-1 overflow-auto divide-y divide-night-900">
        {sessions.map((session) => (
          <button
            key={session.conversation_id}
            onClick={() => selectSession(session.conversation_id)}
            className={`w-full px-5 py-3 text-left ${
              session.conversation_id === activeId ? "bg-night-900/80" : "hover:bg-night-900/40"
            }`}
          >
            <p className="text-sm font-semibold text-white">{session.conversation_id}</p>
            <p className="text-xs text-slate-500">{new Date(session.last_activity).toLocaleString()}</p>
            <p className="text-xs text-slate-400 mt-1">{session.turn_count} turns · {session.updates} updates</p>
          </button>
        ))}
        {sessions.length === 0 && <p className="p-5 text-sm text-slate-500">No session metadata yet.</p>}
      </div>
      <div className="px-5 py-4 border-t border-night-900 space-y-3">
        <p className="stat-label">Focused session</p>
        {activeId ? (
          <>
            <ul className="space-y-2 text-sm text-slate-300">
              {recentForSession.map((entry) => (
                <li key={`${entry.ts}`} className="rounded-xl border border-night-900/80 bg-night-900/60 px-3 py-2">
                  <p className="text-xs text-slate-500">{new Date(entry.ts).toLocaleTimeString()}</p>
                  <p>{entry.path}</p>
                </li>
              ))}
              {recentForSession.length === 0 && <li className="text-slate-500">No recent traffic.</li>}
            </ul>
            <Button
              variant="secondary"
              loading={purgeMutation.isPending}
              onClick={handlePurgeSelected}
              className="w-full"
            >
              Purge selected session
            </Button>
          </>
        ) : (
          <p className="text-sm text-slate-500">Select a session to view recent requests.</p>
        )}
        <p className="text-xs text-slate-500">{panelMessage}</p>
      </div>
    </aside>
  );
}
