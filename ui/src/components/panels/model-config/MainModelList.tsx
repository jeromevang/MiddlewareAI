/**
 * MainModelList Component
 * Displays the list of main models for the selected preset
 */

import { Check, Download, Loader2, Zap } from 'lucide-react';
import { Button } from '../../ui/Button';

interface MainModelListProps {
  mainOptions: string[];
  selectedModel: string;
  quality: 'high' | 'medium' | 'low';
  isModelAvailable: (modelId: string) => boolean;
  isModelDownloading: (modelId: string) => boolean;
  isModelLoaded: (modelId: string) => boolean;
  onSelectModel: (modelId: string) => void;
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

export function MainModelList({
  mainOptions,
  selectedModel,
  quality,
  isModelAvailable,
  isModelDownloading,
  isModelLoaded,
  onSelectModel,
  onDownloadModel,
}: MainModelListProps) {
  const availableCount = mainOptions.filter(id => isModelAvailable(id)).length;
  const totalCount = mainOptions.length;

  const qualityLabels = {
    high: 'High Quality',
    medium: 'Balanced',
    low: 'Fast & Lightweight',
  };

  return (
    <div className="mb-6">
      <h3 className="text-sm font-semibold text-white/70 mb-1">Main Chat Model</h3>
      <p className="text-xs text-white/50 mb-3">
        Your Choice • {availableCount} of {totalCount} models available for {qualityLabels[quality]} tier
      </p>

      <div className="space-y-2 max-h-64 overflow-y-auto">
        {mainOptions.map((modelId) => {
          const available = isModelAvailable(modelId);
          const downloading = isModelDownloading(modelId);
          const loaded = isModelLoaded(modelId);
          const isSelected = selectedModel === modelId;

          return (
            <div
              key={modelId}
              className={`p-3 rounded-lg border transition-all cursor-pointer ${
                isSelected
                  ? 'border-cyan-500/50 bg-cyan-500/10'
                  : available
                  ? 'border-white/15 bg-white/5 hover:border-white/30'
                  : 'border-white/10 bg-white/3 opacity-60'
              }`}
              onClick={() => available && onSelectModel(modelId)}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  {/* Status indicator */}
                  {(() => {
                    if (isSelected) {
                      return <Check className="h-4 w-4 text-green-400 flex-shrink-0" />;
                    } else if (loaded) {
                      return <Zap className="h-4 w-4 text-blue-400 flex-shrink-0" />;
                    } else if (available) {
                      return <div className="h-4 w-4 flex-shrink-0" />;
                    } else if (downloading) {
                      return <Loader2 className="h-4 w-4 text-yellow-400 animate-spin flex-shrink-0" />;
                    } else {
                      return <Download className="h-4 w-4 text-white/40 flex-shrink-0" />;
                    }
                  })()}

                  <div>
                    <div className={`text-sm font-medium ${available ? 'text-white' : 'text-white/60'}`}>
                      {getModelDisplayName(modelId)}
                      {loaded && !isSelected && (
                        <span className="ml-2 text-xs px-1.5 py-0.5 bg-blue-500/20 text-blue-400 rounded">
                          Loaded
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-white/50">
                      {modelId.split('/')[0] || 'Local'}
                    </div>
                  </div>
                </div>

                {/* Action buttons */}
                {!available && !downloading && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDownloadModel(modelId);
                    }}
                    className="text-xs"
                  >
                    <Download className="h-3 w-3 mr-1" />
                    Download
                  </Button>
                )}
                {downloading && (
                  <span className="text-xs text-yellow-400">Downloading...</span>
                )}
                {isSelected && available && (
                  <span className="text-xs text-cyan-400 font-semibold">Selected</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default MainModelList;
