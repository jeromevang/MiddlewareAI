// =============================================================================
// Main Model Selector for Quality Presets
// =============================================================================

import { useQuery } from "@tanstack/react-query";
import { Check, Download, Loader2, HardDrive } from "lucide-react";
import { getModelDisplayName } from './model-config/constants';
import { getModelStatus } from "../../lib/api";

interface MainModelSelectorProps {
  quality: 'high' | 'medium' | 'low';
  preset: any;
  selectedModel: string;
  onModelSelect: (modelId: string) => void;
  onModelDownload: (modelId: string) => void;
}

export function MainModelSelector({
  quality,
  preset,
  selectedModel,
  onModelSelect,
  onModelDownload,
}: MainModelSelectorProps) {
  // Fetch model availability status
  const { data: modelStatusData } = useQuery({
    queryKey: ['modelStatus'],
    queryFn: getModelStatus,
    staleTime: 2000,
  });

  const modelAvailability: Record<string, any> = modelStatusData?.availability || {};
  const activeDownloads: Record<string, any> = modelStatusData?.activeDownloads || {};

  // Check if a model is available
  const isModelAvailable = (modelId: string): boolean => {
    return modelAvailability[modelId]?.available ?? false;
  };

  // Check if a model is currently downloading
  const isModelDownloading = (modelId: string): boolean => {
    return modelAvailability[modelId]?.downloading ?? !!activeDownloads[modelId];
  };

  const mainOptions = preset?.mainOptions || [];

  if (!mainOptions.length) {
    return (
      <div className="text-center py-8 text-white/60">
        No models available for {preset?.name || quality} preset
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Role Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2">
          <HardDrive className="h-4 w-4 text-green-400" />
          <div>
            <h4 className="font-medium text-white">Main Chat Model</h4>
            <p className="text-xs text-white/60">Handles chat completions and tool calling</p>
          </div>
        </div>
      </div>

      {/* Model Selection */}
      <div className="space-y-2">
        {mainOptions.map((modelId: string) => {
          const available = isModelAvailable(modelId);
          const downloading = isModelDownloading(modelId);
          const isSelected = selectedModel === modelId;

          return (
            <div
              key={modelId}
              className={`flex items-center justify-between p-3 rounded-lg border transition-all ${
                isSelected
                  ? 'border-cyan-400 bg-cyan-400/10'
                  : available
                  ? 'border-white/20 bg-white/5 hover:bg-white/10 cursor-pointer'
                  : 'border-white/10 bg-white/5'
              }`}
              onClick={() => available && onModelSelect(modelId)}
            >
              <div className="flex items-center gap-3">
                {/* Status indicator */}
                {(() => {
                  if (isSelected) {
                    return <Check className="h-4 w-4 text-green-400 flex-shrink-0" />;
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
                  </div>
                  <div className="text-xs text-white/50">
                    {modelId.split('/')[0]}
                  </div>
                </div>
              </div>

              {/* Action button */}
              {!available && !downloading && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onModelDownload(modelId);
                  }}
                  className="px-3 py-1 rounded text-sm bg-amber-500/20 hover:bg-amber-500/30 text-amber-400 flex items-center gap-1"
                >
                  <Download className="h-3 w-3" />
                  Download
                </button>
              )}
              {downloading && (
                <span className="text-xs text-yellow-400">Downloading...</span>
              )}
              {isSelected && available && (
                <span className="text-xs text-cyan-400 font-semibold">Selected</span>
              )}
            </div>
          );
        })}
      </div>

      {/* Selection Summary */}
      {selectedModel && (
        <div className="text-xs text-green-400 bg-green-900/20 border border-green-500/30 rounded px-3 py-2">
          ✓ Active: {getModelDisplayName(selectedModel)}
        </div>
      )}
    </div>
  );
}
