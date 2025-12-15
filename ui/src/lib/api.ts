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

  console.log('[API] Making request to:', path, 'with options:', options);
  const res = await fetch(path, { ...options, headers });
  console.log('[API] Response status:', res.status, 'for URL:', res.url);
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
  await request("/api/config", {
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

export async function loadPresetModels(preset: string): Promise<{
  status: string;
  message: string;
}> {
  return request<{
    status: string;
    message: string;
  }>(`/lmstudio/models/load-preset/${preset}`, {
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

// =============================================================================
// Model Database APIs
// =============================================================================

export interface ModelSpec {
  id: string;
  name: string;
  author: string;
  type: 'embedder' | 'summarizer' | 'main';
  engine: 'cpu' | 'lmstudio';
  size: string;
  contextLength: number;
  description: string;
  requirements: {
    vram: string;
    recommendedHardware: string;
  };
  performance: {
    speed: string;
    reasoning: string;
    coding: string;
    memory: string;
  };
  capabilities: string[];
  tags: string[];
  suggestedTier?: string;
  suggestedAt?: string;
  status?: string;
}

export interface QualityPreset {
  name: string;
  description: string;
  embedding: string;
  ragSummarizer: string;
  rollingSummarizer: string;
  mainOptions: string[];
}

export interface PresetsResponse {
  presets: {
    high: QualityPreset;
    medium: QualityPreset;
    low: QualityPreset;
  };
  lastActiveModel: string | null;
}

export interface SuggestedModelsResponse {
  suggested: ModelSpec[];
}

export interface DiscoveryResponse {
  status: string;
  discovered: number;
  models: ModelSpec[];
}

/**
 * Get all quality presets with their model options
 */
export async function getPresets(): Promise<PresetsResponse> {
  return request<PresetsResponse>("/models/presets");
}

/**
 * Get detailed spec for a specific model
 */
export async function getModelSpec(modelId: string): Promise<ModelSpec> {
  return request<ModelSpec>(`/models/specs/${encodeURIComponent(modelId)}`);
}

/**
 * Get models pending approval
 */
export async function getSuggestedModels(): Promise<SuggestedModelsResponse> {
  return request<SuggestedModelsResponse>("/models/suggested");
}

/**
 * Set the currently active main model
 */
export async function setActiveModel(modelId: string): Promise<{ status: string; lastActiveModel: string }> {
  return request<{ status: string; lastActiveModel: string }>("/models/active", {
    method: "POST",
    body: JSON.stringify({ modelId }),
  });
}

/**
 * Trigger LLM discovery for new models
 */
export async function discoverModels(): Promise<DiscoveryResponse> {
  return request<DiscoveryResponse>("/models/discover", {
    method: "POST",
  });
}

/**
 * Approve a suggested model into a preset tier
 */
export async function approveModel(
  modelId: string,
  quality: 'high' | 'medium' | 'low'
): Promise<{ status: string; preset: QualityPreset }> {
  return request<{ status: string; preset: QualityPreset }>(
    `/models/approve/${encodeURIComponent(modelId)}`,
    {
      method: "POST",
      body: JSON.stringify({ quality }),
    }
  );
}

/**
 * Dismiss a suggested model
 */
export async function dismissModel(modelId: string): Promise<{ status: string; remaining: number }> {
  return request<{ status: string; remaining: number }>(
    `/models/dismiss/${encodeURIComponent(modelId)}`,
    {
      method: "POST",
    }
  );
}

/**
 * Trigger LLM to evaluate and re-rank models for a quality tier
 */
export async function evaluateModels(
  quality: 'high' | 'medium' | 'low',
  performanceData?: Record<string, { score: number }>
): Promise<{ status: string; mainOptions: string[] }> {
  return request<{ status: string; mainOptions: string[] }>("/models/evaluate", {
    method: "POST",
    body: JSON.stringify({ quality, performanceData }),
  });
}

// =============================================================================
// Model Download & Availability APIs
// =============================================================================

export interface ModelAvailability {
  available: boolean;
  downloading: boolean;
}

export interface ModelStatusResponse {
  status: string;
  availability: Record<string, ModelAvailability>;
  activeDownloads: Record<string, { status: string; startedAt: number }>;
  loadedModels: string[];
}

export interface DownloadResponse {
  status: string;
  message: string;
}

export interface ValidateResponse {
  status: string;
  available: string[];
  missing: string[];
  discovered: number;
}

/**
 * Download a model via LM Studio CLI
 * @param modelId - The model ID to download
 * @param quantization - Optional quantization (e.g., 'q4_k_m'). Defaults to 'q4_k_m'
 */
export async function downloadModel(modelId: string, quantization?: string): Promise<DownloadResponse> {
  return request<DownloadResponse>(
    `/models/download/${encodeURIComponent(modelId)}`,
    {
      method: "POST",
      body: JSON.stringify({ quantization: quantization || 'q4_k_m' }),
    }
  );
}

/**
 * Get availability status for all preset models
 */
export async function getModelStatus(): Promise<ModelStatusResponse> {
  return request<ModelStatusResponse>("/models/status");
}

/**
 * Re-validate all presets against downloaded models
 */
export async function validateModels(): Promise<ValidateResponse> {
  return request<ValidateResponse>("/models/validate", {
    method: "POST",
  });
}

// =============================================================================
// Bootstrap APIs
// =============================================================================

export interface BootstrapStatus {
  status: string;
  running: boolean;
  progress: number;
  message: string;
  startedAt: number | null;
  completedAt: number | null;
  error: string | null;
}

export interface BootstrapResponse {
  status: string;
  message: string;
}

/**
 * Get current bootstrap status
 */
export async function getBootstrapStatus(): Promise<BootstrapStatus> {
  return request<BootstrapStatus>("/models/bootstrap-status");
}

/**
 * Trigger model bootstrap process
 */
export async function triggerBootstrap(): Promise<BootstrapResponse> {
  return request<BootstrapResponse>("/models/bootstrap", {
    method: "POST",
  });
}

// =============================================================================
// Quantization APIs
// =============================================================================

export interface QuantOption {
  id: string;
  name: string;
  description: string;
  sizeMultiplier: number;
}

export interface QuantOptionsResponse {
  options: QuantOption[];
  default: string;
}

/**
 * Get available quantization options
 */
export async function getQuantOptions(): Promise<QuantOptionsResponse> {
  return request<QuantOptionsResponse>("/models/quant-options");
}

// =============================================================================
// Hardware Detection APIs
// =============================================================================

export interface HardwareInfo {
  gpu: {
    name: string;
    totalGB: number;
    freeGB: number;
    usedGB: number;
  } | null;
  ram: {
    totalGB: number;
    freeGB: number;
  };
  suggestedPreset: "low" | "medium" | "high";
  cpuCores: number;
  platform: string;
  timestamp: number;
}

export interface HardwareResponse {
  status: string;
  hardware: HardwareInfo;
}

export interface CheckFitResponse {
  status: string;
  fits: boolean;
  totalRequired: number;
  available: number;
  percentage: number;
  overflow: number;
  status_label: "good" | "warning" | "overflow";
}

/**
 * Detect system hardware (GPU, RAM)
 */
export async function detectHardware(forceRefresh = false): Promise<HardwareResponse> {
  const url = forceRefresh ? "/hardware?refresh=true" : "/hardware";
  return request<HardwareResponse>(url);
}

/**
 * Check if models will fit in available VRAM
 */
export async function checkModelsFit(models: { sizeGB: number }[]): Promise<CheckFitResponse> {
  return request<CheckFitResponse>("/hardware/check-fit", {
    method: "POST",
    body: JSON.stringify({ models }),
  });
}

/**
 * Real-time resource usage response
 */
export interface RealtimeResourcesResponse {
  status: string;
  cpu: {
    usagePercent: number;
    cores: number;
  };
  ram: {
    totalGB: number;
    usedGB: number;
    freeGB: number;
    usagePercent: number;
  };
  vram: {
    name: string;
    totalGB: number;
    usedGB: number;
    freeGB: number;
    usagePercent: number;
  } | null;
  timestamp: number;
}

/**
 * Get real-time CPU, RAM, VRAM usage
 */
export async function getRealtimeResources(): Promise<RealtimeResourcesResponse> {
  return request<RealtimeResourcesResponse>("/hardware/realtime");
}

// =============================================================================
// Summary Management
// =============================================================================

export interface SummaryStatusResponse {
  status: string;
  currentModel: string;
  previousModel: string | null;
  modelChanged: boolean;
  regenerationNeeded: boolean;
  summaryCount: number;
  message: string;
}

export interface SummaryRegenerateResponse {
  status: string;
  model: string;
  totalSessions: number;
  successCount: number;
  results: Array<{
    conversationId: string;
    success: boolean;
    turnCount?: number;
    error?: string;
  }>;
}

/**
 * Check summary status and if regeneration is needed
 */
export async function getSummaryStatus(): Promise<SummaryStatusResponse> {
  return request<SummaryStatusResponse>("/summary/status");
}

/**
 * Acknowledge that the summarizer model changed
 */
export async function acknowledgeSummaryChange(): Promise<{ status: string; message: string }> {
  return request<{ status: string; message: string }>("/summary/acknowledge-change", {
    method: "POST",
  });
}

/**
 * Regenerate all summaries with the current model
 */
export async function regenerateSummaries(): Promise<SummaryRegenerateResponse> {
  return request<SummaryRegenerateResponse>("/summary/regenerate", {
    method: "POST",
  });
}

// =============================================================================
// Model Lock APIs
// =============================================================================

export interface ModelLock {
  loaded?: boolean;
  preset?: boolean;
  lockedAt?: string;
}

export interface LocksResponse {
  status: string;
  locks: Record<string, ModelLock>;
}

export interface LockResponse {
  status: string;
  modelId: string;
  lock: ModelLock | null;
}

/**
 * Get all locked models
 */
export async function getModelLocks(): Promise<LocksResponse> {
  return request<LocksResponse>("/models/locks");
}

/**
 * Get lock state for a specific model
 */
export async function getModelLock(modelId: string): Promise<LockResponse> {
  return request<LockResponse>(`/models/lock/${encodeURIComponent(modelId)}`);
}

/**
 * Lock a model
 */
export async function lockModel(
  modelId: string,
  options: { loaded?: boolean; preset?: boolean } = { loaded: true, preset: true }
): Promise<LockResponse> {
  return request<LockResponse>(`/models/lock/${encodeURIComponent(modelId)}`, {
    method: "POST",
    body: JSON.stringify(options),
  });
}

/**
 * Unlock a model
 */
export async function unlockModel(
  modelId: string,
  options: { loaded?: boolean; preset?: boolean } = { loaded: true, preset: true }
): Promise<LockResponse> {
  return request<LockResponse>(`/models/lock/${encodeURIComponent(modelId)}`, {
    method: "DELETE",
    body: JSON.stringify(options),
  });
}

/**
 * Toggle lock for a model
 */
export async function toggleModelLock(
  modelId: string,
  lockType: "loaded" | "preset" | "both" = "both"
): Promise<LockResponse> {
  return request<LockResponse>(`/models/lock/${encodeURIComponent(modelId)}/toggle`, {
    method: "POST",
    body: JSON.stringify({ lockType }),
  });
}

// =============================================================================
// Custom Preset APIs
// =============================================================================

export interface CustomPresetConfig {
  main: string | null;
  rollingSummarizer: string | null;
  // Note: embedder and ragSummarizer are part of closed RAG pipeline, not user-selectable
}

export interface CustomPresetResponse {
  status: string;
  config: CustomPresetConfig;
}

export interface OptimizeResponse {
  status: string;
  recommendation: {
    main: string;
    summarizer: string;
    embedder: string;
    reasoning: string;
    estimatedVRAM: number;
  };
}

/**
 * Get custom preset configuration
 */
export async function getCustomPreset(): Promise<CustomPresetResponse> {
  return request<CustomPresetResponse>("/presets/custom");
}

/**
 * Save custom preset configuration
 */
export async function saveCustomPreset(config: CustomPresetConfig): Promise<CustomPresetResponse> {
  return request<CustomPresetResponse>("/presets/custom", {
    method: "POST",
    body: JSON.stringify(config),
  });
}

export interface QualityModelConfig {
  quality: 'high' | 'medium' | 'low';
  modelId: string;
}

export interface QualityModelResponse {
  status: string;
  quality: string;
  modelId: string;
}

export interface QualitySummarizerConfig {
  quality: 'high' | 'medium' | 'low';
  summarizerId: string;
}

export interface QualitySummarizerResponse {
  status: string;
  quality: string;
  summarizerId: string;
}

export async function saveQualityPresetModel(config: QualityModelConfig): Promise<QualityModelResponse> {
  console.log('[API] saveQualityPresetModel called with:', config);
  return request<QualityModelResponse>("/presets/quality-model", {
    method: "POST",
    body: JSON.stringify(config),
  });
}

export async function saveQualityPresetSummarizer(config: QualitySummarizerConfig): Promise<QualitySummarizerResponse> {
  console.log('[API] saveQualityPresetSummarizer called with:', config);
  return request<QualitySummarizerResponse>("/presets/quality-summarizer", {
    method: "POST",
    body: JSON.stringify(config),
  });
}

/**
 * Run LLM-powered optimization to get best model configuration for hardware
 */
export async function optimizePreset(): Promise<OptimizeResponse> {
  return request<OptimizeResponse>("/presets/optimize", {
    method: "POST",
  });
}

// =============================================================================
// RAG Pipeline Tier APIs (Closed System)
// =============================================================================

export interface RagTierConfig {
  embedder: {
    model_name: string;
    sizeGB: number;
    contextLength: number;
  };
  ragSummarizer: {
    model_name: string;
    identifier: string;
    sizeGB: number;
  };
  indexingSpeed: string;
  summaryQuality: string;
}

export interface RagTierInfo {
  id: string;
  name: string;
  description: string;
  targetGPU: string;
}

export interface RagTierResponse {
  status: string;
  currentTier: "low" | "medium" | "high";
  config: RagTierConfig;
  availableTiers: RagTierInfo[];
  locked: boolean;
  note: string;
}

export interface RagTierChangeResponse {
  status: string;
  message: string;
  previousTier: string;
  newTier: string;
  config: RagTierConfig;
  reindexTriggered: boolean;
}

/**
 * Get current RAG pipeline tier configuration
 */
export async function getRagTier(): Promise<RagTierResponse> {
  return request<RagTierResponse>("/rag/tier");
}

/**
 * Change RAG pipeline tier (triggers re-index)
 */
export async function setRagTier(tier: "low" | "medium" | "high"): Promise<RagTierChangeResponse> {
  return request<RagTierChangeResponse>("/rag/tier", {
    method: "POST",
    body: JSON.stringify({ tier }),
  });
}

// =============================================================================
// Hugging Face Model Search APIs
// =============================================================================

export interface HFModelResult {
  id: string;
  modelId: string;
  author: string;
  name: string;
  downloads: number;
  likes: number;
  tags: string[];
  lastModified: string;
  pipeline_tag: string;
  isGGUF: boolean;
}

export interface HFQuantization {
  filename: string;
  size: number;
  sizeGB: number | null;
  quantization: string;
}

export interface HFSearchResponse {
  status: string;
  results: HFModelResult[];
  count: number;
}

export interface HFQuantsResponse {
  status: string;
  modelId: string;
  quantizations: HFQuantization[];
}

export interface HFDownloadResponse {
  status: string;
  success: boolean;
  downloadId: string;
  modelKey?: string;
  message?: string;
  error?: string;
}

export interface LMStudioModel {
  name: string;
  modelKey: string;
  displayName: string;
  badge: string;
  source: string;
  sizeGB?: number;
  function?: string;
}

export interface LMStudioDiscoverResponse {
  status: string;
  models: LMStudioModel[];
  source: string;
}

export interface LMStudioDownloadResponse {
  success: boolean;
  modelKey?: string;
  message?: string;
  error?: string;
  model?: any;
}

export interface ActiveDownloadsResponse {
  status: string;
  downloads: Record<string, {
    status: string;
    startedAt: number;
    modelId: string;
    quantization: string | null;
    elapsedMs: number;
  }>;
}

/**
 * Search Hugging Face for models
 */
export async function searchHuggingFace(
  query: string,
  options: { limit?: number; role?: "main" | "summarizer" | "embedder" } = {}
): Promise<HFSearchResponse> {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (options.limit) params.set("limit", options.limit.toString());
  if (options.role) params.set("role", options.role);
  
  return request<HFSearchResponse>(`/models/search?${params.toString()}`);
}

/**
 * Get available quantizations for a HuggingFace model
 */
export async function getHFQuantizations(modelId: string): Promise<HFQuantsResponse> {
  return request<HFQuantsResponse>(`/models/search/${encodeURIComponent(modelId)}/quants`);
}

/**
 * Download a model from Hugging Face
 */
export async function downloadHFModel(
  modelId: string,
  quantization?: string
): Promise<HFDownloadResponse> {
  return request<HFDownloadResponse>("/models/download-hf", {
    method: "POST",
    body: JSON.stringify({ modelId, quantization }),
  });
}

/**
 * Get active downloads status
 */
export async function getActiveDownloads(): Promise<ActiveDownloadsResponse> {
  return request<ActiveDownloadsResponse>("/models/downloads");
}

/**
 * Check if a HuggingFace model is already downloaded
 */
export async function checkHFModelDownloaded(modelId: string): Promise<{
  status: string;
  modelId: string;
  downloaded: boolean;
}> {
  return request(`/models/check-hf/${encodeURIComponent(modelId)}`);
}

/**
 * Discover models from LM Studio's built-in registry
 */
export async function discoverLMStudioModels(query?: string, limit?: number): Promise<LMStudioDiscoverResponse> {
  console.log('[API] discoverLMStudioModels called with:', { query, limit });
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  if (limit) params.set('limit', limit.toString());

  const result = await request<LMStudioDiscoverResponse>(`/models/lmstudio/discover?${params.toString()}`);
  console.log('[API] discoverLMStudioModels result:', result);
  return result;
}

/**
 * Download a model from LM Studio's registry
 */
export async function downloadLMStudioModel(modelKey: string): Promise<LMStudioDownloadResponse> {
  return request<LMStudioDownloadResponse>("/models/lmstudio/download", {
    method: "POST",
    body: JSON.stringify({ modelKey }),
  });
}

// =============================================================================
// Available Models API
// =============================================================================

export interface AvailableModel {
  id: string;
  modelKey: string;
  name: string;
  sizeGB?: number;
  trainedForToolUse?: boolean;
  maxContextLength?: number;
  type?: string;
  tiers?: string[];
  architecture?: string;
}

export interface AvailableModelsResponse {
  status: string;
  models: AvailableModel[];
  count: number;
}

/**
 * Get all downloaded/synced models for dropdowns
 */
export async function getAvailableModels(): Promise<AvailableModelsResponse> {
  return request<AvailableModelsResponse>("/models/available");
}