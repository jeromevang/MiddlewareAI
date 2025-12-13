import { create } from "zustand";
import type {
  ConnectionState,
  DashboardSnapshot,
  LogEntry,
  MetricsPayload,
  RequestHistory,
  SessionMeta,
  StatusPayload,
} from "../types/dashboard";

interface DashboardState {
  status: StatusPayload | null;
  metrics: MetricsPayload | null;
  history: RequestHistory[];
  logs: LogEntry[];
  connection: ConnectionState;
  selectedSession: string | null;
  historyFilter: "all" | "query" | "search" | "system";
  logLevel: "all" | "info" | "warn" | "error";
  sessionFilter: "all" | "raw" | "compressed";
  setSnapshot: (snapshot: DashboardSnapshot) => void;
  setConnection: (state: ConnectionState) => void;
  selectSession: (id: string | null) => void;
  setHistoryFilter: (filter: DashboardState["historyFilter"]) => void;
  setLogLevel: (level: DashboardState["logLevel"]) => void;
  setSessionFilter: (filter: DashboardState["sessionFilter"]) => void;
  upsertSession: (session: SessionMeta) => void;
}

export const useDashboardStore = create<DashboardState>((set) => ({
  status: null,
  metrics: null,
  history: [],
  logs: [],
  connection: "connecting",
  selectedSession: null,
  historyFilter: "all",
  logLevel: "all",
  sessionFilter: "all",
  setSnapshot: (snapshot) =>
    set(() => ({
      status: snapshot.status,
      metrics: snapshot.metrics,
      history: snapshot.history,
      logs: snapshot.logs,
    })),
  setConnection: (connection) => set({ connection }),
  selectSession: (id) => set({ selectedSession: id }),
  setHistoryFilter: (historyFilter) => set({ historyFilter }),
  setLogLevel: (logLevel) => set({ logLevel }),
  setSessionFilter: (sessionFilter) => set({ sessionFilter }),
  upsertSession: (session) =>
    set((state) => {
      if (!state.status) return state;
      const existing = state.status.sessions ?? [];
      const filtered = existing.filter((entry) => entry.conversation_id !== session.conversation_id);
      const nextSessions = [session, ...filtered].sort(
        (a, b) => new Date(b.last_activity).getTime() - new Date(a.last_activity).getTime()
      );
      return {
        status: {
          ...state.status,
          sessions: nextSessions,
        },
      };
    }),
}));
