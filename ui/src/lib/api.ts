import type { DashboardSnapshot, EngineSnapshot, SessionMeta, SessionTurnsResponse, TelemetryStatus } from "../types/dashboard";
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

export async function updateEngine(
  engine: "rag" | "summary",
  payload: { enabled: boolean; clearOnDisable?: boolean }
) {
  return request<{ status: string; engines: EngineSnapshot }>(`/engines/${engine}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export async function fetchSessionTurns(conversationId: string, params?: { limit?: number; offset?: number }) {
  const search = new URLSearchParams();
  if (params?.limit) search.set("limit", params.limit.toString());
  if (params?.offset) search.set("offset", params.offset.toString());
  const suffix = search.toString() ? `?${search.toString()}` : "";
  return request<SessionTurnsResponse>(`/sessions/${encodeURIComponent(conversationId)}/turns${suffix}`);
}

export async function updateSummaryKeepRecent(keepRecentTurns: number) {
  return request<{ status: string; keepRecentTurns: number }>("/processing/summary-keep", {
    method: "PATCH",
    body: JSON.stringify({ keepRecentTurns }),
  });
}

export async function reprocessSummaries(payload?: { conversationId?: string | null }) {
  return request<{ status: string; processed: number; keepRecentTurns: number }>("/summary/reprocess", {
    method: "POST",
    body: JSON.stringify(payload ?? {}),
  });
}

export async function deleteAllSessions() {
  await triggerAction("reset");
}

export async function updateSessionContextMode(
  conversationId: string,
  mode: "raw" | "compressed" | null
): Promise<{ status: string; session: SessionMeta }> {
  return request<{ status: string; session: SessionMeta }>(
    `/sessions/${encodeURIComponent(conversationId)}/context-mode`,
    {
      method: "PATCH",
      body: JSON.stringify({ mode }),
    }
  );
}

// LM Studio Model Management APIs
export async function listLoadedModels(): Promise<{ status: string; models: any[] }> {
  return request<{ status: string; models: any[] }>("/lmstudio/models");
}

export async function unloadModel(modelId: string): Promise<{ status: string; success: boolean; output: string }> {
  return request<{ status: string; success: boolean; output: string }>("/lmstudio/models/unload", {
    method: "POST",
    body: JSON.stringify({ modelId }),
  });
}

export async function unloadAllModels(): Promise<{ status: string; success: boolean; output: string }> {
  return request<{ status: string; success: boolean; output: string }>("/lmstudio/models/unload-all", {
    method: "POST",
  });
}

export async function getServerStatus(): Promise<{ status: string; server: { status: string; output: string } }> {
  return request<{ status: string; server: { status: string; output: string } }>("/lmstudio/server/status");
}

export async function checkLMStudioHealth(): Promise<{
  status: string;
  ready: boolean;
  server?: { status: string; output: string };
  models_loaded?: number;
  models?: any[];
  error?: string;
  timestamp: number;
}> {
  return request<{
    status: string;
    ready: boolean;
    server?: { status: string; output: string };
    models_loaded?: number;
    models?: any[];
    error?: string;
    timestamp: number;
  }>("/lmstudio/health");
}

export async function startLMStudioServer(): Promise<{
  status: string;
  success: boolean;
  server_status: string;
  output: string;
}> {
  return request<{
    status: string;
    success: boolean;
    server_status: string;
    output: string;
  }>("/lmstudio/server/start", {
    method: "POST",
  });
}

export async function stopLMStudioServer(): Promise<{
  status: string;
  success: boolean;
  server_status: string;
  output: string;
}> {
  return request<{
    status: string;
    success: boolean;
    server_status: string;
    output: string;
  }>("/lmstudio/server/stop", {
    method: "POST",
  });
}

export async function loadRequiredModels(): Promise<{
  status: string;
  message: string;
}> {
  return request<{
    status: string;
    message: string;
  }>("/lmstudio/models/load-required", {
    method: "POST",
  });
}

export async function refreshModelContext(): Promise<{
  status: string;
  context: {
    model_context_length: number;
    max_context_tokens: number;
    context_budget_tokens: number;
  }
}> {
  return request<{
    status: string;
    context: {
      model_context_length: number;
      max_context_tokens: number;
      context_budget_tokens: number;
    }
  }>("/lmstudio/context/refresh", {
    method: "POST",
  });
}
