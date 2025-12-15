// =============================================================================
// Model Selector for Quality Presets (Main & Rolling Summarizer)
// =============================================================================

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Download, Loader2, HardDrive, Info, Star } from "lucide-react";
import { getModelDisplayName } from './model-config/constants';
import { getModelStatus } from "../../lib/api";

interface MainModelSelectorProps {
  quality: 'high' | 'medium' | 'low';
  preset: any;
  selectedMainModel: string;
  selectedSummarizerModel: string;
  onMainModelSelect: (modelId: string) => void;
  onSummarizerModelSelect: (modelId: string) => void;
  onModelDownload: (modelId: string) => void;
}

export function MainModelSelector({
  quality,
  preset,
  selectedMainModel,
  selectedSummarizerModel,
  onMainModelSelect,
  onSummarizerModelSelect,
  onModelDownload,
}: MainModelSelectorProps) {
  const [showDetails, setShowDetails] = useState<string | null>(null);

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

  // Get star rating based on model size (simplified)
  const getStarRating = (modelId: string) => {
    const modelName = modelId.toLowerCase();
    if (modelName.includes('32b') || modelName.includes('30b') || modelName.includes('70b')) {
      return { stars: 5, label: "Excellent" };
    } else if (modelName.includes('14b') || modelName.includes('15b')) {
      return { stars: 4, label: "Very Good" };
    } else if (modelName.includes('7b') || modelName.includes('8b')) {
      return { stars: 3, label: "Good" };
    } else if (modelName.includes('3b') || modelName.includes('4b')) {
      return { stars: 2, label: "Basic" };
    } else if (modelName.includes('1b') || modelName.includes('0.5b')) {
      return { stars: 1, label: "Minimal" };
    }
    return { stars: 3, label: "Good" };
  };

  const mainOptions = preset?.mainOptions || [];

  // For quality presets, we need to determine available summarizer options
  // For now, let's assume summarizer options are the same as main options but smaller models
  const allSummarizerOptions = mainOptions.filter((modelId: string) => {
    const modelName = modelId.toLowerCase();
    return modelName.includes('1.5b') || modelName.includes('0.5b') || modelName.includes('3b') || modelName.includes('7b');
  }).slice(0, 5); // Limit to 5 options

  if (!mainOptions.length) {
    return (
      <div className="text-center py-8 text-white/60">
        No models available for {preset?.name || quality} preset
      </div>
    );
  }

  const ModelList = ({
    options,
    selectedModel,
    onSelect,
    role
  }: {
    options: string[];
    selectedModel: string;
    onSelect: (modelId: string) => void;
    role: 'main' | 'summarizer';
  }) => {
    return (
      <div className="space-y-2">
        {options.map((modelId: string) => {
          const available = isModelAvailable(modelId);
          const downloading = isModelDownloading(modelId);
          const isSelected = selectedModel === modelId;
          const { stars, label } = getStarRating(modelId);

          return (
            <div key={modelId} className="space-y-2">
              <div
                className={`flex items-center justify-between p-3 rounded-lg border transition-all ${
                  isSelected
                    ? 'border-cyan-400 bg-cyan-400/10'
                    : available
                    ? 'border-white/20 bg-white/5 hover:bg-white/10 cursor-pointer'
                    : 'border-amber-500/20 bg-amber-500/5 hover:bg-amber-500/10 cursor-pointer'
                }`}
                onClick={() => available ? onSelect(modelId) : onModelDownload(modelId)}
              >
                <div className="flex items-center gap-3">
                  {/* Status indicator */}
                  {(() => {
                    if (isSelected) {
                      return <Check className="h-4 w-4 text-green-400 flex-shrink-0" />;
                    } else if (available) {
                      return <div className="h-4 w-4 flex-shrink-0" />;
                    } else if (downloading) {
                      return <Loader2 className="h-4 w-4 text-amber-400 animate-spin flex-shrink-0" />;
                    } else {
                      return <Download className="h-4 w-4 text-amber-400 flex-shrink-0" />;
                    }
                  })()}

                  <div className="flex-1">
                    <div className={`text-sm font-medium ${available ? 'text-white' : 'text-white/60'}`}>
                      {getModelDisplayName(modelId)}
                    </div>
                    <div className="text-xs text-white/50">
                      {modelId.split('/')[0]}
                    </div>
                  </div>

                  {/* Star rating */}
                  <div className="flex items-center gap-1">
                    {[...Array(5)].map((_, i) => (
                      <Star
                        key={i}
                        className={`h-3 w-3 ${
                          i < stars ? 'text-yellow-400 fill-yellow-400' : 'text-white/20'
                        }`}
                      />
                    ))}
                    <span className="text-xs text-white/60 ml-1">{label}</span>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {/* Download button for unavailable models */}
                  {!available && !downloading && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onModelDownload(modelId);
                      }}
                      className="px-2 py-1 rounded text-xs bg-amber-500/20 hover:bg-amber-500/30 text-amber-400 flex items-center gap-1 border border-amber-500/30"
                    >
                      <Download className="h-3 w-3" />
                      Download
                    </button>
                  )}
                  {downloading && (
                    <span className="text-xs text-yellow-400 flex items-center gap-1">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      Downloading...
                    </span>
                  )}

                  {/* Details button */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowDetails(showDetails === modelId ? null : modelId);
                    }}
                    className="p-1 rounded hover:bg-white/10"
                    title="Show details"
                  >
                    <Info className="h-4 w-4 text-white/60" />
                  </button>

                  {/* Selection status */}
                  {isSelected && available && (
                    <span className="text-xs text-cyan-400 font-semibold">Selected</span>
                  )}
                </div>
              </div>

              {/* Details pane */}
              {showDetails === modelId && (
                <div className="ml-6 p-3 rounded-lg bg-white/5 border border-white/10">
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <div className="text-white/60">Model ID:</div>
                      <div className="text-white font-mono text-xs">{modelId}</div>
                    </div>
                    <div>
                      <div className="text-white/60">Provider:</div>
                      <div className="text-white">{modelId.split('/')[0]}</div>
                    </div>
                    <div>
                      <div className="text-white/60">Quality Rating:</div>
                      <div className="text-white flex items-center gap-1">
                        {[...Array(5)].map((_, i) => (
                          <Star
                            key={i}
                            className={`h-3 w-3 ${
                              i < stars ? 'text-yellow-400 fill-yellow-400' : 'text-white/20'
                            }`}
                          />
                        ))}
                        <span className="ml-1">{label}</span>
                      </div>
                    </div>
                    <div>
                      <div className="text-white/60">Status:</div>
                      <div className="text-white">
                        {available ? 'Available' : downloading ? 'Downloading...' : 'Not Downloaded'}
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 pt-3 border-t border-white/10">
                    <div className="text-white/60 text-xs">
                      {role === 'main'
                        ? 'This model handles chat completions and tool calling for your conversations.'
                        : 'This model summarizes conversation history to maintain context over long discussions.'
                      }
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-2">
        <HardDrive className="h-5 w-5 text-green-400" />
        <div>
          <h4 className="font-medium text-white">Model Selection</h4>
          <p className="text-xs text-white/60">Choose your preferred models for this quality tier</p>
        </div>
      </div>

      {/* Side-by-side Model Selection */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Main Model Selection */}
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <HardDrive className="h-4 w-4 text-green-400" />
            <div>
              <h4 className="font-medium text-white">Main Chat Model</h4>
              <p className="text-xs text-white/60">Handles chat completions and tool calling</p>
            </div>
          </div>
          <ModelList
            options={mainOptions}
            selectedModel={selectedMainModel}
            onSelect={onMainModelSelect}
            role="main"
          />
        </div>

        {/* Rolling Summarizer Selection */}
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <HardDrive className="h-4 w-4 text-blue-400" />
            <div>
              <h4 className="font-medium text-white">Rolling Summarizer</h4>
              <p className="text-xs text-white/60">Summarizes conversation history for context</p>
            </div>
          </div>
          <ModelList
            options={allSummarizerOptions}
            selectedModel={selectedSummarizerModel}
            onSelect={onSummarizerModelSelect}
            role="summarizer"
          />
        </div>
      </div>

      {/* Selection Summary */}
      {(selectedMainModel || selectedSummarizerModel) && (
        <div className="text-xs text-green-400 bg-green-900/20 border border-green-500/30 rounded px-3 py-2 space-y-1">
          {selectedMainModel && (
            <div>✓ Main: {getModelDisplayName(selectedMainModel)}</div>
          )}
          {selectedSummarizerModel && (
            <div>✓ Summarizer: {getModelDisplayName(selectedSummarizerModel)}</div>
          )}
        </div>
      )}
    </div>
  );
}