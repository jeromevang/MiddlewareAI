export type ConnectionState = "connecting" | "open" | "closed";

export interface ModelSummary {
  engine?: string;
  model_name?: string;
  identifier?: string;
  context_length?: number;
  embedding_dimension?: number;
}

export interface StorageStats {
  embedding_dimension: number;
  faiss_index_path: string;
  sqlite_db_path: string;
  faiss_entries: number;
  faiss_dim: number;
}

export interface ProcessingStats {
  max_chunk_size: number;
  concurrency_limit: number;
  context_budget_tokens: number;
  max_context_tokens: number;
  summary_keep_recent_turns?: number;
}

export interface BudgetInfo {
  budgetTokens?: number | null;
  usedTokens?: number;
  rawTokens?: number;
  savedTokens?: number;
  compressionPct?: number;
  trimmed?: boolean;
  mode?: string | null;
  trimmedSummaryTokens?: number;
  trimmedContextTokens?: number;
}

export interface RagPreview {
  filePath?: string;
  distance?: number;
  summaryText?: string;
}

export interface ContextSnapshot {
  preview: string;
  length: number;
  ts: number;
  rag: RagPreview[];
}

export interface SummaryAction {
  ts: number;
  sessionId: string;
  turnCount: number;
  summaryText: string;
  summaryLength: number;
}

export interface EngineState {
  enabled: boolean;
  source?: string;
  updatedAt?: number;
  bypassedRequests?: number;
}

export interface EngineSnapshot {
  rag: EngineState & { bypassedRequests: number };
  summary: EngineState;
}

export interface MetricsPayload {
  totalRequests: number;
  totalErrors: number;
  avgDurationMs: number;
  lastBudget: BudgetInfo | null;
  lastContextText: string | null;
  lastContextLength: number;
  lastContextTs: number | null;
  lastRagResults: RagPreview[];
  lastSummaryAction: SummaryAction | null;
  engines?: EngineSnapshot;
  models: Record<string, ModelSummary | null>;
  storage: StorageStats;
  processing: ProcessingStats;
}

export interface RequestHistory {
  ts: number;
  path: string;
  duration: number;
  ragHits: number;
  budget: BudgetInfo | null;
  status: number;
  sessionId?: string;
  error?: string;
}

export interface LogEntry {
  ts: number;
  level: "info" | "warn" | "error" | string;
  message: string;
}

export interface SessionMeta {
  conversation_id: string;
  last_activity: string;
  turn_count: number;
  updates: number;
}

export interface SessionUpdatePayload {
  session: SessionMeta;
  turn?: ConversationTurn | null;
}

export interface StatusPayload {
  lmstudio: { url: string; healthy: boolean };
  server: { port: number };
  config: Record<string, unknown> & {
    models?: {
      embedding?: Record<string, unknown>;
      summarization?: Record<string, unknown>;
      main?: Record<string, unknown>;
    };
    runtime?: Record<string, unknown> & {
      mode?: "local" | "cloud";
      cloud_main?: Record<string, unknown>;
    };
  };
  runtime: { mode: string; rag_enabled: boolean; summary_enabled?: boolean; cloud: boolean };
  engines: EngineSnapshot;
  processing: ProcessingStats;
  models: { embedding: ModelSummary | null; summarization: ModelSummary | null; main: ModelSummary | null };
  storage: StorageStats;
  context: BudgetInfo | null;
  context_snapshot: ContextSnapshot | null;
  last_summary: SummaryAction | null;
  indexingInProgress: boolean;
  sessions: SessionMeta[];
  metrics: MetricsPayload;
}

export interface RagChunkLink {
  filePath: string;
  distance?: number;
  summaryText?: string;
}

export interface ConversationTurn {
  id: number;
  conversationId: string;
  turnIndex: number;
  userPrompt: string;
  assistantResponse: string;
  rawContext: string;
  composedContext: string;
  budget: BudgetInfo | null;
  ragChunks: RagChunkLink[];
  compressionMode: string | null;
  createdAt: string;
}

export interface SessionTurnsResponse {
  sessionId: string;
  turns: ConversationTurn[];
  pagination: { limit: number; offset: number };
}

export interface DashboardSnapshot {
  status: StatusPayload;
  metrics: MetricsPayload;
  history: RequestHistory[];
  logs: LogEntry[];
}

export interface TelemetryStatus {
  enabled: boolean;
  override: boolean | null;
  source: "env" | "override";
  envFlag: string | null;
}
