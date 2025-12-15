import { useState, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { saveConfig, deleteAllSessions, reprocessSummaries, updateSummaryKeepRecent, triggerAction, listLoadedModels, unloadModel, unloadAllModels, refreshModelContext, checkLMStudioHealth, startLMStudioServer, stopLMStudioServer, loadRequiredModels, getPresets, setActiveModel, getModelStatus, downloadModel, getBootstrapStatus, triggerBootstrap } from "../../lib/api";
import type { QualityPreset, ModelAvailability } from "../../lib/api";
import { SuggestedModelsPanel } from "../ui/SuggestedModelsPanel";
import { useDashboardStore } from "../../state/dashboard-store";
import { Card } from "../ui/Card";
import { Button } from "../ui/Button";
import { ConfirmModal } from "../ui/ConfirmModal";
import { Cpu, HardDrive, Zap, ChevronDown, ChevronUp, Check, Download, Loader2 } from "lucide-react";

// Helper to get display name from model ID
function getModelDisplayName(modelId: string): string {
  const parts = modelId.split('/');
  const name = parts[parts.length - 1];
  return name
    .replace(/-GGUF$/i, '')
    .replace(/@.*$/, '')
    .replace(/-instruct$/i, ' Instruct')
    .replace(/-chat$/i, ' Chat');
}

interface ModelSelection {
  embedding: string;
  ragSummarizer: string;
  rollingSummarizer: string;
  main: string;
}

interface CloudSettings {
  googleStudioKey: string;
  qdrantUrl: string;
  qdrantApiKey: string;
}

interface ConfirmConfig {
  title: string;
  description: string;
  tone?: "default" | "danger";
  confirmLabel?: string;
  onConfirm: () => Promise<unknown> | void;
}

export default function ModelConfigPanel() {
  const status = useDashboardStore((s) => s.status);
  const sessions = status?.sessions ?? [];
  const processing = status?.processing;
  const selectSession = useDashboardStore((s) => s.selectSession);
  const queryClient = useQueryClient();

  // Fetch presets from API
  const { data: presetsData, isLoading: presetsLoading } = useQuery({
    queryKey: ['presets'],
    queryFn: getPresets,
    staleTime: 30000, // 30 seconds
  });

  // Fetch model availability status
  const { data: modelStatusData, refetch: refetchModelStatus } = useQuery({
    queryKey: ['modelStatus'],
    queryFn: getModelStatus,
    staleTime: 10000, // 10 seconds
    refetchInterval: 15000, // Refresh every 15 seconds
  });

  const modelAvailability: Record<string, ModelAvailability> = modelStatusData?.availability || {};

  // Fetch bootstrap status
  const { data: bootstrapData } = useQuery({
    queryKey: ['bootstrapStatus'],
    queryFn: getBootstrapStatus,
    staleTime: 2000, // 2 seconds
    refetchInterval: (query) => query.state.data?.running ? 1000 : 10000, // Poll faster when running
  });

  const isBootstrapping = bootstrapData?.running ?? false;
  const bootstrapProgress = bootstrapData?.progress ?? 0;
  const bootstrapMessage = bootstrapData?.message ?? '';

  const presets = presetsData?.presets || {
    high: { name: 'High Quality', description: 'Loading...', embedding: '', ragSummarizer: '', rollingSummarizer: '', mainOptions: [] },
    medium: { name: 'Balanced', description: 'Loading...', embedding: '', ragSummarizer: '', rollingSummarizer: '', mainOptions: [] },
    low: { name: 'Fast & Lightweight', description: 'Loading...', embedding: '', ragSummarizer: '', rollingSummarizer: '', mainOptions: [] },
  };
  const lastActiveModel = presetsData?.lastActiveModel || '';

  const [mode, setMode] = useState<"local" | "cloud">("local");
  const [quality, setQuality] = useState<"high" | "medium" | "low">("high");
  const [showModelDiscovery, setShowModelDiscovery] = useState(false);
  const [models, setModels] = useState<ModelSelection>({
    embedding: "",
    ragSummarizer: "",
    rollingSummarizer: "",
    main: ""
  });
  const [cloudSettings, setCloudSettings] = useState<CloudSettings>({
    googleStudioKey: "",
    qdrantUrl: "",
    qdrantApiKey: ""
  });
  const [message, setMessage] = useState("");

  // Maintenance state
  const keepRecentConfigured = processing?.summary_keep_recent_turns ?? 3;
  const [draftKeepRecent, setDraftKeepRecent] = useState(keepRecentConfigured);
  const [confirmConfig, setConfirmConfig] = useState<ConfirmConfig | null>(null);
  const [confirmLoading, setConfirmLoading] = useState(false);

  // LM Studio state
  const [loadedModels, setLoadedModels] = useState<any[]>([]);
  const [lmStudioHealth, setLMStudioHealth] = useState<{
    ready: boolean;
    server?: { status: string; output: string };
    models_loaded?: number;
    models?: any[];
    error?: string;
    timestamp?: number;
    lastChecked?: number;
  }>({ ready: false });
  const [lmStudioError, setLMStudioError] = useState<{
    title: string;
    description: string;
    action?: string;
    retryable?: boolean;
  } | null>(null);
  const [autoStarting, setAutoStarting] = useState(false);
  const [errorDismissed, setErrorDismissed] = useState(false);

  // Update models when quality or presets change
  useEffect(() => {
    const preset = presets[quality];
    if (preset && preset.embedding) {
      setModels(prev => ({
        embedding: preset.embedding,
        ragSummarizer: preset.ragSummarizer,
        rollingSummarizer: preset.rollingSummarizer,
        main: prev.main || preset.mainOptions?.[0] || lastActiveModel || ''
      }));
    }
  }, [quality, presets, lastActiveModel]);

  // Set initial main model from last active or first option
  useEffect(() => {
    if (!models.main && presetsData) {
      const preset = presets[quality];
      const initialMain = lastActiveModel || preset?.mainOptions?.[0] || '';
      if (initialMain) {
        setModels(prev => ({ ...prev, main: initialMain }));
      }
    }
  }, [presetsData]);

  // Load current config on mount
  useEffect(() => {
    if (status?.config) {
      const config = status.config as any;
      if (config.runtime?.mode) {
        setMode(config.runtime.mode);
      }
      if (config.models?.embedding?.model_name) {
        setModels(prev => ({ ...prev, embedding: config.models.embedding.model_name }));
      }
      if (config.models?.ragSummarization?.model_name) {
        setModels(prev => ({ ...prev, ragSummarizer: config.models.ragSummarization.model_name }));
      }
      if (config.models?.rollingSummarization?.model_name) {
        setModels(prev => ({ ...prev, rollingSummarizer: config.models.rollingSummarization.model_name }));
      }
      if (config.models?.main?.model_name) {
        setModels(prev => ({ ...prev, main: config.models.main.model_name }));
      }
    }
  }, [status]);

  // Update draft keep recent when config changes
  useEffect(() => {
    setDraftKeepRecent(keepRecentConfigured);
  }, [keepRecentConfigured]);

  // Auto-start and health monitoring for LM Studio
  useEffect(() => {
    let mounted = true;
    let interval: ReturnType<typeof setInterval>;

    const checkHealth = async () => {
      if (!mounted) return;
      try {
        await healthCheckMutation.mutateAsync();
      } catch (error) {
        // Error is handled by the mutation
      }
    };

    const autoStartIfNeeded = async () => {
      if (!mounted) return;

      // Only attempt auto-start if we're not already trying and server is not ready
      if (!lmStudioHealth.ready && !autoStarting && !startServerMutation.isPending) {
        console.log("LM Studio not ready, attempting auto-start...");
        setAutoStarting(true);

        try {
          await startServerMutation.mutateAsync();
          // Wait for server to start
          setTimeout(async () => {
            if (!mounted) return;
            await checkHealth();

            // If server is now ready but no models are loaded, try to load them
            if (lmStudioHealth.ready && lmStudioHealth.models_loaded === 0) {
              console.log("Server ready but no models loaded, attempting to load models...");
              try {
                await loadModelsMutation.mutateAsync();
              } catch (error) {
                console.warn("Auto model loading failed:", error);
              }
            }
          }, 3000);
        } catch (error) {
          // Error popup is handled by the mutation
          console.warn("Auto-start failed:", error);
        } finally {
          if (mounted) setAutoStarting(false);
        }
      }
    };

    // Initial health check
    checkHealth();

    // Auto-start check after initial health check
    const autoStartTimer = setTimeout(() => {
      autoStartIfNeeded();
    }, 2000);

    // Periodic health monitoring
    interval = setInterval(() => {
      checkHealth();
    }, 15000); // Check every 15 seconds

    return () => {
      mounted = false;
      clearTimeout(autoStartTimer);
      clearInterval(interval);
    };
  }, []); // Empty dependency array - only run once on mount

  // Show error popup when LM Studio is not available and we haven't shown it recently
  useEffect(() => {
    // Only show error if not dismissed by user
    if (!lmStudioHealth.ready && lmStudioHealth.error && !lmStudioError && !errorDismissed) {
      setLMStudioError({
        title: "LM Studio Connection Issue",
        description: `Cannot connect to LM Studio: ${lmStudioHealth.error}`,
        action: "Ensure LM Studio is installed and running",
        retryable: true
      });
    } else if (lmStudioHealth.ready) {
      // Clear error AND reset dismissed flag when connection is restored
      setLMStudioError(null);
      setErrorDismissed(false);
    }
  }, [lmStudioHealth.ready, lmStudioHealth.error, lmStudioError, errorDismissed]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyPress = (event: KeyboardEvent) => {
      // Only handle shortcuts when not typing in inputs
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
        return;
      }

      // Ctrl+R or Cmd+R to refresh LM Studio status
      if ((event.ctrlKey || event.metaKey) && event.key === 'r') {
        event.preventDefault();
        healthCheckMutation.mutate();
        setMessage("🔄 Refreshing LM Studio status...");
        setTimeout(() => setMessage(""), 2000);
      }

      // Ctrl+S or Cmd+S to save configuration
      if ((event.ctrlKey || event.metaKey) && event.key === 's') {
        event.preventDefault();
        handleSave();
      }
    };

    window.addEventListener('keydown', handleKeyPress);
    return () => window.removeEventListener('keydown', handleKeyPress);
  }, []);

  const mutation = useMutation({
    mutationFn: saveConfig,
    onSuccess: () => {
      setMessage("✅ Configuration saved successfully! Restart the middleware server to apply changes.");
      setTimeout(() => setMessage(""), 5000);
    },
    onError: (err: unknown) => {
      const detail = err instanceof Error ? err.message : "Save failed.";
      setMessage(`❌ ${detail}`);
    }
  });

  // Maintenance mutations
  const updateKeepMutation = useMutation({
    mutationFn: (value: number) => updateSummaryKeepRecent(value),
    onSuccess: (data) => {
      useDashboardStore.setState((prev) => {
        if (!prev.status) return prev;
        return {
          status: {
            ...prev.status,
            processing: {
              ...prev.status.processing,
              summary_keep_recent_turns: data.keepRecentTurns,
            },
          },
        };
      });
      setMessage(`✅ Keep recent turns set to ${data.keepRecentTurns}.`);
      setTimeout(() => setMessage(""), 3000);
    },
    onError: (err: unknown) => {
      const detail = err instanceof Error ? err.message : "Failed to update keep-recent setting.";
      setMessage(`❌ ${detail}`);
    },
  });

  const reprocessMutation = useMutation({
    mutationFn: () => reprocessSummaries(),
    onSuccess: (data) => {
      setMessage(`✅ Reprocessed ${data.processed} sessions.`);
      setTimeout(() => setMessage(""), 3000);
    },
    onError: (err: unknown) => {
      const detail = err instanceof Error ? err.message : "Reprocess failed.";
      setMessage(`❌ ${detail}`);
    },
  });

  const deleteAllMutation = useMutation({
    mutationFn: () => deleteAllSessions(),
    onSuccess: () => {
      setMessage("✅ Sessions deleted and RAG reset scheduled.");
      selectSession(null);
      queryClient.removeQueries({ queryKey: ["session-turns"] });
      useDashboardStore.setState((prev) => {
        if (!prev.status) return prev;
        return {
          ...prev,
          status: {
            ...prev.status,
            sessions: [],
          },
        };
      });
      setTimeout(() => setMessage(""), 3000);
    },
    onError: (err: unknown) => {
      const detail = err instanceof Error ? err.message : "Delete request failed.";
      setMessage(`❌ ${detail}`);
    },
  });

  const deleteAllDataMutation = useMutation({
    mutationFn: () => triggerAction("reset"),
    onSuccess: () => {
      setMessage("✅ All data deleted and system reset. Please restart the middleware server.");
      selectSession(null);
      queryClient.removeQueries({ queryKey: ["session-turns"] });
      useDashboardStore.setState((prev) => {
        if (!prev.status) return prev;
        return {
          ...prev,
          status: {
            ...prev.status,
            sessions: [],
          },
        };
      });
      setTimeout(() => setMessage(""), 5000);
    },
    onError: (err: unknown) => {
      const detail = err instanceof Error ? err.message : "Delete data request failed.";
      setMessage(`❌ ${detail}`);
    },
  });

  const listModelsMutation = useMutation({
    mutationFn: () => listLoadedModels(),
    onSuccess: (data: { status: string; models: any[] }) => {
      setLoadedModels(data.models || []);
      setMessage(`✅ Found ${data.models?.length || 0} loaded models`);
      setTimeout(() => setMessage(""), 3000);
    },
    onError: (err: unknown) => {
      const detail = err instanceof Error ? err.message : "Failed to list models.";
      setMessage(`❌ ${detail}`);
    },
  });

  const unloadModelMutation = useMutation({
    mutationFn: (modelId: string) => unloadModel(modelId),
    onSuccess: () => {
      setMessage("✅ Model unloaded successfully");
      // Refresh the model list
      listModelsMutation.mutate();
      setTimeout(() => setMessage(""), 3000);
    },
    onError: (err: unknown) => {
      const detail = err instanceof Error ? err.message : "Failed to unload model.";
      setMessage(`❌ ${detail}`);
    },
  });

  const unloadAllModelsMutation = useMutation({
    mutationFn: () => unloadAllModels(),
    onSuccess: () => {
      setMessage("✅ All models unloaded successfully");
      setLoadedModels([]);
      setTimeout(() => setMessage(""), 3000);
    },
    onError: (err: unknown) => {
      const detail = err instanceof Error ? err.message : "Failed to unload all models.";
      setMessage(`❌ ${detail}`);
    },
  });


  const refreshContextMutation = useMutation({
    mutationFn: () => refreshModelContext(),
    onSuccess: (data: { status: string; context: { model_context_length: number; max_context_tokens: number; context_budget_tokens: number } }) => {
      setMessage(`✅ Context refreshed: ${data.context.context_budget_tokens} token budget (${Math.round(data.context.context_budget_tokens / data.context.max_context_tokens * 100)}% of ${data.context.max_context_tokens})`);
      setTimeout(() => setMessage(""), 5000);
    },
    onError: (err: unknown) => {
      const detail = err instanceof Error ? err.message : "Failed to refresh context.";
      setMessage(`❌ ${detail}`);
    },
  });

  const healthCheckMutation = useMutation({
    mutationFn: () => checkLMStudioHealth(),
    onSuccess: (data) => {
      setLMStudioHealth({ ...data, lastChecked: Date.now() });
      setLMStudioError(null); // Clear any previous errors
    },
    onError: (error: any) => {
      setLMStudioHealth({
        ready: false,
        error: error.message || "Connection failed",
        lastChecked: Date.now()
      });
    },
  });

  const startServerMutation = useMutation({
    mutationFn: () => startLMStudioServer(),
    onSuccess: () => {
      setMessage("✅ LM Studio server started successfully");
      // Refresh health status after starting
      setTimeout(() => healthCheckMutation.mutate(), 2000);
      setTimeout(() => setMessage(""), 3000);
    },
    onError: (error: any) => {
      setLMStudioError({
        title: "Failed to Start LM Studio Server",
        description: `Could not start LM Studio server: ${error.message || error}`,
        action: "Check that LM Studio is installed and try again",
        retryable: true
      });
      setMessage(`❌ Failed to start LM Studio server`);
      setTimeout(() => setMessage(""), 5000);
    },
  });

  const stopServerMutation = useMutation({
    mutationFn: () => stopLMStudioServer(),
    onSuccess: () => {
      setMessage("✅ LM Studio server stopped successfully");
      // Refresh health status after stopping
      setTimeout(() => healthCheckMutation.mutate(), 1000);
      setTimeout(() => setMessage(""), 3000);
    },
    onError: (error: any) => {
      setMessage(`❌ Failed to stop LM Studio server: ${error.message || error}`);
      setTimeout(() => setMessage(""), 5000);
    },
  });

  const loadModelsMutation = useMutation({
    mutationFn: () => loadRequiredModels(),
    onSuccess: () => {
      setMessage("✅ Required models loaded successfully");
      // Refresh health status and model list after loading
      setTimeout(() => {
        healthCheckMutation.mutate();
        listModelsMutation.mutate();
        refreshContextMutation.mutate();
      }, 2000);
      setTimeout(() => setMessage(""), 3000);
    },
    onError: (error: any) => {
      setMessage(`❌ Failed to load required models: ${error.message || error}`);
      setTimeout(() => setMessage(""), 5000);
    },
  });

  const setActiveModelMutation = useMutation({
    mutationFn: (modelId: string) => setActiveModel(modelId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['presets'] });
    },
  });

  // Download model mutation
  const downloadModelMutation = useMutation({
    mutationFn: downloadModel,
    onSuccess: (data) => {
      setMessage(`✅ ${data.message}`);
      // Refresh model status after download
      setTimeout(() => {
        refetchModelStatus();
        queryClient.invalidateQueries({ queryKey: ['modelStatus'] });
      }, 2000);
      setTimeout(() => setMessage(""), 5000);
    },
    onError: (error: Error) => {
      setMessage(`❌ Download failed: ${error.message}`);
      setTimeout(() => setMessage(""), 5000);
    },
  });

  // Bootstrap mutation
  const bootstrapMutation = useMutation({
    mutationFn: triggerBootstrap,
    onSuccess: () => {
      setMessage("🔄 Model analysis started...");
      queryClient.invalidateQueries({ queryKey: ['bootstrapStatus'] });
      setTimeout(() => setMessage(""), 3000);
    },
    onError: (error: Error) => {
      setMessage(`❌ Bootstrap failed: ${error.message}`);
      setTimeout(() => setMessage(""), 5000);
    },
  });

  const handleMainModelChange = (modelId: string) => {
    setModels(prev => ({ ...prev, main: modelId }));
    // Track the active model
    setActiveModelMutation.mutate(modelId);
  };

  const handleDownloadModel = (modelId: string) => {
    setMessage(`⏳ Downloading ${getModelDisplayName(modelId)}...`);
    downloadModelMutation.mutate(modelId);
  };

  // Check if a model is available
  const isModelAvailable = (modelId: string): boolean => {
    return modelAvailability[modelId]?.available ?? false;
  };

  // Check if a model is currently downloading
  const isModelDownloading = (modelId: string): boolean => {
    return modelAvailability[modelId]?.downloading ?? downloadModelMutation.isPending;
  };

  const handleSave = () => {
    if (!models.main.trim()) {
      setMessage("❌ Please specify a main chat model.");
      return;
    }

    setMessage("💾 Saving configuration…");

    if (mode === "cloud") {
      // Cloud configuration
      const config = {
        runtime: { mode: "cloud" },
        models: {
          embedding: {
            engine: "cloud",
            provider: "google",
            api_key: cloudSettings.googleStudioKey,
            model_name: "text-embedding-3-small"
          },
          ragSummarization: {
            model_name: models.ragSummarizer,
            identifier: models.ragSummarizer.split('/').pop()
          },
          rollingSummarization: {
            model_name: models.rollingSummarizer,
            identifier: models.rollingSummarizer.split('/').pop()
          },
          main: {
            model_name: models.main,
            identifier: models.main.split('/').pop()
          }
        },
        cloud: {
          qdrant: {
            url: cloudSettings.qdrantUrl,
            api_key: cloudSettings.qdrantApiKey
          }
        }
      };
      mutation.mutate(config);
    } else {
      // Local configuration with selected models
      const config = {
        runtime: { mode: "local" },
        models: {
          embedding: {
            engine: "local",
            model_name: models.embedding,
            identifier: models.embedding.split('/').pop()
          },
          ragSummarization: {
            model_name: models.ragSummarizer,
            identifier: models.ragSummarizer.split('/').pop()
          },
          rollingSummarization: {
            model_name: models.rollingSummarizer,
            identifier: models.rollingSummarizer.split('/').pop()
          },
          main: {
            model_name: models.main,
            identifier: models.main.split('/').pop()
          }
        }
      };
      mutation.mutate(config);
    }
  };

  // Maintenance functions
  const openConfirm = (config: ConfirmConfig) => setConfirmConfig(config);
  const closeConfirm = () => {
    if (confirmLoading) return;
    setConfirmConfig(null);
  };

  const runConfirm = async () => {
    if (!confirmConfig) return;
    setConfirmLoading(true);
    try {
      await confirmConfig.onConfirm();
      setConfirmConfig(null);
    } catch (error) {
      console.error(error);
    } finally {
      setConfirmLoading(false);
    }
  };

  const applyKeepRecent = async () => {
    const normalized = Math.max(0, Math.min(10, Number(draftKeepRecent) || 0));
    setDraftKeepRecent(normalized);
    const lowering = normalized < keepRecentConfigured;
    try {
      await updateKeepMutation.mutateAsync(normalized);
      if (lowering) {
        openConfirm({
          title: "Reprocess summaries now?",
          description: "You lowered the raw turn window. Reprocessing keeps summaries aligned with the new window.",
          onConfirm: () => reprocessMutation.mutateAsync(),
        });
      }
    } catch {
      // handled by mutation
    }
  };

  return (
    <div className="space-y-6">
      {/* Bootstrap Loading Overlay */}
      {isBootstrapping && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-white/20 rounded-2xl p-8 max-w-md text-center">
            <Loader2 className="h-12 w-12 animate-spin text-cyan-400 mx-auto" />
            <h3 className="mt-4 text-xl font-semibold text-white">Analyzing Models</h3>
            <p className="mt-2 text-sm text-white/70">{bootstrapMessage}</p>
            <div className="mt-4 w-full bg-white/10 rounded-full h-2">
              <div 
                className="bg-cyan-400 h-2 rounded-full transition-all duration-300"
                style={{ width: `${bootstrapProgress}%` }}
              />
            </div>
            <p className="mt-2 text-xs text-white/50">{bootstrapProgress}% complete</p>
          </div>
        </div>
      )}

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
          {/* Quality Presets */}
          <Card title="Quality Presets" subtitle="Select a preset to automatically configure optimal models">
            {presetsLoading ? (
              <div className="text-center py-8 text-white/60">Loading presets...</div>
            ) : (
              <div className="grid gap-4 md:grid-cols-3">
                {(Object.entries(presets) as [string, QualityPreset][]).map(([key, preset]) => (
                  <div
                    key={key}
                    className={`p-4 border rounded-lg cursor-pointer transition-all ${
                      quality === key
                        ? 'border-cyan-400 bg-cyan-400/10 shadow-[0_0_20px_rgba(44,212,250,0.1)]'
                        : 'border-white/15 bg-white/5 hover:border-white/30'
                    }`}
                    onClick={() => setQuality(key as "high" | "medium" | "low")}
                  >
                    <h3 className="font-semibold text-white mb-1">{preset.name}</h3>
                    <p className="text-sm text-white/70">{preset.description}</p>
                    <div className="mt-2 text-xs text-white/50">
                      {preset.mainOptions?.length || 0} main models available
                    </div>
                    {quality === key && (
                      <div className="mt-2 text-xs text-cyan-400 font-semibold">✓ Selected</div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Card>

          {/* Model Configuration */}
          <Card title="Model Configuration" subtitle="Auto-configured based on selected preset">
            <div className="space-y-6">
              {/* All 4 models in a grid */}
              <div className="grid gap-4 md:grid-cols-2">
                {/* Embedding Model */}
                <div className="p-4 bg-white/5 border border-white/10 rounded-lg">
                  <div className="flex items-center gap-2 mb-2">
                    <Cpu className="h-4 w-4 text-cyan-400" />
                    <label className="text-sm font-semibold text-white">Embedding</label>
                    <span className="text-xs px-2 py-0.5 bg-cyan-500/20 text-cyan-400 rounded">CPU</span>
                  </div>
                  <div className="text-sm text-white/80">{getModelDisplayName(presets[quality]?.embedding || 'Not set')}</div>
                  <p className="text-xs text-white/50 mt-1">Vector search embeddings</p>
                </div>

                {/* RAG Summarizer */}
                <div className="p-4 bg-white/5 border border-white/10 rounded-lg">
                  <div className="flex items-center gap-2 mb-2">
                    <Zap className="h-4 w-4 text-amber-400" />
                    <label className="text-sm font-semibold text-white">RAG Summarizer</label>
                    <span className="text-xs px-2 py-0.5 bg-amber-500/20 text-amber-400 rounded">Auto</span>
                  </div>
                  <div className="text-sm text-white/80">{getModelDisplayName(presets[quality]?.ragSummarizer || 'Not set')}</div>
                  <p className="text-xs text-white/50 mt-1">Code chunk summaries</p>
                </div>

                {/* Rolling Summarizer */}
                <div className="p-4 bg-white/5 border border-white/10 rounded-lg">
                  <div className="flex items-center gap-2 mb-2">
                    <Zap className="h-4 w-4 text-purple-400" />
                    <label className="text-sm font-semibold text-white">Rolling Summarizer</label>
                    <span className="text-xs px-2 py-0.5 bg-purple-500/20 text-purple-400 rounded">Auto</span>
                  </div>
                  <div className="text-sm text-white/80">{getModelDisplayName(presets[quality]?.rollingSummarizer || 'Not set')}</div>
                  <p className="text-xs text-white/50 mt-1">Conversation memory</p>
                </div>

                {/* Main Model - Active indicator */}
                <div className="p-4 bg-gradient-to-r from-cyan-500/10 to-green-500/10 border border-cyan-500/30 rounded-lg">
                  <div className="flex items-center gap-2 mb-2">
                    <HardDrive className="h-4 w-4 text-green-400" />
                    <label className="text-sm font-semibold text-white">Main Model</label>
                    <span className="text-xs px-2 py-0.5 bg-green-500/20 text-green-400 rounded">Active</span>
                  </div>
                  <div className="text-sm text-white font-medium">{getModelDisplayName(models.main || 'Not selected')}</div>
                  <p className="text-xs text-white/50 mt-1">Chat completions</p>
                </div>
              </div>

              {/* Main model selector (user choice) */}
              <div className="p-4 bg-gradient-to-r from-cyan-500/10 to-purple-500/10 border border-cyan-500/20 rounded-lg">
                <div className="flex items-center gap-2 mb-3">
                  <HardDrive className="h-4 w-4 text-cyan-400" />
                  <label className="text-sm font-semibold text-white">Main Chat Model</label>
                  <span className="text-xs px-2 py-0.5 bg-purple-500/20 text-purple-400 rounded">Your Choice</span>
                </div>
                
                {/* Model list with availability */}
                <div className="space-y-2">
                  {(presets[quality]?.mainOptions || []).map((modelId: string) => {
                    const available = isModelAvailable(modelId);
                    const downloading = isModelDownloading(modelId);
                    const isSelected = models.main === modelId;
                    
                    return (
                      <div
                        key={modelId}
                        className={`flex items-center justify-between p-3 rounded-lg border transition-all ${
                          isSelected
                            ? 'border-cyan-400 bg-cyan-400/20'
                            : available
                            ? 'border-white/20 bg-white/5 hover:bg-white/10 cursor-pointer'
                            : 'border-white/10 bg-white/5'
                        }`}
                        onClick={() => available && handleMainModelChange(modelId)}
                      >
                        <div className="flex items-center gap-3">
                          {/* Status indicator */}
                          {available ? (
                            <Check className="h-4 w-4 text-green-400 flex-shrink-0" />
                          ) : downloading ? (
                            <Loader2 className="h-4 w-4 text-yellow-400 animate-spin flex-shrink-0" />
                          ) : (
                            <Download className="h-4 w-4 text-white/40 flex-shrink-0" />
                          )}
                          
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
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDownloadModel(modelId);
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
                    );
                  })}
                </div>
                
                <p className="text-xs text-white/50 mt-3">
                  {(presets[quality]?.mainOptions || []).filter((id: string) => isModelAvailable(id)).length} of{' '}
                  {presets[quality]?.mainOptions?.length || 0} models available for {presets[quality]?.name || quality} tier
                </p>
                {models.main && (
                  <div className="mt-2 text-xs text-green-400">
                    ✓ Active: {getModelDisplayName(models.main)}
                  </div>
                )}
              </div>

              {/* Why these models? */}
              <details className="group">
                <summary className="cursor-pointer text-sm text-white/70 hover:text-white flex items-center gap-2">
                  <ChevronDown className="h-4 w-4 group-open:hidden" />
                  <ChevronUp className="h-4 w-4 hidden group-open:block" />
                  Why these models?
                </summary>
                <div className="mt-3 p-4 bg-white/5 rounded-lg text-sm text-white/70 space-y-2">
                  <p><strong>Embedding:</strong> Runs on CPU via Xenova transformers (no GPU needed). Same for all presets.</p>
                  <p><strong>Summarizer:</strong> Balances speed and quality for chunk/conversation summaries.</p>
                  <p><strong>Main:</strong> Your chat model. Pick based on your VRAM and quality needs.</p>
                </div>
              </details>
            </div>
          </Card>

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
                onClick={() => bootstrapMutation.mutate()}
                disabled={isBootstrapping || bootstrapMutation.isPending}
                className="text-xs"
              >
                {isBootstrapping ? (
                  <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                ) : (
                  <Zap className="h-3 w-3 mr-1" />
                )}
                Re-analyze Models
              </Button>
            </div>
            {showModelDiscovery && <SuggestedModelsPanel />}
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
                Your local models (summarizers and main chat) will still run through LM Studio.
              </p>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-semibold text-white mb-2">Google AI Studio API Key</label>
                <input
                  type="password"
                  value={cloudSettings.googleStudioKey}
                  onChange={(e) => setCloudSettings({...cloudSettings, googleStudioKey: e.target.value})}
                  className="w-full rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-sm text-white focus:border-cyan-400 focus:outline-none"
                  placeholder="Enter your Google AI Studio API key"
                />
                <p className="text-xs text-white/50 mt-1">Get this from <a href="https://aistudio.google.com/app/apikey" className="text-cyan-400 hover:underline" target="_blank" rel="noopener noreferrer">Google AI Studio</a></p>
              </div>

              <div>
                <label className="block text-sm font-semibold text-white mb-2">Qdrant URL</label>
                <input
                  type="text"
                  value={cloudSettings.qdrantUrl}
                  onChange={(e) => setCloudSettings({...cloudSettings, qdrantUrl: e.target.value})}
                  className="w-full rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-sm text-white focus:border-cyan-400 focus:outline-none"
                  placeholder="https://your-instance.cloud.qdrant.io"
                />
                <p className="text-xs text-white/50 mt-1">Your Qdrant cluster URL</p>
              </div>

              <div>
                <label className="block text-sm font-semibold text-white mb-2">Qdrant API Key</label>
                <input
                  type="password"
                  value={cloudSettings.qdrantApiKey}
                  onChange={(e) => setCloudSettings({...cloudSettings, qdrantApiKey: e.target.value})}
                  className="w-full rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-sm text-white focus:border-cyan-400 focus:outline-none"
                  placeholder="Enter your Qdrant API key"
                />
                <p className="text-xs text-white/50 mt-1">API key for your Qdrant instance</p>
              </div>
            </div>

            {/* Local models for cloud mode */}
            <div className="border-t border-white/10 pt-6">
              <h4 className="font-semibold text-white mb-4">Local Models (still needed)</h4>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <label className="block text-sm font-semibold text-white">RAG Summarizer</label>
                  <div className="w-full rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-sm text-white/70">
                    {getModelDisplayName(presets[quality]?.ragSummarizer || 'Select a quality preset')}
                  </div>
                  <p className="text-xs text-white/50">Code chunk summaries</p>
                </div>

                <div className="space-y-2">
                  <label className="block text-sm font-semibold text-white">Rolling Summarizer</label>
                  <div className="w-full rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-sm text-white/70">
                    {getModelDisplayName(presets[quality]?.rollingSummarizer || 'Select a quality preset')}
                  </div>
                  <p className="text-xs text-white/50">Conversation memory</p>
                </div>

                <div className="space-y-2 md:col-span-2">
                  <label className="block text-sm font-semibold text-white">Main Chat Model</label>
                  <select
                    value={models.main}
                    onChange={(e) => handleMainModelChange(e.target.value)}
                    className="w-full rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-sm text-white focus:border-cyan-400 focus:outline-none"
                  >
                    <option value="">Select a model...</option>
                    {(presets[quality]?.mainOptions || []).map((modelId: string) => (
                      <option key={modelId} value={modelId}>
                        {getModelDisplayName(modelId)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          </div>
        </Card>
      )}

      {/* Maintenance Section */}
      <Card title="Compression Control" subtitle="Rolling summary settings">
        <div className="space-y-4">
          <p className="text-sm text-white/70">Keep a slice of the latest turns uncompressed before building summaries.</p>
          <div className="flex flex-wrap items-center gap-4">
            <label className="text-xs uppercase tracking-[0.3em] text-white/50" htmlFor="keep-recent-input">
              Uncompressed turns
            </label>
            <input
              id="keep-recent-input"
              type="number"
              min={0}
              max={10}
              value={draftKeepRecent}
              onChange={(e) => setDraftKeepRecent(Number(e.target.value) || 0)}
              className="w-24 rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-sm text-white focus:border-cyan-400 focus:outline-none"
            />
            <Button variant="secondary" onClick={applyKeepRecent} loading={updateKeepMutation.isPending}>
              Apply
            </Button>
          </div>
          <p className="text-xs text-white/60">
            Currently keeping <span className="font-semibold text-white">{keepRecentConfigured}</span> turn
            {keepRecentConfigured === 1 ? "" : "s"} raw.
          </p>
        </div>
      </Card>

      <Card title="Maintenance Actions" subtitle="Emergency operations">
        <p className="text-sm text-white/70 mb-4">Force a refresh of rolling summaries or wipe caches entirely.</p>
        <div className="flex flex-col gap-3">
          <Button
            variant="ghost"
            onClick={() =>
              openConfirm({
                title: "Reprocess all summaries?",
                description: "Re-run the summarizer across every session to keep rolling memory aligned.",
                onConfirm: () => reprocessMutation.mutateAsync(),
              })
            }
            loading={reprocessMutation.isPending}
            disabled={sessions.length === 0}
          >
            Reprocess summaries
          </Button>
          <Button
            variant="danger"
            onClick={() =>
              openConfirm({
                title: "Delete every session + cache?",
                description: "This clears SQLite, FAISS, and schedules a reindex. This cannot be undone.",
                tone: "danger",
                confirmLabel: "Delete everything",
                onConfirm: () => deleteAllMutation.mutateAsync(),
              })
            }
            loading={deleteAllMutation.isPending}
            disabled={sessions.length === 0}
          >
            Delete all sessions
          </Button>
          <Button
            variant="danger"
            onClick={() =>
              openConfirm({
                title: "Delete ALL stored data?",
                description: "This completely wipes all data including vector indexes, summaries, sessions, and triggers a full system reset. This cannot be undone and will require a server restart.",
                tone: "danger",
                confirmLabel: "Delete all data",
                onConfirm: () => deleteAllDataMutation.mutateAsync(),
              })
            }
            loading={deleteAllDataMutation.isPending}
          >
            Delete all data
          </Button>
        </div>
        <p className="mt-3 text-xs text-white/60">
          Sessions present: {sessions.length}. Deleting clears SQLite, FAISS, and triggers a full reindex.
        </p>
      </Card>

      {/* LM Studio Server Management */}
      <Card title="LM Studio Server Management" subtitle="Monitor and control LM Studio server • Ctrl+R to refresh status">
        <div className="space-y-4">
          <div className="flex justify-between items-start">
            <p className="text-sm text-white/70">
              LM Studio server status and controls. The system automatically attempts to start LM Studio when needed.
            </p>
            <div className="text-xs text-white/50 bg-white/5 px-2 py-1 rounded">
              <div className="font-semibold mb-1">Keyboard Shortcuts:</div>
              <div>Ctrl+R: Refresh status</div>
              <div>Ctrl+S: Save config</div>
            </div>
          </div>

          {/* Server Status Indicator */}
          <div className={`relative p-4 rounded-lg border transition-all overflow-hidden ${
            lmStudioHealth.ready
              ? 'border-green-500/30 bg-green-500/10 shadow-[0_0_20px_rgba(34,197,94,0.1)]'
              : lmStudioHealth.error
              ? 'border-red-500/30 bg-red-500/10'
              : 'border-yellow-500/30 bg-yellow-500/10'
          }`}>
            {/* Loading overlay */}
            {(autoStarting || startServerMutation.isPending || stopServerMutation.isPending) && (
              <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                <div className="flex items-center gap-3 text-white">
                  <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  <span className="text-sm font-medium">
                    {autoStarting ? 'Auto-starting LM Studio...' :
                     startServerMutation.isPending ? 'Starting LM Studio server...' :
                     'Stopping LM Studio server...'}
                  </span>
                </div>
              </div>
            )}

            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className={`w-3 h-3 rounded-full transition-colors ${
                  lmStudioHealth.ready ? 'bg-green-400 shadow-[0_0_10px_rgba(34,197,94,0.5)]' :
                  autoStarting || startServerMutation.isPending ? 'bg-yellow-400 animate-pulse' :
                  healthCheckMutation.isPending ? 'bg-blue-400 animate-pulse' :
                  lmStudioHealth.error ? 'bg-red-400' :
                  'bg-gray-400'
                }`} />
                <div>
                  <div className="text-sm font-medium text-white">
                    {lmStudioHealth.ready ? '🟢 Server Running' :
                     autoStarting ? '🟡 Auto-starting...' :
                     startServerMutation.isPending ? '🟡 Starting server...' :
                     stopServerMutation.isPending ? '🟡 Stopping server...' :
                     healthCheckMutation.isPending ? '🔵 Checking...' :
                     lmStudioHealth.error ? '🔴 Connection Failed' :
                     '⚪ Unknown Status'}
                  </div>
                  {lmStudioHealth.models_loaded !== undefined && lmStudioHealth.ready && (
                    <div className="text-xs text-white/70">
                      {lmStudioHealth.models_loaded} model{ lmStudioHealth.models_loaded !== 1 ? 's' : ''} loaded
                    </div>
                  )}
                  {lmStudioHealth.lastChecked && (
                    <div className="text-xs text-white/50">
                      Updated {new Date(lmStudioHealth.lastChecked).toLocaleTimeString()}
                    </div>
                  )}
                  {lmStudioHealth.error && (
                    <div className="text-xs text-red-400 mt-1 max-w-md">
                      {lmStudioHealth.error}
                    </div>
                  )}
                </div>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  onClick={() => healthCheckMutation.mutate()}
                  loading={healthCheckMutation.isPending}
                  disabled={autoStarting}
                >
                  Refresh
                </Button>
                {!lmStudioHealth.ready && !autoStarting && (
                  <Button
                    variant="primary"
                    onClick={() => startServerMutation.mutate()}
                    loading={startServerMutation.isPending}
                  >
                    Start Server
                  </Button>
                )}
                {lmStudioHealth.ready && (
                  <Button
                    variant="danger"
                    onClick={() => {
                      openConfirm({
                        title: "Stop LM Studio Server?",
                        description: "This will stop the LM Studio server. Models will be unloaded and API calls will fail until restarted.",
                        confirmLabel: "Stop Server",
                        onConfirm: () => stopServerMutation.mutate(),
                      });
                    }}
                    loading={stopServerMutation.isPending}
                  >
                    Stop Server
                  </Button>
                )}
              </div>
            </div>
          </div>

          {/* Model Management */}
          <div className="border-t border-white/10 pt-4">
            <h4 className="text-sm font-semibold text-white mb-3">Model Management</h4>
            <div className="flex flex-wrap gap-3">
              <Button
                onClick={() => listModelsMutation.mutate()}
                loading={listModelsMutation.isPending}
                variant="secondary"
                disabled={!lmStudioHealth.ready}
              >
                List Loaded Models
              </Button>
              <Button
                onClick={() => loadModelsMutation.mutate()}
                loading={loadModelsMutation.isPending}
                variant="primary"
                disabled={!lmStudioHealth.ready}
              >
                Load Required Models
              </Button>
              <Button
                onClick={() => refreshContextMutation.mutate()}
                loading={refreshContextMutation.isPending}
                variant="secondary"
                disabled={!lmStudioHealth.ready}
              >
                Refresh Context Limits
              </Button>
            </div>

          {loadedModels.length > 0 && (
            <div className="space-y-3">
              <h4 className="text-sm font-semibold text-white">Loaded Models ({loadedModels.length})</h4>
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {loadedModels.map((model) => (
                  <div key={model.id} className="flex items-center justify-between p-3 bg-white/5 rounded-lg">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-white truncate">{model.id}</div>
                      <div className="text-xs text-white/60">
                        Size: {model.size || 'Unknown'} • Context: {model.context_length || 'Unknown'}
                      </div>
                    </div>
                    <Button
                      variant="danger"
                      onClick={() => {
                        openConfirm({
                          title: `Unload Model: ${model.id}?`,
                          description: `This will unload the model "${model.id}" from LM Studio memory.`,
                          confirmLabel: "Unload",
                          onConfirm: () => unloadModelMutation.mutate(model.id),
                        });
                      }}
                      loading={unloadModelMutation.isPending}
                    >
                      Unload
                    </Button>
                  </div>
                ))}
              </div>

              <Button
                onClick={() => {
                  openConfirm({
                    title: "Unload ALL Models?",
                    description: "This will unload ALL currently loaded models from LM Studio memory.",
                    tone: "danger",
                    confirmLabel: "Unload All",
                    onConfirm: () => unloadAllModelsMutation.mutate(),
                  });
                }}
                loading={unloadAllModelsMutation.isPending}
                variant="danger"
                className="w-full"
              >
                Unload All Models
              </Button>
            </div>
          )}

          </div>
        </div>
      </Card>

      <div className="flex flex-col gap-4">
        <div className="flex justify-end">
          <Button onClick={handleSave} loading={mutation.isPending} className="px-8">
            Save Configuration
          </Button>
        </div>
        {message && (
          <div className={`p-4 rounded-lg border ${
            message.startsWith('✅') ? 'border-green-500/30 bg-green-500/10 text-green-400' :
            message.startsWith('❌') ? 'border-red-500/30 bg-red-500/10 text-red-400' :
            'border-blue-500/30 bg-blue-500/10 text-blue-400'
          }`}>
            {message}
          </div>
        )}
      </div>

      <ConfirmModal
        open={Boolean(confirmConfig)}
        title={confirmConfig?.title ?? ""}
        description={confirmConfig?.description}
        confirmLabel={confirmConfig?.confirmLabel}
        tone={confirmConfig?.tone}
        loading={confirmLoading}
        onConfirm={runConfirm}
        onCancel={closeConfirm}
      />

      {/* LM Studio Error Modal */}
      {lmStudioError && (
        <ConfirmModal
          open={true}
          title={lmStudioError.title}
          description={
            <div className="space-y-2">
              <p>{lmStudioError.description}</p>
              {lmStudioError.action && (
                <p className="text-sm text-blue-400">{lmStudioError.action}</p>
              )}
            </div>
          }
          confirmLabel={lmStudioError.retryable ? "Retry" : "OK"}
          cancelLabel={lmStudioError.retryable ? "Dismiss" : undefined}
          tone="default"
          onConfirm={() => {
            if (lmStudioError.retryable) {
              setLMStudioError(null);
              healthCheckMutation.mutate();
            } else {
              setLMStudioError(null);
            }
          }}
          onCancel={lmStudioError.retryable 
            ? () => { setLMStudioError(null); setErrorDismissed(true); } 
            : () => setLMStudioError(null)}
        />
      )}
    </div>
  );
}