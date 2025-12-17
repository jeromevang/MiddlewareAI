// =============================================================================
// Model Selector for Quality Presets (Main & Rolling Summarizer)
// =============================================================================

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Download, Loader2, HardDrive, Info, Star, Lock, Unlock, AlertTriangle, Zap, CheckCircle, XCircle, RefreshCw } from "lucide-react";
import { getModelDisplayName } from './model-config/constants';
import { getModelStatus, getModelLocks, toggleModelLock } from "../../lib/api";
import { ModelCapabilityBadges } from "../ui/ModelCapabilityBadges";

// Tool probe result interface
interface ToolProbeResult {
  modelId: string;
  toolCallFormat: 'structured' | 'text_xml' | 'text_json' | 'text_func' | 'none';
  preferredNaming: string;
  supportsStructuredCalls: boolean;
  supportsTextCalls: boolean;
  recommendation: string;
  testedAt: string;
}

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
  const [probeResult, setProbeResult] = useState<ToolProbeResult | null>(null);
  const [showProbeDetails, setShowProbeDetails] = useState(false);
  const queryClient = useQueryClient();

  // Mutation for probing model tool capabilities
  const probeMutation = useMutation({
    mutationFn: async (modelId: string) => {
      const response = await fetch('/api/tools/probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId }),
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Probe failed');
      }
      return response.json();
    },
    onSuccess: (data) => {
      setProbeResult(data.capabilities);
      setShowProbeDetails(true);
    },
  });

  // Fetch model availability status - WebSocket provides real-time updates
  // Only fetch initially and on manual refresh (no polling!)
  const { data: modelStatusData } = useQuery({
    queryKey: ['modelStatus'],
    queryFn: getModelStatus,
    staleTime: 60000, // Consider data fresh for 1 minute
    refetchInterval: false, // WebSocket handles real-time updates
  });

  // Fetch model lock states
  const { data: locksData } = useQuery({
    queryKey: ['modelLocks'],
    queryFn: getModelLocks,
    staleTime: 5000,
  });

  // Fetch available models with capabilities
  const { data: availableModelsData } = useQuery({
    queryKey: ['availableModels'],
    queryFn: async () => {
      const response = await fetch('/models/available');
      if (!response.ok) throw new Error('Failed to fetch models');
      return response.json();
    },
    staleTime: 60000,
  });

  // Map of model ID to capability info
  const modelCapabilities: Record<string, any> = {};
  (availableModelsData?.models || []).forEach((m: any) => {
    modelCapabilities[m.modelKey] = m;
  });

  // Mutation for toggling lock state
  const toggleLockMutation = useMutation({
    mutationFn: (modelId: string) => toggleModelLock(modelId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['modelLocks'] });
    },
  });

  const modelAvailability: Record<string, any> = modelStatusData?.availability || {};
  const activeDownloads: Record<string, any> = modelStatusData?.activeDownloads || {};
  const loadedModels: string[] = modelStatusData?.loadedModels || [];
  const modelLocks: Record<string, { preset?: boolean; loaded?: boolean }> = locksData?.locks || {};

  // Check if a model is currently loaded in LM Studio
  const isModelLoaded = (modelId: string): boolean => {
    return loadedModels.includes(modelId);
  };

  // Check if a model is available
  const isModelAvailable = (modelId: string): boolean => {
    return modelAvailability[modelId]?.available ?? false;
  };

  // Check if a model is currently downloading
  const isModelDownloading = (modelId: string): boolean => {
    return modelAvailability[modelId]?.downloading ?? !!activeDownloads[modelId];
  };

  // Check if a model is locked (preset lock - prevents removal from presets)
  const isModelLocked = (modelId: string): boolean => {
    return !!modelLocks[modelId]?.preset;
  };

  // Handle lock toggle
  const handleToggleLock = (modelId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    toggleLockMutation.mutate(modelId);
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
  
  // Use actual rollingSummarizerOptions from preset instead of filtering mainOptions
  const allSummarizerOptions = preset?.rollingSummarizerOptions || [];

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
          const capabilities = modelCapabilities[modelId] || {};
          const isAgentic = capabilities.agenticViable;
          const showWarning = role === 'main' && !isAgentic && available;

          return (
            <div key={modelId} className="space-y-2">
              <div
                className={`flex flex-col gap-2 p-3 rounded-lg border transition-all ${
                  isSelected
                    ? 'border-cyan-400 bg-cyan-400/10'
                    : showWarning
                    ? 'border-amber-500/30 bg-amber-500/5 hover:bg-amber-500/10 cursor-pointer'
                    : available
                    ? 'border-white/20 bg-white/5 hover:bg-white/10 cursor-pointer'
                    : 'border-amber-500/20 bg-amber-500/5 hover:bg-amber-500/10 cursor-pointer'
                }`}
                onClick={() => available ? onSelect(modelId) : onModelDownload(modelId)}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    {/* Status indicators */}
                    <div className="flex flex-col gap-1">
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

                      {/* Loaded indicator */}
                      {isModelLoaded(modelId) && (
                        <div className="h-2 w-2 bg-green-500 rounded-full flex-shrink-0" title="Loaded in LM Studio" />
                      )}
                    </div>

                    <div className="flex-1">
                      <div className={`text-sm font-medium ${available ? 'text-white' : 'text-white/60'}`}>
                        {getModelDisplayName(modelId)}
                      </div>
                      <div className="text-xs text-white/50">
                        {modelId.split('/')[0]}
                      </div>
                    </div>
                  </div>

                  {/* Warning for non-agentic main models */}
                  {showWarning && (
                    <span title={capabilities.agenticViableReason || 'Not recommended for agentic tasks'}>
                      <AlertTriangle className="h-4 w-4 text-amber-400 flex-shrink-0" />
                    </span>
                  )}
                </div>

                {/* Capability badges - show if we have capability data */}
                {Object.keys(capabilities).length > 0 && (
                  <ModelCapabilityBadges 
                    model={capabilities} 
                    compact 
                    showScore={role === 'main'}
                    showContext={role === 'main'}
                  />
                )}

                {/* Warning message for non-agentic models selected as main */}
                {showWarning && isSelected && (
                  <div className="text-xs text-amber-400 flex items-center gap-1.5 mt-1">
                    <AlertTriangle className="h-3 w-3" />
                    {capabilities.agenticViableReason || 'May not work well for tool calling'}
                  </div>
                )}

                {/* Action buttons row */}
                <div className="flex items-center justify-end gap-2 mt-1">
                  {/* Lock button - prevents removal from presets */}
                  {available && (
                    <button
                      onClick={(e) => handleToggleLock(modelId, e)}
                      className={`p-1.5 rounded transition-colors ${
                        isModelLocked(modelId)
                          ? 'bg-amber-500/20 text-amber-400 hover:bg-amber-500/30'
                          : 'bg-white/5 text-white/40 hover:bg-white/10 hover:text-white/60'
                      }`}
                      title={isModelLocked(modelId) 
                        ? "Locked - Won't be removed during re-analysis. Click to unlock." 
                        : "Click to lock - Prevent removal during re-analysis"
                      }
                    >
                      {isModelLocked(modelId) ? (
                        <Lock className="h-3.5 w-3.5" />
                      ) : (
                        <Unlock className="h-3.5 w-3.5" />
                      )}
                    </button>
                  )}

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
                        {(() => {
                          const rating = getStarRating(modelId);
                          return (
                            <>
                              {[...Array(5)].map((_, i) => (
                                <Star
                                  key={i}
                                  className={`h-3 w-3 ${
                                    i < rating.stars ? 'text-yellow-400 fill-yellow-400' : 'text-white/20'
                                  }`}
                                />
                              ))}
                              <span className="ml-1">{rating.label}</span>
                            </>
                          );
                        })()}
                      </div>
                    </div>
                    <div>
                      <div className="text-white/60">Status:</div>
                      <div className="text-white">
                        {available ? 'Available' : downloading ? 'Downloading...' : 'Not Downloaded'}
                        {isModelLoaded(modelId) && <span className="ml-2 text-green-400">• Loaded</span>}
                        {isModelLocked(modelId) && <span className="ml-2 text-amber-400">• Locked</span>}
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
      {/* Side-by-side Model Selection */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Main Model Selection */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <HardDrive className="h-4 w-4 text-green-400" />
              <div>
                <h4 className="font-medium text-white">Main Chat Model</h4>
                <p className="text-xs text-white/60">Handles chat completions and tool calling</p>
              </div>
            </div>
            
            {/* Check Tooling Button */}
            {selectedMainModel && (
              <button
                onClick={() => probeMutation.mutate(selectedMainModel)}
                disabled={probeMutation.isPending}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                  probeMutation.isPending
                    ? 'bg-purple-500/20 text-purple-300 cursor-wait'
                    : 'bg-purple-500/20 hover:bg-purple-500/30 text-purple-400 border border-purple-500/30'
                }`}
                title="Test if the current model supports tool calling"
              >
                {probeMutation.isPending ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Testing...
                  </>
                ) : (
                  <>
                    <Zap className="h-3.5 w-3.5" />
                    Check Tooling
                  </>
                )}
              </button>
            )}
          </div>

          {/* Probe Results */}
          {showProbeDetails && probeResult && (
            <div className={`p-3 rounded-lg border ${
              probeResult.supportsStructuredCalls
                ? 'bg-green-500/10 border-green-500/30'
                : probeResult.supportsTextCalls
                  ? 'bg-amber-500/10 border-amber-500/30'
                  : 'bg-red-500/10 border-red-500/30'
            }`}>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  {probeResult.supportsStructuredCalls ? (
                    <CheckCircle className="h-4 w-4 text-green-400" />
                  ) : probeResult.supportsTextCalls ? (
                    <AlertTriangle className="h-4 w-4 text-amber-400" />
                  ) : (
                    <XCircle className="h-4 w-4 text-red-400" />
                  )}
                  <span className={`text-sm font-medium ${
                    probeResult.supportsStructuredCalls
                      ? 'text-green-400'
                      : probeResult.supportsTextCalls
                        ? 'text-amber-400'
                        : 'text-red-400'
                  }`}>
                    {probeResult.supportsStructuredCalls 
                      ? 'Full Tool Support'
                      : probeResult.supportsTextCalls
                        ? 'Text-Based Tools Only'
                        : 'Limited Tool Support'}
                  </span>
                </div>
                <button
                  onClick={() => setShowProbeDetails(false)}
                  className="text-white/40 hover:text-white/60 text-xs"
                >
                  ✕
                </button>
              </div>
              
              <div className="space-y-1 text-xs">
                <div className="flex items-center gap-2 text-white/70">
                  <span className="text-white/50">Format:</span>
                  <span className="font-mono bg-white/10 px-1.5 py-0.5 rounded">
                    {probeResult.toolCallFormat}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-white/70">
                  <span className="text-white/50">Naming:</span>
                  <span className="font-mono bg-white/10 px-1.5 py-0.5 rounded">
                    {probeResult.preferredNaming}
                  </span>
                </div>
                <div className="mt-2 text-white/60 text-xs">
                  {probeResult.supportsStructuredCalls 
                    ? '✅ All middleware tools available (rag_search, file_read, web_search, etc.)'
                    : probeResult.supportsTextCalls
                      ? '⚠️ Core tools only (rag_search, file_read, file_list) - text parsing enabled'
                      : '❌ Consider using "core-only" mode or switching to a model with tool support'}
                </div>
              </div>
            </div>
          )}

          {/* Probe Error */}
          {probeMutation.isError && (
            <div className="p-2 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-xs flex items-center gap-2">
              <XCircle className="h-4 w-4 flex-shrink-0" />
              <span>Probe failed: {(probeMutation.error as Error)?.message}</span>
              <button
                onClick={() => probeMutation.reset()}
                className="ml-auto text-white/40 hover:text-white/60"
              >
                ✕
              </button>
            </div>
          )}

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