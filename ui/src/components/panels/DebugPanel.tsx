import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { Badge } from "../ui/Badge";

// =============================================================================
// Debug Panel - RAG System Diagnostics & Explorer
// =============================================================================

interface SystemHealth {
  embedder: { status: "ok" | "error" | "loading"; message: string };
  ragSummarizer: { status: "ok" | "error" | "loading"; message: string };
  faiss: { status: "ok" | "error" | "loading"; message: string; chunkCount?: number };
  lmstudio: { status: "ok" | "error" | "loading"; message: string };
}

interface RagChunk {
  id: string;
  filePath: string;
  chunkIndex: number;
  originalCode: string;
  summary: string;
  embeddingPreview: number[];
  tokens: number;
  createdAt: string;
}

interface RagStats {
  totalChunks: number;
  totalFiles: number;
  totalTokens: number;
  avgChunkSize: number;
  indexDimension: number;
  lastIndexed: string;
}

interface SearchResult {
  chunk: RagChunk;
  score: number;
  explanation: string;
}

export function DebugPanel() {
  const [activeTab, setActiveTab] = useState<"health" | "test" | "explorer">("health");

  return (
    <div className="space-y-6 p-4">
      {/* Header */}
      <div>
        <h2 className="text-xl font-bold text-white flex items-center gap-2">
          <span className="text-2xl">🔧</span>
          RAG System Diagnostics
        </h2>
        <p className="text-sm text-white/60 mt-1">
          Debug and explore the RAG pipeline components
        </p>
      </div>

      {/* Tab Navigation */}
      <div className="flex gap-2 border-b border-white/10 pb-2">
        {[
          { id: "health", label: "System Health", icon: "💚" },
          { id: "test", label: "Test Components", icon: "🧪" },
          { id: "explorer", label: "RAG Explorer", icon: "🔍" },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id as typeof activeTab)}
            className={clsx(
              "px-4 py-2 rounded-lg text-sm font-medium transition-all",
              activeTab === tab.id
                ? "bg-accent-primary/20 text-accent-primary border border-accent-primary/40"
                : "bg-white/5 text-white/60 hover:bg-white/10 hover:text-white"
            )}
          >
            {tab.icon} {tab.label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      {activeTab === "health" && <HealthTab />}
      {activeTab === "test" && <TestTab />}
      {activeTab === "explorer" && <ExplorerTab />}
    </div>
  );
}

// =============================================================================
// Health Tab - System Status Overview
// =============================================================================

function HealthTab() {
  const { data: health, isLoading, refetch } = useQuery({
    queryKey: ["system-health"],
    queryFn: async (): Promise<SystemHealth> => {
      const res = await fetch("/debug/system-health");
      if (!res.ok) throw new Error("Failed to fetch health");
      const data = await res.json();
      return data.health;
    },
    refetchInterval: 10000, // Refresh every 10s
  });

  const { data: ragTier } = useQuery({
    queryKey: ["ragTier"],
    queryFn: async () => {
      const res = await fetch("/rag/tier");
      return res.json();
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin text-3xl">⏳</div>
      </div>
    );
  }

  const components = [
    { key: "embedder", name: "Embedder", icon: "🔍", ...health?.embedder },
    { key: "ragSummarizer", name: "RAG Summarizer", icon: "📄", ...health?.ragSummarizer },
    { key: "faiss", name: "FAISS Index", icon: "🗃️", ...health?.faiss },
    { key: "lmstudio", name: "LM Studio", icon: "🤖", ...health?.lmstudio },
  ];

  return (
    <div className="space-y-4">
      {/* Current RAG Tier */}
      {ragTier && (
        <div className="p-4 rounded-lg bg-gradient-to-r from-blue-900/20 to-purple-900/20 border border-blue-500/30">
          <div className="flex items-center justify-between">
            <div>
              <span className="text-sm text-white/60">Current RAG Tier</span>
              <div className="text-lg font-semibold text-white capitalize">
                {ragTier.currentTier}
              </div>
            </div>
            <Badge tone="info">Closed System</Badge>
          </div>
        </div>
      )}

      {/* Component Health Cards */}
      <div className="grid grid-cols-2 gap-4">
        {components.map((comp) => (
          <div
            key={comp.key}
            className={clsx(
              "p-4 rounded-lg border",
              comp.status === "ok"
                ? "bg-green-900/20 border-green-500/30"
                : comp.status === "error"
                ? "bg-red-900/20 border-red-500/30"
                : "bg-yellow-900/20 border-yellow-500/30"
            )}
          >
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xl">{comp.icon}</span>
              <span className="font-medium text-white">{comp.name}</span>
            </div>
            <div className="flex items-center gap-2">
              <span
                className={clsx(
                  "w-2 h-2 rounded-full",
                  comp.status === "ok"
                    ? "bg-green-500"
                    : comp.status === "error"
                    ? "bg-red-500"
                    : "bg-yellow-500"
                )}
              />
              <span className="text-sm text-white/70">{comp.message}</span>
            </div>
            {comp.key === "faiss" && health?.faiss?.chunkCount !== undefined && (
              <div className="text-xs text-white/50 mt-2">
                {health.faiss.chunkCount.toLocaleString()} chunks indexed
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Refresh Button */}
      <button
        onClick={() => refetch()}
        className="px-4 py-2 rounded-lg bg-white/10 text-white/70 hover:bg-white/20 text-sm"
      >
        🔄 Refresh Status
      </button>
    </div>
  );
}

// =============================================================================
// Test Tab - Component Testing
// =============================================================================

function TestTab() {
  const [testInput, setTestInput] = useState("function calculateSum(a, b) { return a + b; }");

  // Test Embedder
  const embedderTest = useMutation({
    mutationFn: async (text: string) => {
      const res = await fetch("/debug/test-embedder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      return res.json();
    },
  });

  // Test RAG Search
  const ragTest = useMutation({
    mutationFn: async (query: string) => {
      const res = await fetch("/debug/test-rag", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });
      return res.json();
    },
  });

  // Test Summarizer
  const summarizerTest = useMutation({
    mutationFn: async (text: string) => {
      const res = await fetch("/debug/test-summarizer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      return res.json();
    },
  });

  return (
    <div className="space-y-6">
      {/* Test Input */}
      <div>
        <label className="block text-sm font-medium text-white/70 mb-2">
          Test Input (code or query)
        </label>
        <textarea
          value={testInput}
          onChange={(e) => setTestInput(e.target.value)}
          className="w-full h-32 px-3 py-2 rounded-lg bg-gray-800 border border-white/20 text-white text-sm font-mono"
          placeholder="Enter code or query to test..."
        />
      </div>

      {/* Test Buttons */}
      <div className="flex gap-3">
        <button
          onClick={() => embedderTest.mutate(testInput)}
          disabled={embedderTest.isPending}
          className="px-4 py-2 rounded-lg bg-blue-600/30 text-blue-300 border border-blue-500/40 hover:bg-blue-600/40 text-sm"
        >
          {embedderTest.isPending ? "Testing..." : "🔍 Test Embedder"}
        </button>
        <button
          onClick={() => ragTest.mutate(testInput)}
          disabled={ragTest.isPending}
          className="px-4 py-2 rounded-lg bg-purple-600/30 text-purple-300 border border-purple-500/40 hover:bg-purple-600/40 text-sm"
        >
          {ragTest.isPending ? "Searching..." : "🗃️ Test RAG Search"}
        </button>
        <button
          onClick={() => summarizerTest.mutate(testInput)}
          disabled={summarizerTest.isPending}
          className="px-4 py-2 rounded-lg bg-green-600/30 text-green-300 border border-green-500/40 hover:bg-green-600/40 text-sm"
        >
          {summarizerTest.isPending ? "Summarizing..." : "📄 Test Summarizer"}
        </button>
      </div>

      {/* Results */}
      <div className="space-y-4">
        {/* Embedder Result */}
        {embedderTest.data && (
          <TestResultCard
            title="Embedder Result"
            icon="🔍"
            status={embedderTest.data.status}
            content={
              embedderTest.data.status === "ok" ? (
                <div className="space-y-2">
                  <div className="text-sm text-white/70">
                    Dimension: <span className="text-white">{embedderTest.data.dimension}</span>
                  </div>
                  <div className="text-xs text-white/50 font-mono">
                    First 5 values: [{embedderTest.data.sample?.slice(0, 5).map((v: number) => v.toFixed(4)).join(", ")}]
                  </div>
                  <div className="text-xs text-white/50">
                    Time: {embedderTest.data.timeMs}ms
                  </div>
                </div>
              ) : (
                <div className="text-red-400">{embedderTest.data.error}</div>
              )
            }
          />
        )}

        {/* RAG Result */}
        {ragTest.data && (
          <TestResultCard
            title="RAG Search Result"
            icon="🗃️"
            status={ragTest.data.status}
            content={
              ragTest.data.status === "ok" ? (
                <div className="space-y-2">
                  <div className="text-sm text-white/70">
                    Found: <span className="text-white">{ragTest.data.results?.length || 0} chunks</span>
                  </div>
                  {ragTest.data.results?.slice(0, 3).map((r: SearchResult, i: number) => (
                    <div key={i} className="p-2 rounded bg-black/20 text-xs">
                      <div className="flex justify-between">
                        <span className="text-white/60">{r.chunk.filePath}</span>
                        <Badge tone="neutral">{(r.score * 100).toFixed(1)}%</Badge>
                      </div>
                      <div className="text-white/50 mt-1 truncate">
                        {r.chunk.summary || r.chunk.originalCode?.slice(0, 100)}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-red-400">{ragTest.data.error}</div>
              )
            }
          />
        )}

        {/* Summarizer Result */}
        {summarizerTest.data && (
          <TestResultCard
            title="Summarizer Result"
            icon="📄"
            status={summarizerTest.data.status}
            content={
              summarizerTest.data.status === "ok" ? (
                <div className="space-y-2">
                  <div className="text-sm text-white/80 whitespace-pre-wrap">
                    {summarizerTest.data.summary}
                  </div>
                  <div className="text-xs text-white/50">
                    Time: {summarizerTest.data.timeMs}ms
                  </div>
                </div>
              ) : (
                <div className="text-red-400">{summarizerTest.data.error}</div>
              )
            }
          />
        )}
      </div>
    </div>
  );
}

function TestResultCard({
  title,
  icon,
  status,
  content,
}: {
  title: string;
  icon: string;
  status: "ok" | "error";
  content: React.ReactNode;
}) {
  return (
    <div
      className={clsx(
        "p-4 rounded-lg border",
        status === "ok"
          ? "bg-green-900/10 border-green-500/30"
          : "bg-red-900/10 border-red-500/30"
      )}
    >
      <div className="flex items-center gap-2 mb-2">
        <span className="text-lg">{icon}</span>
        <span className="font-medium text-white">{title}</span>
        <Badge tone={status === "ok" ? "positive" : "danger"}>
          {status === "ok" ? "Success" : "Failed"}
        </Badge>
      </div>
      {content}
    </div>
  );
}

// =============================================================================
// Explorer Tab - RAG Data Explorer
// =============================================================================

function ExplorerTab() {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedChunkId, setSelectedChunkId] = useState<string | null>(null);
  const [fileFilter, setFileFilter] = useState("");

  // RAG Stats
  const { data: stats } = useQuery({
    queryKey: ["rag-stats"],
    queryFn: async (): Promise<RagStats> => {
      const res = await fetch("/debug/rag/stats");
      const data = await res.json();
      return data.stats;
    },
  });

  // Indexed Files
  const { data: filesData } = useQuery({
    queryKey: ["rag-files"],
    queryFn: async () => {
      const res = await fetch("/debug/rag/files");
      return res.json();
    },
  });

  // Chunks (with filter)
  const { data: chunksData, refetch: refetchChunks } = useQuery({
    queryKey: ["rag-chunks", fileFilter],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (fileFilter) params.set("filePath", fileFilter);
      params.set("limit", "50");
      const res = await fetch(`/debug/rag/chunks?${params}`);
      return res.json();
    },
  });

  // Chunk Detail
  const { data: chunkDetail } = useQuery({
    queryKey: ["rag-chunk", selectedChunkId],
    queryFn: async () => {
      if (!selectedChunkId) return null;
      const res = await fetch(`/debug/rag/chunk/${selectedChunkId}`);
      return res.json();
    },
    enabled: !!selectedChunkId,
  });

  // Search with explanation
  const searchMutation = useMutation({
    mutationFn: async (query: string) => {
      const res = await fetch("/debug/rag/search-explain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, topK: 10 }),
      });
      return res.json();
    },
  });

  return (
    <div className="space-y-6">
      {/* Stats Overview */}
      {stats && (
        <div className="grid grid-cols-5 gap-3">
          {[
            { label: "Total Chunks", value: stats.totalChunks.toLocaleString(), icon: "📦" },
            { label: "Total Files", value: stats.totalFiles.toLocaleString(), icon: "📁" },
            { label: "Total Tokens", value: stats.totalTokens.toLocaleString(), icon: "🔢" },
            { label: "Avg Chunk Size", value: `${stats.avgChunkSize} tokens`, icon: "📏" },
            { label: "Index Dimension", value: stats.indexDimension, icon: "📐" },
          ].map((stat) => (
            <div key={stat.label} className="p-3 rounded-lg bg-white/5 border border-white/10">
              <div className="flex items-center gap-2 text-white/50 text-xs mb-1">
                <span>{stat.icon}</span>
                {stat.label}
              </div>
              <div className="text-lg font-semibold text-white">{stat.value}</div>
            </div>
          ))}
        </div>
      )}

      {/* Search Bar */}
      <div className="flex gap-3">
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search indexed code..."
          className="flex-1 px-4 py-2 rounded-lg bg-gray-800 border border-white/20 text-white text-sm"
        />
        <button
          onClick={() => searchMutation.mutate(searchQuery)}
          disabled={!searchQuery || searchMutation.isPending}
          className="px-4 py-2 rounded-lg bg-accent-primary/20 text-accent-primary border border-accent-primary/40 hover:bg-accent-primary/30 text-sm"
        >
          {searchMutation.isPending ? "Searching..." : "🔍 Search"}
        </button>
      </div>

      {/* Search Results */}
      {searchMutation.data?.results && (
        <div className="p-4 rounded-lg bg-purple-900/10 border border-purple-500/30">
          <h4 className="font-medium text-white mb-3">
            Search Results ({searchMutation.data.results.length})
          </h4>
          <div className="space-y-2 max-h-64 overflow-auto">
            {searchMutation.data.results.map((r: SearchResult, i: number) => (
              <div
                key={i}
                className="p-3 rounded-lg bg-black/20 cursor-pointer hover:bg-black/30"
                onClick={() => setSelectedChunkId(r.chunk.id)}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm text-white/80 font-mono">
                    {r.chunk.filePath}:{r.chunk.chunkIndex}
                  </span>
                  <Badge tone="info">{(r.score * 100).toFixed(1)}% match</Badge>
                </div>
                <div className="text-xs text-white/50 truncate">
                  {r.chunk.summary || r.chunk.originalCode?.slice(0, 150)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Two Column Layout */}
      <div className="grid grid-cols-2 gap-4">
        {/* Files List */}
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <h4 className="font-medium text-white mb-3">📁 Indexed Files</h4>
          <div className="space-y-1 max-h-64 overflow-auto">
            {filesData?.files?.map((file: { path: string; chunkCount: number }) => (
              <button
                key={file.path}
                onClick={() => {
                  setFileFilter(file.path);
                  refetchChunks();
                }}
                className={clsx(
                  "w-full text-left px-3 py-2 rounded text-sm hover:bg-white/10",
                  fileFilter === file.path ? "bg-white/10 text-white" : "text-white/60"
                )}
              >
                <div className="flex justify-between items-center">
                  <span className="truncate font-mono text-xs">{file.path}</span>
                  <Badge tone="neutral">{file.chunkCount}</Badge>
                </div>
              </button>
            ))}
            {fileFilter && (
              <button
                onClick={() => {
                  setFileFilter("");
                  refetchChunks();
                }}
                className="w-full text-left px-3 py-1 text-xs text-accent-primary hover:underline"
              >
                Clear filter
              </button>
            )}
          </div>
        </div>

        {/* Chunks List */}
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <h4 className="font-medium text-white mb-3">
            📦 Chunks {fileFilter && <span className="text-white/50">({fileFilter})</span>}
          </h4>
          <div className="space-y-1 max-h-64 overflow-auto">
            {chunksData?.chunks?.map((chunk: RagChunk) => (
              <button
                key={chunk.id}
                onClick={() => setSelectedChunkId(chunk.id)}
                className={clsx(
                  "w-full text-left px-3 py-2 rounded text-sm hover:bg-white/10",
                  selectedChunkId === chunk.id ? "bg-white/10 text-white" : "text-white/60"
                )}
              >
                <div className="flex justify-between items-center">
                  <span className="font-mono text-xs">
                    Chunk #{chunk.chunkIndex}
                  </span>
                  <span className="text-xs text-white/40">{chunk.tokens} tokens</span>
                </div>
                <div className="text-xs text-white/40 truncate mt-1">
                  {chunk.summary || chunk.originalCode?.slice(0, 60)}
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Chunk Detail */}
      {chunkDetail?.chunk && (
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <h4 className="font-medium text-white mb-3">
            📋 Chunk Detail
          </h4>
          <div className="grid grid-cols-2 gap-4">
            {/* Original Code */}
            <div>
              <div className="text-xs text-white/50 mb-2">Original Code</div>
              <pre className="p-3 rounded-lg bg-black/30 text-xs text-white/80 font-mono overflow-auto max-h-48">
                {chunkDetail.chunk.originalCode}
              </pre>
            </div>
            {/* Summary */}
            <div>
              <div className="text-xs text-white/50 mb-2">Summary</div>
              <div className="p-3 rounded-lg bg-black/30 text-sm text-white/80 max-h-48 overflow-auto">
                {chunkDetail.chunk.summary || <span className="text-white/40 italic">No summary</span>}
              </div>
            </div>
          </div>
          {/* Embedding Preview */}
          <div className="mt-4">
            <div className="text-xs text-white/50 mb-2">Embedding Preview (first 20 dimensions)</div>
            <div className="p-2 rounded-lg bg-black/30 text-xs text-white/50 font-mono overflow-hidden">
              [{chunkDetail.chunk.embeddingPreview?.slice(0, 20).map((v: number) => v.toFixed(4)).join(", ")}...]
            </div>
          </div>
          {/* Metadata */}
          <div className="flex gap-4 mt-4 text-xs text-white/50">
            <span>File: {chunkDetail.chunk.filePath}</span>
            <span>Chunk: #{chunkDetail.chunk.chunkIndex}</span>
            <span>Tokens: {chunkDetail.chunk.tokens}</span>
            <span>Created: {new Date(chunkDetail.chunk.createdAt).toLocaleString()}</span>
          </div>
        </div>
      )}
    </div>
  );
}

export default DebugPanel;

