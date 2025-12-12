import type { DashboardSnapshot, TelemetryStatus } from "../types/dashboard";
import { usePreferencesStore } from "../state/preferences-store";

interface RequestOptions extends RequestInit {
  skipAuth?: boolean;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (!options.skipAuth) {
    const token = usePreferencesStore.getState().apiKey.trim();
    if (token) {
      headers.set("Authorization", token.startsWith("Bearer ") ? token : `Bearer ${token}`);
    }
  }
  if (options.body && !(options.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }

  const res = await fetch(path, { ...options, headers });
  if (!res.ok) {
    const payload = await safeJson(res);
    const message = (payload && (payload.error as string)) || res.statusText || "Request failed";
    throw new Error(message);
  }
  return (await safeJson(res)) as T;
}

async function safeJson(res: Response) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text as unknown;
  }
}

export async function bootstrapSnapshot(): Promise<DashboardSnapshot> {
  const [status, metrics, history, logs] = await Promise.all([
    request("/status"),
    request("/metrics"),
    request("/history?limit=20"),
    request("/logs?limit=50"),
  ]);
  return { status, metrics, history, logs } as DashboardSnapshot;
}

export async function getTelemetryStatus() {
  return request<TelemetryStatus>("/telemetry");
}

export async function setTelemetry(enabled: boolean) {
  return request<TelemetryStatus>("/telemetry", {
    method: "POST",
    body: JSON.stringify({ enabled }),
  });
}

export async function triggerAction(action: "reindex" | "reset" | "lmstudio/restart") {
  const path = action === "lmstudio/restart" ? "/lmstudio/restart" : `/${action}`;
  await request(path, { method: "POST", body: JSON.stringify({}) });
}

export async function saveConfig(payload: Record<string, unknown>) {
  await request("/config", {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export async function purgeSessions(args: { conversationId?: string | null; beforeTs?: string | null }) {
  await request("/sessions/purge", {
    method: "POST",
    body: JSON.stringify(args ?? {}),
  });
}

export async function searchRag(payload: { query: string; topK?: number }) {
  return request<{ results: unknown[] }>("/search", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}
