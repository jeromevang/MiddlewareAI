import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import clsx from "clsx";
import { RefreshCw, Database, FileText, CheckCircle, AlertCircle } from "lucide-react";

interface IndexingStatus {
  isIndexing: boolean;
  currentFile?: string;
  filesProcessed: number;
  totalFiles: number;
  chunksProcessed: number;
  totalChunks: number;
  startTime?: string;
  estimatedTimeRemaining?: string;
  status: 'idle' | 'scanning' | 'processing' | 'embedding' | 'saving' | 'completed' | 'error';
  error?: string;
}

async function fetchIndexingStatus(): Promise<IndexingStatus> {
  const response = await fetch('/rag/indexing-status');
  if (!response.ok) {
    throw new Error('Failed to fetch indexing status');
  }
  return response.json();
}

export function RagIndexingStatus() {
  const [isVisible, setIsVisible] = useState(false);

  const { data: status, isLoading, error, refetch } = useQuery<IndexingStatus>({
    queryKey: ['rag-indexing-status'],
    queryFn: fetchIndexingStatus,
    refetchInterval: (data) => {
      // Poll more frequently when indexing is active
      if (data && typeof data === 'object' && 'isIndexing' in data && data.isIndexing) {
        setIsVisible(true);
        return 2000; // Every 2 seconds when active
      }
      // Poll less frequently when idle, but still show if recently completed
      if (data && typeof data === 'object' && 'status' in data && data.status === 'completed') {
        setIsVisible(true);
        return 10000; // Every 10 seconds when completed
      }
      // Show if there was recent activity (files processed > 0)
      if (data && typeof data === 'object' && 'filesProcessed' in data && typeof data.filesProcessed === 'number' && data.filesProcessed > 0) {
        setIsVisible(true);
        return 30000; // Every 30 seconds when idle but has data
      }
      setIsVisible(false);
      return 30000; // Every 30 seconds when idle
    },
    staleTime: 1000,
  });

  // Auto-hide completed status after 2 minutes (increased for testing)
  useEffect(() => {
    if (status?.status === 'completed' && !status?.isIndexing) {
      const timer = setTimeout(() => setIsVisible(false), 120000); // 2 minutes
      return () => clearTimeout(timer);
    }
  }, [status?.status, status?.isIndexing]);

  if (!isVisible || isLoading || error || !status) {
    return null;
  }

  const progress = status.totalFiles > 0 ? (status.filesProcessed / status.totalFiles) * 100 : 0;
  const isActive = status.isIndexing;
  const hasError = status.status === 'error';

  return (
    <div className={clsx(
      "mt-4 p-4 rounded-lg border transition-all",
      hasError
        ? "bg-red-900/20 border-red-500/50"
        : isActive
        ? "bg-blue-900/20 border-blue-500/50"
        : "bg-green-900/20 border-green-500/50"
    )}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          {hasError ? (
            <AlertCircle className="h-5 w-5 text-red-400" />
          ) : isActive ? (
            <RefreshCw className="h-5 w-5 text-blue-400 animate-spin" />
          ) : (
            <CheckCircle className="h-5 w-5 text-green-400" />
          )}
          <h4 className="text-sm font-semibold text-white">
            {hasError ? 'Indexing Error' : isActive ? 'Indexing in Progress' : 'Indexing Complete'}
          </h4>
        </div>
        <button
          onClick={() => refetch()}
          className="p-1 rounded hover:bg-white/10 transition-colors"
          title="Refresh status"
        >
          <RefreshCw className="h-4 w-4 text-white/60" />
        </button>
      </div>

      {hasError && status.error && (
        <div className="mb-3 p-2 bg-red-900/30 border border-red-500/30 rounded text-sm text-red-200">
          {status.error}
        </div>
      )}

      <div className="space-y-3">
        {/* Progress Bar */}
        {isActive && (
          <div className="space-y-2">
            <div className="flex justify-between text-xs text-white/70">
              <span>Progress</span>
              <span>{Math.round(progress)}%</span>
            </div>
            <div className="w-full bg-white/10 rounded-full h-2">
              <div
                className="bg-blue-500 h-2 rounded-full transition-all duration-300"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        )}

        {/* Status Details */}
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div className="flex items-center gap-2">
            <FileText className="h-4 w-4 text-white/60" />
            <div>
              <div className="text-white/70">Files</div>
              <div className="text-white font-medium">
                {status.filesProcessed}{status.totalFiles > 0 ? ` / ${status.totalFiles}` : ''}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Database className="h-4 w-4 text-white/60" />
            <div>
              <div className="text-white/70">Chunks</div>
              <div className="text-white font-medium">
                {status.chunksProcessed.toLocaleString()}
              </div>
            </div>
          </div>
        </div>

        {/* Current File */}
        {isActive && status.currentFile && (
          <div className="pt-2 border-t border-white/10">
            <div className="text-xs text-white/60 mb-1">Currently processing:</div>
            <div className="text-sm text-white font-mono truncate" title={status.currentFile}>
              {status.currentFile}
            </div>
          </div>
        )}

        {/* Time Information */}
        {status.startTime && (
          <div className="pt-2 border-t border-white/10 text-xs text-white/50">
            Started: {new Date(status.startTime).toLocaleTimeString()}
            {status.estimatedTimeRemaining && isActive && (
              <span className="ml-4">
                Est. remaining: {status.estimatedTimeRemaining}
              </span>
            )}
          </div>
        )}

        {/* Status Message */}
        <div className="pt-2 border-t border-white/10">
          <div className="text-xs text-white/60">
            Status: <span className="text-white capitalize">{status.status.replace('_', ' ')}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
