// =============================================================================
// Simple Model Configuration Panel - Demonstrates Reorganized Layout
// =============================================================================

import { useState, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card } from "../ui/Card";
import { Button } from "../ui/Button";
import { ChevronDown, ChevronUp, Loader2 } from "lucide-react";
import { DownloadProgress } from "../ui/DownloadProgress";
import { ResourceBars } from "../ui/ResourceBars";
import { CustomPresetPanel } from "./CustomPresetPanel";
import { MainModelSelector } from "./MainModelSelector";
import { RagIndexingStatus } from "../ui/RagIndexingStatus";
import clsx from "clsx";

// Import from split files
import type { RagTier } from './model-config/types';
import { RAG_TIERS } from './model-config/constants';
import { saveQualityPresetModel, saveQualityPresetSummarizer, downloadModel } from '../../lib/api';


export default function ModelConfigPanel() {
  const queryClient = useQueryClient();

  // Basic state
  const [mode, setMode] = useState<"local" | "cloud">("local");
  const [quality, setQuality] = useState<"high" | "medium" | "low" | "custom">("low"); // Will sync from backend
  const [showModelDiscovery, setShowModelDiscovery] = useState(false);
  const [ragTier, setRagTier] = useState<RagTier>('low');
  const [pendingTierChange, setPendingTierChange] = useState<RagTier | null>(null);

  // Fetch presets from API
  const { data: presetsData, isLoading: presetsLoading } = useQuery({
    queryKey: ['presets'],
    queryFn: async () => {
      const response = await fetch('/models/presets');
      if (!response.ok) throw new Error('Failed to fetch presets');
      return response.json();
    },
    staleTime: 30000, // 30 seconds
  });

  // Fetch available models for Custom Preset panel
  const { data: availableModelsData } = useQuery({
    queryKey: ['availableModels'],
    queryFn: async () => {
      console.log('[ModelConfigPanel] Fetching available models');
      const response = await fetch('/models/available');
      if (!response.ok) throw new Error('Failed to fetch available models');
      const data = await response.json();
      console.log('[ModelConfigPanel] Available models fetched:', data.models?.length || 0, 'models');
      return data;
    },
    staleTime: 30000, // 30 seconds
  });

  // Fetch current config from /status endpoint
  const { data: configData } = useQuery({
    queryKey: ['status'],
    queryFn: async () => {
      const response = await fetch('/status');
      if (!response.ok) throw new Error('Failed to fetch status');
      return response.json();
    },
    staleTime: 10000, // 10 seconds
  });

  // Sync quality state from backend when config loads
  useEffect(() => {
    if (configData?.config?.models?.activePreset) {
      const backendPreset = configData.config.models.activePreset;
      if (backendPreset !== quality) {
        console.log('[ModelConfigPanel] Syncing preset from backend:', backendPreset);
        setQuality(backendPreset);
      }
    }
  }, [configData?.config?.models?.activePreset]);

  // Sync RAG tier from backend
  useEffect(() => {
    if (configData?.config?.ragPipeline?.tier) {
      const backendTier = configData.config.ragPipeline.tier as RagTier;
      if (backendTier !== ragTier) {
        console.log('[ModelConfigPanel] Syncing RAG tier from backend:', backendTier);
        setRagTier(backendTier);
      }
    }
  }, [configData?.config?.ragPipeline?.tier]);

  // Prepare presets data
  const presets = presetsData?.presets || {
    high: { name: 'High Quality', description: 'Loading...', embedding: '', ragSummarizer: '', rollingSummarizer: '', mainOptions: [] },
    medium: { name: 'Balanced', description: 'Loading...', embedding: '', ragSummarizer: '', rollingSummarizer: '', mainOptions: [] },
    low: { name: 'Fast & Lightweight', description: 'Loading...', embedding: '', ragSummarizer: '', rollingSummarizer: '', mainOptions: [] },
  };

  const refetchModelStatus = () => {
    queryClient.invalidateQueries({ queryKey: ['modelStatus'] });
  };

  // RAG Tier Change Mutation
  const changeRagTierMutation = useMutation({
    mutationFn: async (tier: string) => {
      const currentTier = configData?.config?.ragPipeline?.tier || 'medium';

      // Check if re-indexing is needed
      const reindexRes = await fetch(`/rag/check-reindex?from=${currentTier}&to=${tier}`);
      if (!reindexRes.ok) throw new Error('Failed to check reindex requirement');

      const { needsReindex } = await reindexRes.json();

      if (needsReindex) {
        // Show confirmation dialog for reindexing
        const confirmed = window.confirm(
          `Changing RAG quality from ${currentTier} to ${tier} requires re-indexing your entire codebase.\n\n` +
          `This will:\n` +
          `• Clear existing embeddings\n` +
          `• Re-analyze all source files\n` +
          `• Generate new embeddings with the new model\n\n` +
          `This process may take several minutes depending on your codebase size.\n\n` +
          `Continue with reindexing?`
        );

        if (!confirmed) {
          throw new Error('Reindexing cancelled by user');
        }

        // Start re-indexing process
        console.log('Starting reindexing process...');
        const reindexResponse = await fetch('/rag/reindex', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: `tier-change-${currentTier}-to-${tier}` })
        });
        if (!reindexResponse.ok) {
          throw new Error('Failed to start reindexing');
        }
      }

      // Auto-download required models
      console.log('🔄 Ensuring required models are available...', { tier, previousTier: currentTier });
      try {
        console.log('📡 Making fetch call to /rag/ensure-models...');
        const downloadRes = await fetch(`/rag/ensure-models`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tier, previousTier: currentTier })
        });
        console.log('✅ ensure-models response received:', downloadRes.status, downloadRes.statusText);
        if (!downloadRes.ok) {
          const errorText = await downloadRes.text();
          console.error('❌ ensure-models failed:', errorText);
          console.warn('⚠️ Some models may need manual download');
        } else {
          const successText = await downloadRes.text();
          console.log('🎉 ensure-models success:', successText);
        }
      } catch (error) {
        console.error('💥 ensure-models fetch failed:', error);
      }

      // Change the tier
      const res = await fetch("/rag/tier", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier }),
      });
      if (!res.ok) throw new Error('Failed to change RAG tier');

      return res.json();
    },
    onSuccess: (_, tier) => {
      console.log('RAG tier changed successfully to:', tier);
      queryClient.invalidateQueries({ queryKey: ['ragTier'] });
      queryClient.invalidateQueries({ queryKey: ['config'] });
      queryClient.invalidateQueries({ queryKey: ['modelStatus'] });
    },
    onError: (err) => {
      console.error('Failed to change RAG tier:', err);
      alert(`Failed to change RAG tier: ${err.message}`);
    },
  });

  // Handle main model selection for quality presets
  const handleMainModelChange = useMutation({
    mutationFn: async (modelId: string) => {
      return saveQualityPresetModel({ quality: quality as 'high' | 'medium' | 'low', modelId });
    },
    onSuccess: (result) => {
      console.log('Quality preset model saved:', result);
      queryClient.invalidateQueries({ queryKey: ['config'] });
    },
    onError: (err) => {
      console.error('Failed to save quality preset model:', err);
      alert(`Failed to save model selection: ${err.message}`);
    },
  });

  // Handle summarizer model selection for quality presets
  const handleSummarizerModelChange = useMutation({
    mutationFn: async (summarizerId: string) => {
      return saveQualityPresetSummarizer({ quality: quality as 'high' | 'medium' | 'low', summarizerId });
    },
    onSuccess: (result) => {
      console.log('Quality preset summarizer saved:', result);
      queryClient.invalidateQueries({ queryKey: ['config'] });
    },
    onError: (err) => {
      console.error('Failed to save summarizer selection:', err);
      alert(`Failed to save summarizer selection: ${err.message}`);
    },
  });

  // Handle model download
  const handleDownloadModel = useMutation({
    mutationFn: async (modelId: string) => {
      return downloadModel(modelId);
    },
    onSuccess: (result) => {
      console.log('Download started:', result);
      refetchModelStatus(); // Refresh model status to show download progress
    },
    onError: (err) => {
      console.error('Failed to start download:', err);
      alert(`Failed to start download: ${err.message}`);
    },
  });

  // RAG Tier Change Handlers
  const handleTierChange = (newTier: RagTier) => {
    if (newTier === ragTier) return;
    setPendingTierChange(newTier);
  };

  const handleConfirmTierChange = () => {
    if (pendingTierChange) {
      changeRagTierMutation.mutate(pendingTierChange);
      setRagTier(pendingTierChange);
      setPendingTierChange(null);
    }
  };

  const handleCancelTierChange = () => {
    setPendingTierChange(null);
  };

  return (
    <div className="space-y-6">
      {/* Mode Selection */}
      <Card title="Configuration Mode" subtitle="Choose between local models or cloud RAG">
        <div className="space-y-4">
          <div className="flex gap-6">
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="radio"
                value="local"
                checked={mode === "local"}
                onChange={(e) => setMode(e.target.value as "local")}
                className="w-4 h-4"
              />
              <div>
                <div className="font-semibold text-white">Local Models (LM Studio)</div>
                <div className="text-sm text-white/70">Run all models locally with LM Studio for maximum control</div>
              </div>
            </label>
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="radio"
                value="cloud"
                checked={mode === "cloud"}
                onChange={(e) => setMode(e.target.value as "cloud")}
                className="w-4 h-4"
              />
              <div>
                <div className="font-semibold text-white">Cloud RAG (Google + Qdrant)</div>
                <div className="text-sm text-white/70">Use Google embeddings and Qdrant vector database</div>
              </div>
            </label>
          </div>
        </div>
      </Card>

      {mode === "local" ? (
        <>
          {/* RAG Pipeline Quality - only for standard presets */}
          {quality !== 'custom' && (
            <Card title="RAG Pipeline Quality" subtitle="Fixed models per quality tier - changing tier re-indexes codebase">
              <div className="space-y-4">
                {/* Tier Selector */}
                <div className="grid grid-cols-3 gap-2">
                  {(Object.keys(RAG_TIERS) as RagTier[]).map((tier) => {
                    const tierConfig = RAG_TIERS[tier];
                    const isSelected = ragTier === tier;
                    const isPending = pendingTierChange === tier;

                    return (
                      <button
                        key={tier}
                        onClick={() => handleTierChange(tier)}
                        className={clsx(
                          "p-3 rounded-lg text-left transition-all",
                          isSelected
                            ? "bg-blue-600/30 border-2 border-blue-500"
                            : isPending
                            ? "bg-yellow-600/20 border-2 border-yellow-500/50"
                            : "bg-white/5 border border-white/20 hover:bg-white/10"
                        )}
                      >
                        <div className="font-medium text-white">{tierConfig.name}</div>
                        <div className="text-xs text-white/50 mt-1">
                          {tierConfig.targetGPU}
                        </div>
                      </button>
                    );
                  })}
                </div>

                {/* Pending Tier Change Confirmation */}
                {pendingTierChange && (
                  <div className="p-3 rounded-lg bg-yellow-900/30 border border-yellow-500/50">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm text-yellow-200">
                          ⚠️ Change to <strong>{RAG_TIERS[pendingTierChange].name}</strong>?
                        </p>
                        <p className="text-xs text-yellow-200/70">
                          This will re-index your entire codebase.
                        </p>
                      </div>
                      <div className="flex gap-2">
                        <button
                          onClick={handleCancelTierChange}
                          className="px-3 py-1 rounded text-sm bg-white/10 text-white hover:bg-white/20"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={handleConfirmTierChange}
                          disabled={changeRagTierMutation.isPending}
                          className="px-3 py-1 rounded text-sm bg-yellow-600 text-white hover:bg-yellow-700 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {changeRagTierMutation.isPending ? 'Changing...' : 'Confirm'}
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {/* Current Tier Models Display */}
                <div className="mt-4 p-3 bg-white/5 border border-white/10 rounded-lg">
                  <h4 className="text-sm font-semibold text-white mb-2">Current Configuration ({RAG_TIERS[ragTier].name})</h4>
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <span className="text-white/60">Embedder:</span>
                      <span className="ml-2 text-white">{RAG_TIERS[ragTier].embedder.model_name}</span>
                    </div>
                    <div>
                      <span className="text-white/60">RAG Summarizer:</span>
                      <span className="ml-2 text-white">{RAG_TIERS[ragTier].ragSummarizer.model_name}</span>
                    </div>
                  </div>
                </div>

                {/* RAG Indexing Status */}
                <RagIndexingStatus />
              </div>
            </Card>
          )}

          {/* Real-time Resource Monitoring - Always Visible */}
          <ResourceBars />

          {/* Quality Presets */}
          <Card title="Quality Presets" subtitle="Select a preset to automatically configure optimal models">
            {presetsLoading ? (
              <div className="text-center py-8 text-white/60">Loading presets...</div>
            ) : (
              <div className="grid gap-4 grid-cols-2 md:grid-cols-4">
                {(['high', 'medium', 'low', 'custom'] as const).map((key) => {
                  const preset = presets[key];

                  const presetMeta = {
                    high: { name: preset?.name || 'High Quality', description: preset?.description || 'Loading...', color: 'cyan' },
                    medium: { name: preset?.name || 'Balanced', description: preset?.description || 'Loading...', color: 'purple' },
                    low: { name: preset?.name || 'Fast & Light', description: preset?.description || 'Loading...', color: 'green' },
                    custom: { name: 'Custom', description: 'Manual selection', color: 'amber' },
                  };
                  const meta = presetMeta[key];
                  const colorClasses = {
                    cyan: 'border-cyan-400 bg-cyan-400/10',
                    purple: 'border-purple-400 bg-purple-400/10',
                    green: 'border-green-400 bg-green-400/10',
                    amber: 'border-amber-400 bg-amber-400/10',
                  };

                  return (
                    <div
                      key={key}
                      className={`p-4 border rounded-lg transition-all ${
                        quality === key
                          ? colorClasses[meta.color as keyof typeof colorClasses]
                          : 'border-white/15 bg-white/5 hover:border-white/30 cursor-pointer'
                      }`}
                      onClick={() => {
                        setQuality(key);
                        // Temporarily disabled automatic RAG tier changes to prevent model loading issues
                        // if (!isCustom && key !== quality) {
                        //   // Update RAG tier to match the preset quality
                        //   const ragTierMap = { high: 'high', medium: 'medium', low: 'low' };
                        //   if (ragTierMap[key as keyof typeof ragTierMap]) {
                        //     changeRagTierMutation.mutate(ragTierMap[key as keyof typeof ragTierMap]);
                        //   }
                        // }
                      }}
                    >
                      <h3 className="font-semibold text-white mb-1">{meta.name}</h3>
                      <p className="text-sm text-white/70">{meta.description}</p>

                      {quality === key && (
                        <div className="mt-2 text-xs text-green-400 font-semibold">✓ Selected</div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          {/* Preset Model Selection */}
          {quality !== 'custom' && (
            <Card title={`Select ${presets[quality]?.name || quality} Model`} subtitle="Choose your preferred model for this quality tier">
              <div className="space-y-4">
                <MainModelSelector
                  quality={quality}
                  preset={presets[quality]}
                  selectedMainModel={configData?.config?.models?.perQualityMainModels?.[quality] || ''}
                  selectedSummarizerModel={configData?.config?.models?.perQualityRollingSummarizers?.[quality] || ''}
                  onMainModelSelect={(modelId) => handleMainModelChange.mutate(modelId)}
                  onSummarizerModelSelect={(summarizerId) => handleSummarizerModelChange.mutate(summarizerId)}
                  onModelDownload={(modelId) => handleDownloadModel.mutate(modelId)}
                />
              </div>
            </Card>
          )}

          {/* Custom Preset Panel */}
          {quality === 'custom' && (
            <CustomPresetPanel
              availableModels={availableModelsData?.models || []}
              onConfigChange={() => {
                // Refresh after config change
                queryClient.invalidateQueries({ queryKey: ['presets'] });
              }}
              onModelDownloaded={() => {
                refetchModelStatus();
              }}
            />
          )}

          {/* Model Discovery & Re-analyze */}
          <div className="space-y-3">
            <div className="flex items-center gap-4">
              <button
                onClick={() => setShowModelDiscovery(!showModelDiscovery)}
                className="flex items-center gap-2 text-sm text-white/70 hover:text-white transition-colors"
              >
                {showModelDiscovery ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                Model Discovery (Advanced)
              </button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => console.log("Re-analyze models")}
                className="text-xs"
              >
                <Loader2 className="h-3 w-3 mr-1" />
                Re-analyze Models
              </Button>
            </div>
          </div>
        </>
      ) : (
        /* Cloud Configuration */
        <Card title="Cloud RAG Configuration" subtitle="Configure Google Studio and Qdrant for cloud-based embeddings">
          <div className="space-y-6">
            <div className="p-4 bg-amber-500/10 border border-amber-500/30 rounded-lg">
              <h4 className="font-semibold text-amber-400 mb-2">Cloud RAG Setup</h4>
              <p className="text-sm text-white/70 mb-3">
                This mode uses Google AI Studio for embeddings and Qdrant for vector storage.
                Your local models will still run through LM Studio.
              </p>
            </div>
          </div>
        </Card>
      )}

      {/* Download Progress Indicator */}
      <DownloadProgress downloads={{}} />
    </div>
  );
}
