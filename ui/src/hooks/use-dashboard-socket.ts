import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useDashboardStore } from "../state/dashboard-store";
import type { DashboardSnapshot, SessionTurnsResponse, SessionUpdatePayload } from "../types/dashboard";

export function useDashboardSocket() {
  const setSnapshot = useDashboardStore((s) => s.setSnapshot);
  const setConnection = useDashboardStore((s) => s.setConnection);
  const upsertSession = useDashboardStore((s) => s.upsertSession);
  const queryClient = useQueryClient();

  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let isMounted = true;

    const applySessionUpdate = (update: SessionUpdatePayload) => {
      if (!update?.session) return;
      upsertSession(update.session);
      const newTurn = update.turn;
      if (newTurn) {
        queryClient.setQueryData<SessionTurnsResponse | null>(
          ["session-turns", newTurn.conversationId],
          (prev) => {
            if (!prev) return prev;
            const exists = prev.turns.some((turn) => turn.id === newTurn.id);
            if (exists) return prev;
            return {
              ...prev,
              turns: [newTurn, ...prev.turns],
            };
          }
        );
      }
    };

    const connect = () => {
      if (!isMounted) return;
      setConnection("connecting");
      const protocol = window.location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${protocol}://${window.location.host}/ws`);

      ws.onopen = () => {
        setConnection("open");
        ws?.send(JSON.stringify({ type: "snapshot-request" }));
      };

      ws.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data) as { type?: string; payload?: unknown };
          if (payload?.type === "dashboard" && payload.payload) {
            setSnapshot(payload.payload as DashboardSnapshot);
          } else if (payload?.type === "session-update" && payload.payload) {
            applySessionUpdate(payload.payload as SessionUpdatePayload);
          }
        } catch (err) {
          console.error("Failed to parse websocket payload", err);
        }
      };

      ws.onclose = () => {
        setConnection("closed");
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connect, 3_000);
      };

      ws.onerror = () => {
        ws?.close();
      };
    };

    connect();

    return () => {
      isMounted = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, [setSnapshot, setConnection, upsertSession, queryClient]);
}
