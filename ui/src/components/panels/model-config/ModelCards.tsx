/**
 * ModelCards Component
 * Displays the 4 model configuration cards (Embedding, RAG, Rolling, Main)
 */

import { Cpu, HardDrive, Zap, Download } from 'lucide-react';
import type { QualityPreset } from '../../../lib/api';

interface ModelCardsProps {
  preset: QualityPreset | null;
  mainModel: string;
  isModelAvailable: (modelId: string) => boolean;
  isModelDownloading: (modelId: string) => boolean;
  onDownloadModel: (modelId: string) => void;
}

// Helper to get display name from model ID
function getModelDisplayName(modelId: string): string {
  if (!modelId) return 'Not set';
  const parts = modelId.split('/');
  const name = parts[parts.length - 1];
  return name
    .replace(/-GGUF$/i, '')
    .replace(/@.*$/, '')
    .replace(/-instruct$/i, ' Instruct')
    .replace(/-chat$/i, ' Chat');
}

function DownloadButton({ 
  modelId, 
  isDownloading, 
  onDownload,
  color = 'amber'
}: { 
  modelId: string; 
  isDownloading: boolean; 
  onDownload: () => void;
  color?: string;
}) {
  if (!modelId) return null;
  
  return (
    <button
      onClick={onDownload}
      disabled={isDownloading}
      className={`mt-2 text-xs px-2 py-1 bg-${color}-500/20 hover:bg-${color}-500/30 text-${color}-400 rounded disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1`}
    >
      {isDownloading ? (
        <>
          <div className={`w-3 h-3 border border-${color}-400 border-t-transparent rounded-full animate-spin`}></div>
          Downloading...
        </>
      ) : (
        <>
          <Download className="w-3 h-3" />
          Download
        </>
      )}
    </button>
  );
}

export function ModelCards({
  preset,
  mainModel,
  isModelAvailable,
  isModelDownloading,
  onDownloadModel,
}: ModelCardsProps) {
  return (
    <div className="mb-6">
      <p className="text-xs text-white/50 mb-3">Auto-configured based on selected preset</p>
      
      <h3 className="text-sm font-semibold text-white/70 mb-3">Model Configuration</h3>
      
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {/* Embedding Model Card */}
        <div className="p-3 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-2 mb-2">
            <Cpu className="h-4 w-4 text-blue-400" />
            <span className="text-xs text-white/50">Embedding Model</span>
            <span className="ml-auto text-xs px-1.5 py-0.5 bg-blue-500/20 text-blue-400 rounded">Auto</span>
          </div>
          <div className="text-sm text-white/80">
            {getModelDisplayName(preset?.embedding || 'Not set')}
          </div>
          <p className="text-xs text-white/50 mt-1">CPU-based RAG embeddings (Xenova)</p>
        </div>

        {/* RAG Summarizer Card */}
        <div className="p-3 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-2 mb-2">
            <HardDrive className="h-4 w-4 text-amber-400" />
            <span className="text-xs text-white/50">RAG Summarizer</span>
            <span className="ml-auto text-xs px-1.5 py-0.5 bg-amber-500/20 text-amber-400 rounded">Auto</span>
          </div>
          <div className="text-sm text-white/80">
            {getModelDisplayName(preset?.ragSummarizer || 'Not set')}
          </div>
          <p className="text-xs text-white/50 mt-1">Code chunk summaries</p>
          {preset?.ragSummarizer && !isModelAvailable(preset.ragSummarizer) && (
            <DownloadButton
              modelId={preset.ragSummarizer}
              isDownloading={isModelDownloading(preset.ragSummarizer)}
              onDownload={() => onDownloadModel(preset.ragSummarizer)}
              color="amber"
            />
          )}
        </div>

        {/* Rolling Summarizer Card */}
        <div className="p-3 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center gap-2 mb-2">
            <HardDrive className="h-4 w-4 text-purple-400" />
            <span className="text-xs text-white/50">Rolling Summarizer</span>
            <span className="ml-auto text-xs px-1.5 py-0.5 bg-purple-500/20 text-purple-400 rounded">Auto</span>
          </div>
          <div className="text-sm text-white/80">
            {getModelDisplayName(preset?.rollingSummarizer || 'Not set')}
          </div>
          <p className="text-xs text-white/50 mt-1">Conversation memory</p>
          {preset?.rollingSummarizer && !isModelAvailable(preset.rollingSummarizer) && (
            <DownloadButton
              modelId={preset.rollingSummarizer}
              isDownloading={isModelDownloading(preset.rollingSummarizer)}
              onDownload={() => onDownloadModel(preset.rollingSummarizer)}
              color="purple"
            />
          )}
        </div>

        {/* Main Model Card */}
        <div className="p-3 rounded-lg bg-white/5 border border-cyan-500/30">
          <div className="flex items-center gap-2 mb-2">
            <Zap className="h-4 w-4 text-cyan-400" />
            <span className="text-xs text-white/50">Main Model</span>
            <span className="ml-auto text-xs px-2 py-0.5 bg-green-500/20 text-green-400 rounded">Active</span>
          </div>
          <div className="text-sm text-white font-medium">
            {getModelDisplayName(mainModel || preset?.mainOptions?.[0] || 'Not set')}
          </div>
          <p className="text-xs text-white/50 mt-1">Chat completions</p>
        </div>
      </div>
    </div>
  );
}

export default ModelCards;