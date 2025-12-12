import { useEffect } from "react";
import { useDashboardStore } from "../state/dashboard-store";
import type { DashboardSnapshot } from "../types/dashboard";

export function useDashboardSocket() {
  const setSnapshot = useDashboardStore((s) => s.setSnapshot);
  const setConnection = useDashboardStore((s) => s.setConnection);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let isMounted = true;

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
          const payload = JSON.parse(event.data) as { type?: string; payload?: DashboardSnapshot };
          if (payload?.type === "dashboard" && payload.payload) {
            setSnapshot(payload.payload);
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
  }, [setSnapshot, setConnection]);
}
