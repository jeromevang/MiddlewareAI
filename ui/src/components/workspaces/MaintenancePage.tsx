import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { deleteAllSessions, reprocessSummaries, updateSummaryKeepRecent } from "../../lib/api";
import { useDashboardStore } from "../../state/dashboard-store";
import SummaryPanel from "../panels/SummaryPanel";
import { Card } from "../ui/Card";
import { Button } from "../ui/Button";
import { ConfirmModal } from "../ui/ConfirmModal";

interface ConfirmConfig {
  title: string;
  description: string;
  tone?: "default" | "danger";
  confirmLabel?: string;
  onConfirm: () => Promise<unknown> | void;
}

export default function MaintenancePage() {
  const navigate = useNavigate();
  const processing = useDashboardStore((s) => s.status?.processing);
  const sessions = useDashboardStore((s) => s.status?.sessions ?? []);
  const selectSession = useDashboardStore((s) => s.selectSession);
  const keepRecentConfigured = processing?.summary_keep_recent_turns ?? 3;
  const [draftKeepRecent, setDraftKeepRecent] = useState(keepRecentConfigured);
  const [settingsMessage, setSettingsMessage] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const [confirmConfig, setConfirmConfig] = useState<ConfirmConfig | null>(null);
  const [confirmLoading, setConfirmLoading] = useState(false);

  useEffect(() => {
    setDraftKeepRecent(keepRecentConfigured);
  }, [keepRecentConfigured]);

  const updateKeepMutation = useMutation({
    mutationFn: (value: number) => updateSummaryKeepRecent(value),
    onSuccess: (data) => {
      useDashboardStore.setState((prev) => {
        if (!prev.status) return prev;
        return {
          status: {
            ...prev.status,
            processing: {
              ...prev.status.processing,
              summary_keep_recent_turns: data.keepRecentTurns,
            },
          },
        };
      });
      setSettingsMessage(`Keep recent set to ${data.keepRecentTurns}.`);
    },
    onError: (err: unknown) => {
      setSettingsMessage(err instanceof Error ? err.message : "Failed to update keep-recent setting.");
    },
  });

  const reprocessMutation = useMutation({
    mutationFn: () => reprocessSummaries(),
    onSuccess: (data) => {
      setSettingsMessage(`Reprocessed ${data.processed} sessions.`);
    },
    onError: (err: unknown) => {
      setSettingsMessage(err instanceof Error ? err.message : "Reprocess failed.");
    },
  });

  const deleteAllMutation = useMutation({
    mutationFn: () => deleteAllSessions(),
    onSuccess: () => {
      setSettingsMessage("Sessions deleted and RAG reset scheduled.");
      selectSession(null);
      queryClient.removeQueries({ queryKey: ["session-turns"] });
      useDashboardStore.setState((prev) => {
        if (!prev.status) return prev;
        return {
          ...prev,
          status: {
            ...prev.status,
            sessions: [],
          },
        };
      });
    },
    onError: (err: unknown) => {
      setSettingsMessage(err instanceof Error ? err.message : "Delete request failed.");
    },
  });

  const openConfirm = (config: ConfirmConfig) => setConfirmConfig(config);
  const closeConfirm = () => {
    if (confirmLoading) return;
    setConfirmConfig(null);
  };

  const runConfirm = async () => {
    if (!confirmConfig) return;
    setConfirmLoading(true);
    try {
      await confirmConfig.onConfirm();
      setConfirmConfig(null);
    } catch (error) {
      console.error(error);
    } finally {
      setConfirmLoading(false);
    }
  };

  const applyKeepRecent = async () => {
    const normalized = Math.max(0, Math.min(10, Number(draftKeepRecent) || 0));
    setDraftKeepRecent(normalized);
    const lowering = normalized < keepRecentConfigured;
    try {
      await updateKeepMutation.mutateAsync(normalized);
      if (lowering) {
        openConfirm({
          title: "Reprocess summaries now?",
          description: "You lowered the raw turn window. Reprocessing keeps summaries aligned with the new window.",
          onConfirm: () => reprocessMutation.mutateAsync(),
        });
      }
    } catch {
      /* handled */
    }
  };

  const maintenanceDisabled = sessions.length === 0;

  return (
    <div className="mx-auto flex h-full w-full max-w-6xl flex-col gap-6 px-6 py-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="stat-label">Maintenance</p>
          <h1 className="text-3xl font-semibold text-white">System maintenance</h1>
          <p className="text-white/70">Adjust compressor settings, reprocess summaries, or wipe caches.</p>
        </div>
        <div className="flex gap-3">
          <Button variant="ghost" onClick={() => navigate("/summary")}>Back to summary</Button>
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-[2fr,1fr]">
        <div className="space-y-6">
          <Card title="Compression control" subtitle="Summary window">
            <div className="space-y-4">
              <p className="text-sm text-white/70">Keep a slice of the latest turns uncompressed before building summaries.</p>
              <div className="flex flex-wrap items-center gap-4">
                <label className="text-xs uppercase tracking-[0.3em] text-white/50" htmlFor="keep-recent-input">
                  Uncompressed turns
                </label>
                <input
                  id="keep-recent-input"
                  type="number"
                  min={0}
                  max={10}
                  value={draftKeepRecent}
                  onChange={(e) => setDraftKeepRecent(Number(e.target.value) || 0)}
                  className="w-24 rounded-xl border border-white/10 bg-night-950/60 px-3 py-2 text-sm text-white"
                />
                <Button variant="secondary" onClick={applyKeepRecent} loading={updateKeepMutation.isPending}>
                  Apply
                </Button>
              </div>
              <p className="text-xs text-white/60">
                Currently keeping <span className="font-semibold text-white">{keepRecentConfigured}</span> turn
                {keepRecentConfigured === 1 ? "" : "s"} raw.
              </p>
            </div>
          </Card>

          <Card title="Emergency actions" subtitle="Danger zone">
            <p className="text-sm text-white/70">Force a refresh of rolling summaries or wipe caches entirely.</p>
            <div className="mt-4 flex flex-col gap-3">
              <Button
                variant="ghost"
                onClick={() =>
                  openConfirm({
                    title: "Reprocess all summaries?",
                    description: "Re-run the summarizer across every session to keep rolling memory aligned.",
                    onConfirm: () => reprocessMutation.mutateAsync(),
                  })
                }
                loading={reprocessMutation.isPending}
                disabled={maintenanceDisabled}
              >
                Reprocess summaries
              </Button>
              <Button
                variant="danger"
                onClick={() =>
                  openConfirm({
                    title: "Delete every session + cache?",
                    description: "This clears SQLite, FAISS, and schedules a reindex. This cannot be undone.",
                    tone: "danger",
                    confirmLabel: "Delete everything",
                    onConfirm: () => deleteAllMutation.mutateAsync(),
                  })
                }
                loading={deleteAllMutation.isPending}
                disabled={maintenanceDisabled}
              >
                Delete all sessions
              </Button>
            </div>
            <p className="mt-3 text-xs text-white/60">
              Sessions present: {sessions.length}. Deleting clears SQLite, FAISS, and triggers a full reindex.
            </p>
          </Card>

          {settingsMessage && <p className="text-sm text-emerald-300/80">{settingsMessage}</p>}
        </div>

        <div className="space-y-6">
          <SummaryPanel />
        </div>
      </div>

      <ConfirmModal
        open={Boolean(confirmConfig)}
        title={confirmConfig?.title ?? ""}
        description={confirmConfig?.description}
        confirmLabel={confirmConfig?.confirmLabel}
        tone={confirmConfig?.tone}
        loading={confirmLoading}
        onConfirm={runConfirm}
        onCancel={closeConfirm}
      />
    </div>
  );
}
