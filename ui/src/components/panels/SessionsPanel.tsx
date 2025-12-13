import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { purgeSessions, updateSessionContextMode } from "../../lib/api";
import { useDashboardStore } from "../../state/dashboard-store";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Badge } from "../ui/Badge";
import clsx from "clsx";

interface SessionsPanelProps {
  className?: string;
}

export default function SessionsPanel({ className }: SessionsPanelProps) {
  const sessions = useDashboardStore((s) => s.status?.sessions ?? []);
  const history = useDashboardStore((s) => s.history);
  const selected = useDashboardStore((s) => s.selectedSession);
  const selectSession = useDashboardStore((s) => s.selectSession);
  const sessionFilter = useDashboardStore((s) => s.sessionFilter);
  const setSessionFilter = useDashboardStore((s) => s.setSessionFilter);
  const upsertSession = useDashboardStore((s) => s.upsertSession);
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
  const filteredSessions = useMemo(() => {
    if (sessionFilter === "all") return sessions;
    return sessions.filter((session) => session.active_mode === sessionFilter);
  }, [sessions, sessionFilter]);

  const contextMutation = useMutation({
    mutationFn: (payload: { conversationId: string; mode: "raw" | "compressed" | null }) =>
      updateSessionContextMode(payload.conversationId, payload.mode),
    onSuccess: (data, variables) => {
      upsertSession(data.session);
      setPanelMessage(
        variables.mode ? `Session ${variables.conversationId} set to ${variables.mode}.` : "Session mode reset to default."
      );
    },
    onError: (err: unknown) => {
      setPanelMessage(err instanceof Error ? err.message : "Failed to update session mode.");
    },
  });

  const handleModeChange = (conversationId: string, mode: "raw" | "compressed" | null) => {
    contextMutation.mutate({ conversationId, mode });
  };

  return (
    <Card title="Sessions" subtitle="Rolling memory" className={clsx("space-y-5", className)}>
      <div className="flex items-center justify-between rounded-2xl bg-white/5 px-4 py-3">
        <div>
          <p className="stat-label mb-1">Total tracked</p>
          <p className="text-3xl font-semibold text-white">{sessions.length}</p>
        </div>
        <Button variant="ghost" onClick={() => selectSession(null)} className="text-xs px-3 py-1">
          View all
        </Button>
      </div>

      <div className="rounded-2xl border border-white/10 bg-white/5 p-4 space-y-3">
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
              className="flex-1 rounded-xl border border-white/10 bg-night-900/40 px-3 py-2 text-sm text-white"
            />
            <Button variant="ghost" onClick={handlePurgeBefore} loading={purgeMutation.isPending}>
              Cutoff
            </Button>
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-white/10 bg-white/5 p-4 space-y-3">
        <p className="stat-label mb-2">Filter by context mode</p>
        <div className="flex gap-2">
          {["all", "raw", "compressed"].map((mode) => (
            <Button
              key={mode}
              variant={sessionFilter === mode ? "secondary" : "ghost"}
              className="flex-1"
              onClick={() => setSessionFilter(mode as typeof sessionFilter)}
            >
              {mode === "all" ? "All" : mode === "raw" ? "Raw" : "Compressed"}
            </Button>
          ))}
        </div>
      </div>

      <div className="space-y-2 max-h-64 overflow-auto pr-1">
        {filteredSessions.length === 0 && <p className="text-sm text-white/60">No session metadata yet.</p>}
        {filteredSessions.map((session) => (
          <button
            key={session.conversation_id}
            onClick={() => selectSession(session.conversation_id)}
            className={clsx(
              "w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-left transition",
              session.conversation_id === activeId ? "ring-2 ring-accent-secondary/60" : "hover:bg-white/10"
            )}
          >
            <p className="text-sm font-semibold text-white">{session.conversation_id}</p>
            <p className="text-xs text-white/60">{new Date(session.last_activity).toLocaleString()}</p>
            <p className="text-xs text-white/60 mt-1">{session.turn_count} turns · {session.updates} updates</p>
            <div className="mt-2 flex items-center justify-between text-xs text-white/70">
              <span className="flex items-center gap-2">
                Mode
                <Badge tone={session.active_mode === "compressed" ? "info" : "neutral"}>
                  {session.active_mode === "compressed" ? "Compressed" : "Raw"}
                </Badge>
              </span>
              <div className="flex gap-1">
                <Button
                  variant="ghost"
                  className="px-3 py-1 text-xs"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleModeChange(session.conversation_id, "raw");
                  }}
                  loading={contextMutation.isPending && contextMutation.variables?.conversationId === session.conversation_id}
                >
                  Raw
                </Button>
                <Button
                  variant="ghost"
                  className="px-3 py-1 text-xs"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleModeChange(session.conversation_id, "compressed");
                  }}
                  loading={contextMutation.isPending && contextMutation.variables?.conversationId === session.conversation_id}
                >
                  Comp
                </Button>
                <Button
                  variant="ghost"
                  className="px-3 py-1 text-xs"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleModeChange(session.conversation_id, null);
                  }}
                  loading={contextMutation.isPending && contextMutation.variables?.conversationId === session.conversation_id}
                >
                  Reset
                </Button>
              </div>
            </div>
          </button>
        ))}
      </div>

      <div className="rounded-2xl border border-white/10 bg-white/5 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <p className="stat-label">Focused session</p>
          {activeId && <span className="text-xs text-white/70">{activeId}</span>}
        </div>
        {activeId ? (
          <>
            <ul className="space-y-2 text-sm text-white/80">
              {recentForSession.map((entry) => (
                <li key={`${entry.ts}`} className="rounded-xl border border-white/10 bg-night-900/40 px-3 py-2">
                  <p className="text-xs text-white/60">{new Date(entry.ts).toLocaleTimeString()}</p>
                  <p>{entry.path}</p>
                </li>
              ))}
              {recentForSession.length === 0 && <li className="text-white/60">No recent traffic.</li>}
            </ul>
            <Button variant="secondary" loading={purgeMutation.isPending} onClick={handlePurgeSelected} className="w-full">
              Purge selected session
            </Button>
          </>
        ) : (
          <p className="text-sm text-white/60">Select a session to view recent requests.</p>
        )}
        <p className="text-xs text-white/60">{panelMessage}</p>
      </div>
    </Card>
  );
}
