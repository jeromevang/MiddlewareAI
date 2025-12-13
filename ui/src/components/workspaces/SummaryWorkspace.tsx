import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import clsx from "clsx";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { deleteAllSessions, fetchSessionTurns, reprocessSummaries, updateSummaryKeepRecent } from "../../lib/api";
import { useDashboardStore } from "../../state/dashboard-store";
import type { BudgetInfo, ConversationTurn, SessionMeta } from "../../types/dashboard";
import { Card } from "../ui/Card";
import { Button } from "../ui/Button";
import { ToggleSwitch } from "../ui/ToggleSwitch";

export default function SummaryWorkspace() {
  const sessions = useDashboardStore((s) => s.status?.sessions ?? []);
  const selectedSession = useDashboardStore((s) => s.selectedSession);
  const selectSession = useDashboardStore((s) => s.selectSession);
  const processing = useDashboardStore((s) => s.status?.processing);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const keepRecentConfigured = processing?.summary_keep_recent_turns ?? 3;
  const [draftKeepRecent, setDraftKeepRecent] = useState(keepRecentConfigured);
  const [settingsMessage, setSettingsMessage] = useState<string | null>(null);

  useEffect(() => {
    setDraftKeepRecent(keepRecentConfigured);
  }, [keepRecentConfigured]);

  useEffect(() => {
    if (!selectedSession && sessions[0]) {
      selectSession(sessions[0].conversation_id);
    }
  }, [selectedSession, selectSession, sessions]);

  const activeSessionId = selectedSession ?? sessions[0]?.conversation_id ?? null;
  const turnsQuery = useQuery({
    queryKey: ["session-turns", activeSessionId],
    queryFn: () => (activeSessionId ? fetchSessionTurns(activeSessionId, { limit: 200 }) : null),
    enabled: Boolean(activeSessionId),
    staleTime: 15_000,
  });

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
      latestTurnIdRef.current = null;
      setActiveTurnId(null);
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

  const applyKeepRecent = async () => {
    const normalized = Math.max(0, Math.min(10, Number(draftKeepRecent) || 0));
    setDraftKeepRecent(normalized);
    const lowering = normalized < keepRecentConfigured;
    try {
      await updateKeepMutation.mutateAsync(normalized);
      if (lowering) {
        const shouldReprocess = window.confirm(
          "Lowering this value compresses more history. Reprocess summaries now to stay consistent?"
        );
        if (shouldReprocess) {
          await reprocessMutation.mutateAsync();
        }
      }
    } catch {
      /* handled by mutations */
    }
  };

  const turns = turnsQuery.data?.turns ?? [];
  const [activeTurnId, setActiveTurnId] = useState<number | null>(null);
  const latestTurnIdRef = useRef<number | null>(null);

  useEffect(() => {
    latestTurnIdRef.current = null;
    setActiveTurnId(null);
  }, [activeSessionId]);

  useEffect(() => {
    if (!turns.length) {
      setActiveTurnId(null);
      latestTurnIdRef.current = null;
      return;
    }
    const latestId = turns[0].id;
    if (latestTurnIdRef.current === null) {
      latestTurnIdRef.current = latestId;
      setActiveTurnId((prev) => (prev === null ? latestId : prev));
      return;
    }
    if (latestTurnIdRef.current !== latestId) {
      latestTurnIdRef.current = latestId;
      setActiveTurnId(latestId);
      return;
    }
    if (activeTurnId && !turns.some((t) => t.id === activeTurnId)) {
      setActiveTurnId(latestId);
    }
  }, [turns, activeTurnId]);

  const activeTurn = useMemo(() => turns.find((t) => t.id === activeTurnId) ?? turns[0] ?? null, [turns, activeTurnId]);

  if (!sessions.length) {
    return (
      <div className="mx-auto max-w-5xl px-6">
        <Card title="Summary Workspace" subtitle="Compression lab">
          <p className="text-white/70">
            No sessions found yet. Trigger a /query call so rolling summaries and context snapshots can be inspected here.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button onClick={() => navigate("/")}>Back to engines</Button>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-6 pb-12">
      <header className="space-y-2">
        <p className="stat-label">Summary workspace</p>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-semibold text-white">Context compression lab</h1>
            <p className="text-white/70">
              Compare raw transcripts vs. composed prompts, inspect token budgets, and review which RAG chunks made it into
              the final payload.
            </p>
          </div>
          <Button variant="ghost" onClick={() => navigate("/")}>
            Back to engines
          </Button>
        </div>
      </header>

      <SummarySettings
        keepRecent={keepRecentConfigured}
        draftValue={draftKeepRecent}
        onDraftChange={setDraftKeepRecent}
        onApply={applyKeepRecent}
        isUpdating={updateKeepMutation.isPending}
        isReprocessing={reprocessMutation.isPending}
        onReprocess={() => reprocessMutation.mutate()}
        onDeleteAll={() => deleteAllMutation.mutate()}
        isDeleting={deleteAllMutation.isPending}
        message={settingsMessage}
      />

      <div className="grid gap-6 xl:grid-cols-[260px,minmax(0,1fr)]">
        <SessionSidebar
          sessions={sessions}
          selectedSessionId={activeSessionId}
          onSelectSession={selectSession}
          turns={turns}
          selectedTurnId={activeTurn?.id ?? null}
          onSelectTurn={(id) => setActiveTurnId(id)}
          isLoading={turnsQuery.isLoading}
          onRefresh={() => turnsQuery.refetch()}
        />

        <ContextInspector
          turn={activeTurn}
          turns={turns}
          isLoading={turnsQuery.isLoading}
          keepRecent={keepRecentConfigured}
        />
      </div>
    </div>
  );
}

interface SessionSidebarProps {
  sessions: SessionMeta[];
  selectedSessionId: string | null;
  onSelectSession: (id: string | null) => void;
  turns: ConversationTurn[];
  selectedTurnId: number | null;
  onSelectTurn: (id: number) => void;
  isLoading: boolean;
  onRefresh: () => void;
}

interface SummarySettingsProps {
  keepRecent: number;
  draftValue: number;
  onDraftChange: (value: number) => void;
  onApply: () => void;
  isUpdating: boolean;
  isReprocessing: boolean;
  onReprocess: () => void;
  onDeleteAll: () => void;
  isDeleting: boolean;
  message: string | null;
}

function SummarySettings({
  keepRecent,
  draftValue,
  onDraftChange,
  onApply,
  isUpdating,
  isReprocessing,
  onReprocess,
  onDeleteAll,
  isDeleting,
  message,
}: SummarySettingsProps) {
  const [collapsed, setCollapsed] = useState(true);
  return (
    <Card
      title="Compression control"
      subtitle="Summary window + emergency actions"
      action={
        <Button variant="ghost" className="text-xs" onClick={() => setCollapsed((prev) => !prev)}>
          {collapsed ? "Expand" : "Collapse"}
        </Button>
      }
    >
      <div
        className={clsx(
          "space-y-4 transition-all duration-300",
          collapsed ? "pointer-events-none max-h-0 overflow-hidden opacity-0" : "opacity-100"
        )}
      >
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.2fr),minmax(0,0.8fr)]">
          <div className="rounded-2xl border border-white/10 bg-night-900/60 p-4">
            <p className="text-sm text-white/70">Keep a slice of the latest turns uncompressed before building summaries.</p>
            <div className="mt-4 flex flex-wrap items-center gap-4">
              <label className="text-xs uppercase tracking-[0.3em] text-white/50" htmlFor="keep-recent-input">
                Uncompressed turns
              </label>
              <input
                id="keep-recent-input"
                type="number"
                min={0}
                max={10}
                value={draftValue}
                onChange={(e) => onDraftChange(Number(e.target.value) || 0)}
                className="w-24 rounded-xl border border-white/10 bg-night-950/60 px-3 py-2 text-sm text-white"
              />
              <Button variant="secondary" onClick={onApply} loading={isUpdating}>
                Apply
              </Button>
            </div>
            <p className="mt-3 text-xs text-white/60">
              Currently keeping <span className="font-semibold text-white">{keepRecent}</span> turn{keepRecent === 1 ? "" : "s"} raw.
            </p>
          </div>

          <div className="rounded-2xl border border-white/10 bg-gradient-to-br from-rose-600/10 via-transparent to-fuchsia-500/10 p-4">
            <p className="text-sm font-semibold text-white">Maintenance</p>
            <p className="text-xs text-white/60">Run a fresh summary pass or wipe all sessions + RAG caches.</p>
            <div className="mt-4 flex flex-col gap-3">
              <Button variant="ghost" onClick={onReprocess} loading={isReprocessing}>
                Reprocess summaries
              </Button>
              <Button variant="danger" onClick={onDeleteAll} loading={isDeleting}>
                Delete all sessions
              </Button>
            </div>
            <p className="mt-3 text-xs text-white/60">
              Deleting sessions clears SQLite, FAISS, and schedules a full reindex.
            </p>
          </div>
        </div>
      </div>
      {message && <p className="text-xs text-emerald-300/80">{message}</p>}
    </Card>
  );
}

function SessionSidebar({
  sessions,
  selectedSessionId,
  onSelectSession,
  turns,
  selectedTurnId,
  onSelectTurn,
  isLoading,
  onRefresh,
}: SessionSidebarProps) {
  return (
    <div className="space-y-4 self-start xl:sticky xl:top-8">
      <Card title="Sessions" subtitle="Rolling memory">
        <div className="flex flex-col gap-2 max-h-[30rem] overflow-auto pr-1">
          {sessions.map((session) => (
            <button
              key={session.conversation_id}
              onClick={() => onSelectSession(session.conversation_id)}
              className={`rounded-lg border px-4 py-3 text-left transition ${
                session.conversation_id === selectedSessionId
                  ? "border-accent-secondary/60 bg-accent-secondary/10"
                  : "border-white/10 bg-white/5 hover:bg-white/10"
              }`}
            >
              <p className="text-sm font-semibold text-white">{session.conversation_id}</p>
              <p className="text-xs text-white/60">{new Date(session.last_activity).toLocaleString()}</p>
              <p className="text-xs text-white/50 mt-1">{session.turn_count} turns | {session.updates} updates</p>
            </button>
          ))}
        </div>
      </Card>

      <Card
        title="Turn timeline"
        subtitle={isLoading ? "Loading..." : `Showing ${turns.length} turns`}
        action={
          <Button variant="ghost" className="px-3 py-1 text-xs" onClick={onRefresh} disabled={isLoading}>
            Refresh
          </Button>
        }
      >
        <div className="max-h-[420px] space-y-2 overflow-auto pr-1">
          {turns.map((turn) => {
            const previewSegment = formatSegmentFromRaw(turn.userPrompt || "", "user");
            const previewText = ensureSegmentDisplay(previewSegment);
            return (
              <button
                key={turn.id}
                onClick={() => onSelectTurn(turn.id)}
                className={`w-full rounded-lg border px-4 py-3 text-left transition ${
                  turn.id === selectedTurnId ? "border-accent-secondary/60 bg-accent-secondary/10" : "border-white/10 bg-white/5"
                }`}
              >
                <p className="text-sm font-semibold text-white">Turn {turn.turnIndex}</p>
                <p className="text-xs text-white/60">{new Date(turn.createdAt).toLocaleTimeString()}</p>
                <p className="text-xs text-white/60 mt-1">
                  Tokens {turn.budget?.usedTokens ?? "-"}/{turn.budget?.budgetTokens ?? "-"}
                </p>
                <p className="text-xs text-white/60 truncate">Prompt: {previewText.slice(0, 80) || "(empty)"}</p>
              </button>
            );
          })}
          {!turns.length && <p className="text-sm text-white/60">No turns recorded for this session yet.</p>}
        </div>
      </Card>
    </div>
  );
}

interface ContextInspectorProps {
  turn: ConversationTurn | null;
  turns: ConversationTurn[];
  isLoading: boolean;
  keepRecent: number;
}

function ContextInspector({ turn, turns, isLoading, keepRecent }: ContextInspectorProps) {
  const [compressionActive, setCompressionActive] = useState(turn?.compressionMode === "compressed");

  useEffect(() => {
    setCompressionActive((turn?.compressionMode ?? "").toLowerCase() === "compressed");
  }, [turn?.compressionMode, turn?.id]);

  const { fullHistory, compressedHistory } = useMemo(() => {
    if (!turn) {
      return {
        fullHistory: [] as ConversationTurn[],
        compressedHistory: [] as ConversationTurn[],
      };
    }
    const sorted = [...turns]
      .filter((entry) => entry.turnIndex <= turn.turnIndex)
      .sort((a, b) => a.turnIndex - b.turnIndex);

    const keepWindow = Math.max(keepRecent, 0);
    const minTurnIndex = Math.max(turn.turnIndex - keepWindow + 1, 1);
    const windowFiltered = keepWindow === 0 ? [] : sorted.filter((entry) => entry.turnIndex >= minTurnIndex);
    return {
      fullHistory: sorted,
      compressedHistory: windowFiltered,
    };
  }, [turns, turn?.turnIndex, turn?.id, keepRecent]);

  if (isLoading && !turn) {
    return (
      <Card title="Context" subtitle="Inspect composition">
        <p className="text-white/60">Loading the latest raw stream…</p>
      </Card>
    );
  }

  if (!turn) {
    return (
      <Card title="Context" subtitle="Inspect composition">
        <p className="text-white/60">Select a turn to preview the raw stream alongside the result view.</p>
      </Card>
    );
  }

  const rawSummarySection = extractSection(turn.rawContext, "Rolling summary");
  const rawSummary = rawSummarySection ? rawSummarySection.trim() : "";
  const rawTokens = turn.budget?.rawTokens ?? null;
  const compressedTokens = turn.budget?.usedTokens ?? null;
  const timestamp = new Date(turn.createdAt).toLocaleString();

  return (
    <div className="space-y-6">
      <Card title={`Session ${turn.conversationId}`} subtitle={`Turn ${turn.turnIndex}`}>
        <div className="flex flex-wrap items-center justify-between gap-4 text-sm text-white/70">
          <div className="flex flex-wrap items-center gap-4">
            <span>{timestamp}</span>
            <span>RAG chunks: {turn.ragChunks.length}</span>
          </div>
          <ToggleSwitch
            checked={compressionActive}
            onCheckedChange={setCompressionActive}
            label={compressionActive ? "Compressed" : "Raw pass-through"}
          />
        </div>
      </Card>

      <SummaryColumns
        rawSummary={rawSummary}
        rawHistory={fullHistory}
        compressedHistory={compressedHistory}
        compressionActive={compressionActive}
        rawTokens={rawTokens}
        compressedTokens={compressedTokens}
      />

      <div className="grid gap-6 xl:grid-cols-2">
        <BudgetSummary budget={turn.budget} />
        <RagPanel chunks={turn.ragChunks} />
      </div>
    </div>
  );
}

function RagPanel({ chunks }: { chunks: ConversationTurn["ragChunks"] }) {
  return (
    <Card title="RAG provenance" subtitle="Chunks linked into this turn">
      {chunks.length === 0 ? (
        <p className="text-sm text-white/60">No RAG chunks referenced.</p>
      ) : (
        <ul className="space-y-3 text-sm">
          {chunks.map((chunk, idx) => (
            <li key={`${chunk.filePath}-${idx}`} className="rounded-lg border border-white/10 bg-white/5 p-4">
              <p className="font-semibold text-white">{chunk.filePath}</p>
              {typeof chunk.distance === "number" && (
                <p className="text-xs text-white/60">Score {chunk.distance.toFixed(4)}</p>
              )}
              {chunk.summaryText && <p className="text-xs text-white/70 mt-2">{chunk.summaryText}</p>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

interface SummaryColumnsProps {
  rawSummary: string;
  rawHistory: ConversationTurn[];
  compressedHistory: ConversationTurn[];
  compressionActive: boolean;
  rawTokens: number | null;
  compressedTokens: number | null;
}

function SummaryColumns({
  rawSummary,
  rawHistory,
  compressedHistory,
  compressionActive,
  rawTokens,
  compressedTokens,
}: SummaryColumnsProps) {
  const rawTranscript = useMemo(() => buildTranscript(rawHistory), [rawHistory]);
  const compressedTranscript = useMemo(() => buildTranscript(compressedHistory), [compressedHistory]);
  const rawTranscriptText = useMemo(() => rawTranscript.map((msg) => msg.text).join(" "), [rawTranscript]);
  const highlightMap = useMemo(() => buildHighlightMap(rawSummary, rawTranscriptText), [rawSummary, rawTranscriptText]);
  const highlightedSummaryNode = useMemo(() => highlightText(rawSummary || "(no summary)", highlightMap), [rawSummary, highlightMap]);

  return (
    <div className="grid gap-6 xl:grid-cols-2">
      <ChatColumn
        title="Uncompressed"
        badge="Raw stream"
        tokens={rawTokens}
        transcript={rawTranscript}
        showSummary={false}
        showBoundary={false}
        highlightMap={highlightMap}
      />
      <ChatColumn
        title="Compressed"
        badge="Compressed stream"
        summaryNode={highlightedSummaryNode}
        tokens={compressedTokens}
        transcript={compressedTranscript}
        dimmed={!compressionActive}
        showBoundary
      />
    </div>
  );
}

type TranscriptRole = "user" | "assistant" | "systemReminder";

type TranscriptMessage = {
  id: string;
  turnIndex: number;
  role: TranscriptRole;
  text: string;
  rawText: string;
  tags: string[];
};

interface ChatColumnProps {
  title: string;
  badge: string;
  summaryNode?: ReactNode;
  tokens: number | null;
  transcript: TranscriptMessage[];
  dimmed?: boolean;
  showSummary?: boolean;
  showBoundary?: boolean;
  highlightMap?: Map<string, string>;
}

function ChatColumn({
  title,
  badge,
  summaryNode = null,
  tokens,
  transcript,
  dimmed,
  showSummary = true,
  showBoundary = true,
  highlightMap,
}: ChatColumnProps) {
  return (
    <Card
      className={clsx("space-y-4", dimmed && "opacity-60")}
      title={title}
      subtitle={badge}
      action={<TokenPill tokens={tokens} />}
    >
      <div className="space-y-4 rounded-2xl border border-white/10 bg-night-950/50 p-4">
        {showSummary && summaryNode && (
          <ChatBubble variant="system" label="Rolling summary" copyable={false}>
            {summaryNode}
          </ChatBubble>
        )}
        {showBoundary && <CompressionBoundary label="Compression boundary" />}
        <div className="space-y-3">
          {transcript.map((entry) => (
            <ChatBubble
              key={entry.id}
              variant={entry.role === "systemReminder" ? "systemReminder" : entry.role}
              label={buildChatLabel(entry.role, entry.turnIndex)}
              copyValue={entry.rawText || entry.text}
              tags={entry.tags}
              className="whitespace-pre-wrap"
            >
              {highlightText(entry.text, highlightMap)}
            </ChatBubble>
          ))}
        </div>
      </div>
    </Card>
  );
}

interface ChatBubbleProps {
  variant: "user" | "assistant" | "system" | "systemReminder";
  label: string;
  copyValue?: string;
  copyable?: boolean;
  className?: string;
  children?: ReactNode;
  tags?: string[];
}

function ChatBubble({ variant, label, copyValue, copyable = true, className, children, tags = [] }: ChatBubbleProps) {
  const isSystemwide = variant === "system" || variant === "systemReminder";
  const alignment = variant === "user" ? "items-end text-right" : "items-start text-left";
  const offsets = variant === "user" ? "ml-10" : isSystemwide ? "" : "mr-10";
  const palette = {
    user: "bg-white/5 border-white/10",
    assistant: "bg-emerald-500/10 border-emerald-400/40",
    system: "bg-sky-500/10 border-sky-400/40",
    systemReminder: "bg-amber-500/10 border-amber-400/40",
  } as const;
  const handleCopy = () => {
    if (!copyable || !copyValue) return;
    copyToClipboard(copyValue);
  };
  return (
    <div className={clsx("flex flex-col gap-2", alignment, offsets)}>
      <span className="text-[0.6rem] uppercase tracking-[0.35em] text-white/50">{label}</span>
      <div
        className={clsx(
          "rounded-2xl border px-4 py-3 text-sm text-white/80 shadow-inner",
          isSystemwide ? "w-full max-w-full" : "max-w-[90%] sm:max-w-[70%]",
          copyable && copyValue ? "cursor-pointer" : "cursor-default",
          palette[variant],
          className
        )}
        onClick={handleCopy}
        role={copyable ? "button" : undefined}
        tabIndex={copyable ? 0 : -1}
      >
        {tags.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2 text-[0.55rem] uppercase tracking-[0.3em] text-white/60">
            {tags.map((tag, idx) => (
              <span key={`${tag}-${idx}`} className="rounded-full border border-white/15 bg-white/5 px-2 py-0.5">
                {tag.replace(/_/g, " ")}
              </span>
            ))}
          </div>
        )}
        {children}
      </div>
      {copyable && copyValue && <span className="text-[0.55rem] text-white/35">Click to copy</span>}
    </div>
  );
}

function CompressionBoundary({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 text-[0.6rem] uppercase tracking-[0.35em] text-emerald-300/70">
      <span className="h-px flex-1 bg-gradient-to-r from-transparent via-emerald-300/60 to-transparent" />
      {label}
      <span className="h-px flex-1 bg-gradient-to-r from-transparent via-emerald-300/60 to-transparent" />
    </div>
  );
}

function TokenPill({ tokens }: { tokens: number | null }) {
  return (
    <span className="rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs uppercase tracking-[0.3em] text-white/70">
      Total tokens {tokens ?? "—"}
    </span>
  );
}

function buildTranscript(entries: ConversationTurn[]): TranscriptMessage[] {
  const messages: TranscriptMessage[] = [];
  entries.forEach((entry) => {
    const userSegments = splitSystemReminderSegments(entry.userPrompt || "", "user");
    userSegments.forEach((segment, idx) => {
      const parsed = formatSegmentFromRaw(segment.text, segment.role);
      messages.push({
        id: `${entry.id}-u-${idx}-${parsed.role}`,
        turnIndex: entry.turnIndex,
        role: parsed.role,
        text: ensureSegmentDisplay(parsed),
        rawText: parsed.rawText,
        tags: parsed.tags,
      });
    });

    const assistantSegments = splitSystemReminderSegments(entry.assistantResponse || "", "assistant");
    assistantSegments.forEach((segment, idx) => {
      const parsed = formatSegmentFromRaw(segment.text, segment.role);
      messages.push({
        id: `${entry.id}-a-${idx}-${parsed.role}`,
        turnIndex: entry.turnIndex,
        role: parsed.role,
        text: ensureSegmentDisplay(parsed),
        rawText: parsed.rawText,
        tags: parsed.tags,
      });
    });
  });
  return messages;
}

function buildChatLabel(role: TranscriptMessage["role"], turnIndex: number) {
  if (role === "systemReminder") {
    return `System reminder · Turn ${turnIndex}`;
  }
  const title = role === "user" ? "User" : "Assistant";
  return `${title} · Turn ${turnIndex}`;
}

const SUMMARY_SECTION_HEADINGS = ["Rolling summary", "Recent turns", "RAG context", "User prompt"];
const HIGHLIGHT_COLORS = ["#34d399", "#f97316", "#60a5fa", "#f472b6", "#c084fc", "#facc15", "#a855f7"];

function buildHighlightMap(summaryText: string, transcriptText: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!summaryText || !transcriptText) {
    return map;
  }
  const wordRegex = /\b\w{4,}\b/g;
  const summaryWords = summaryText.toLowerCase().match(wordRegex) || [];
  const transcriptWords = new Set(transcriptText.toLowerCase().match(wordRegex) || []);
  summaryWords.forEach((word) => {
    if (transcriptWords.has(word) && !map.has(word)) {
      const color = HIGHLIGHT_COLORS[map.size % HIGHLIGHT_COLORS.length];
      map.set(word, color);
    }
  });
  return map;
}

function highlightText(text: string, colorMap?: Map<string, string>): ReactNode {
  if (!text) {
    return <span className="text-white/50">(empty)</span>;
  }
  if (!colorMap || colorMap.size === 0) {
    return renderPlainText(text);
  }

  const lines = text.split("\n");
  const nodes: ReactNode[] = [];
  lines.forEach((line, lineIdx) => {
    const parts = line.split(/(\b\w+\b)/g).map((token, idx) => {
      if (!token) return null;
      const color = colorMap.get(token.toLowerCase());
      if (color) {
        return (
          <span key={`hl-${lineIdx}-${idx}`} className="font-semibold" style={{ color }}>
            {token}
          </span>
        );
      }
      return <span key={`tx-${lineIdx}-${idx}`}>{token}</span>;
    });
    nodes.push(<span key={`line-${lineIdx}`}>{parts}</span>);
    if (lineIdx < lines.length - 1) {
      nodes.push(<br key={`br-${lineIdx}`} />);
    }
  });
  return <>{nodes}</>;
}

function renderPlainText(text: string): ReactNode {
  const lines = text.split("\n");
  const nodes: ReactNode[] = [];
  lines.forEach((line, idx) => {
    nodes.push(<span key={`plain-${idx}`}>{line}</span>);
    if (idx < lines.length - 1) {
      nodes.push(<br key={`plain-br-${idx}`} />);
    }
  });
  return <>{nodes}</>;
}

function extractSection(text: string, heading: string) {
  if (!text) return "";
  const headingRegex = new RegExp(`${heading}(?: \(trimmed\))?:\n`, "i");
  const match = headingRegex.exec(text);
  if (!match) return "";
  const start = match.index + match[0].length;
  const remainder = text.slice(start);
  const restMarkers = SUMMARY_SECTION_HEADINGS.filter((name) => name !== heading).map((name) => {
    const idx = remainder.search(new RegExp(`\\n\\n${name}`, "i"));
    return idx >= 0 ? idx : null;
  }).filter((val): val is number => val !== null);
  const end = restMarkers.length ? Math.min(...restMarkers) : remainder.length;
  return remainder.slice(0, end).trim();
}

const WRAPPED_SEGMENT_PATTERNS: Array<{ tag: string; role: TranscriptRole; regex: RegExp }> = [
  { tag: "user_query", role: "user", regex: /<user_query>([\s\S]*?)<\/user_query>/i },
  { tag: "assistant_response", role: "assistant", regex: /<assistant_response>([\s\S]*?)<\/assistant_response>/i },
  { tag: "system_reminder", role: "systemReminder", regex: /<system_reminder>([\s\S]*?)<\/system_reminder>/i },
];

const THINK_SEGMENT_REGEX = /<think>([\s\S]*?)<\/think>/gi;

type ParsedSegment = {
  role: TranscriptRole;
  text: string;
  rawText: string;
  tags: string[];
};

function formatSegmentFromRaw(source: string, defaultRole: TranscriptRole): ParsedSegment {
  const rawText = typeof source === "string" ? source : "";
  if (!rawText) {
    return { role: defaultRole, text: "", rawText: "", tags: [] };
  }

  const tags: string[] = [];
  let resolvedRole: TranscriptRole = defaultRole;
  let working = rawText;

  for (const pattern of WRAPPED_SEGMENT_PATTERNS) {
    const match = pattern.regex.exec(rawText);
    if (match) {
      resolvedRole = pattern.role;
      tags.push(pattern.tag);
      working = match[1] ?? "";
      break;
    }
  }

  const thinkBlocks: string[] = [];
  working = working.replace(THINK_SEGMENT_REGEX, (_, content) => {
    tags.push("think");
    thinkBlocks.push((content || "").trim());
    return "";
  });

  const visible = working.trim();
  const sections: string[] = [];
  if (visible) {
    sections.push(visible);
  }
  thinkBlocks.forEach((content, idx) => {
    const label = thinkBlocks.length > 1 ? `Thought ${idx + 1}` : "Thought";
    sections.push(`${label}:\n${content || "(empty)"}`);
  });

  return {
    role: resolvedRole,
    text: sections.join("\n\n"),
    rawText,
    tags,
  };
}

function ensureSegmentDisplay(segment: ParsedSegment): string {
  if (segment.text.trim()) {
    return segment.text;
  }
  if (segment.tags.length) {
    return `(empty ${segment.tags.join(", ")})`;
  }
  return "(empty)";
}

function splitSystemReminderSegments(
  source: string,
  defaultRole: TranscriptRole
): Array<{ role: TranscriptRole; text: string }> {
  if (!source) return [];
  const segments: Array<{ role: TranscriptRole; text: string }> = [];
  const regex = /<system_reminder>([\s\S]*?)<\/system_reminder>/gi;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(source)) !== null) {
    const preceding = source.slice(lastIndex, match.index);
    if (preceding.trim()) {
      segments.push({ role: defaultRole, text: preceding });
    }
    segments.push({ role: "systemReminder", text: match[0] || match[1] || "" });
    lastIndex = regex.lastIndex;
  }
  const trailing = source.slice(lastIndex);
  if (trailing.trim()) {
    segments.push({ role: defaultRole, text: trailing });
  }
  return segments;
}

function BudgetSummary({ budget }: { budget: BudgetInfo | null | undefined }) {
  const entries = [
    { label: "Budget", value: budget?.budgetTokens ?? "-" },
    { label: "Used", value: budget?.usedTokens ?? "-" },
    { label: "Saved", value: budget?.savedTokens ?? "0" },
    { label: "Compression", value: budget?.compressionPct ? `${Math.round(budget.compressionPct)}%` : "0%" },
  ];
  return (
    <Card title="Token budget" subtitle="Per turn tracking">
      <div className="grid gap-3 sm:grid-cols-4">
        {entries.map((entry) => (
          <div key={entry.label} className="rounded-lg border border-white/10 bg-white/5 px-4 py-3">
            <p className="stat-label mb-1">{entry.label}</p>
            <p className="text-xl font-semibold text-white">{entry.value}</p>
          </div>
        ))}
      </div>
    </Card>
  );
}

function copyToClipboard(value: string) {
  if (!value) return;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(value).catch(() => {
      window.alert("Clipboard write failed.");
    });
  } else {
    window.prompt("Copy text", value);
  }
}
