/**
 * Download Progress Component
 * Shows a non-blocking progress indicator for model downloads
 */

import { X, CheckCircle, Loader2 } from 'lucide-react';

interface DownloadInfo {
  status: string;
  startedAt: number;
  progress: number;
  cliName?: string;
  modelId?: string;
}

interface DownloadProgressProps {
  downloads: Record<string, DownloadInfo>;
  onDismiss?: (modelId: string) => void;
}

// Helper to get display name from model ID
function getModelDisplayName(modelId: string): string {
  if (!modelId) return 'Unknown Model';
  const parts = modelId.split('/');
  const name = parts[parts.length - 1];
  return name
    .replace(/-GGUF$/i, '')
    .replace(/@.*$/, '')
    .replace(/-instruct$/i, ' Instruct')
    .replace(/-chat$/i, ' Chat');
}

// Format elapsed time
function formatElapsed(startedAt: number): string {
  const elapsed = Math.floor((Date.now() - startedAt) / 1000);
  if (elapsed < 60) return `${elapsed}s`;
  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  return `${minutes}m ${seconds}s`;
}

function SingleDownloadProgress({ 
  modelId, 
  download, 
  onDismiss 
}: { 
  modelId: string; 
  download: DownloadInfo; 
  onDismiss?: () => void;
}) {
  const isComplete = download.progress >= 100;
  const progress = Math.min(download.progress, 100);
  
  return (
    <div className="bg-gray-900/95 backdrop-blur-sm border border-white/10 rounded-lg p-4 shadow-xl min-w-[300px]">
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-2">
          {isComplete ? (
            <CheckCircle className="w-4 h-4 text-green-400" />
          ) : (
            <Loader2 className="w-4 h-4 text-cyan-400 animate-spin" />
          )}
          <span className="text-sm font-medium text-white">
            {isComplete ? 'Download Complete' : 'Downloading'}
          </span>
        </div>
        {onDismiss && (
          <button
            onClick={onDismiss}
            className="text-white/40 hover:text-white/80 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>
      
      <div className="text-sm text-white/80 mb-2 truncate" title={modelId}>
        {getModelDisplayName(modelId)}
      </div>
      
      {/* Progress bar */}
      <div className="w-full h-2 bg-gray-700 rounded-full overflow-hidden mb-2">
        <div 
          className={`h-full transition-all duration-300 ${
            isComplete ? 'bg-green-500' : 'bg-cyan-500'
          }`}
          style={{ width: `${progress}%` }}
        />
      </div>
      
      <div className="flex items-center justify-between text-xs text-white/50">
        <span>{progress}%</span>
        <span>{formatElapsed(download.startedAt)}</span>
      </div>
    </div>
  );
}

export function DownloadProgress({ downloads, onDismiss }: DownloadProgressProps) {
  const activeDownloads = Object.entries(downloads).filter(
    ([_, d]) => d.status === 'downloading' || d.progress > 0
  );
  
  if (activeDownloads.length === 0) {
    return null;
  }
  
  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
      {activeDownloads.map(([modelId, download]) => (
        <SingleDownloadProgress
          key={modelId}
          modelId={modelId}
          download={download}
          onDismiss={onDismiss ? () => onDismiss(modelId) : undefined}
        />
      ))}
    </div>
  );
}

export default DownloadProgress;
