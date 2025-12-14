import { useState, useEffect } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { saveConfig, deleteAllSessions, reprocessSummaries, updateSummaryKeepRecent, triggerAction, listLoadedModels, unloadModel, unloadAllModels, refreshModelContext, checkLMStudioHealth, startLMStudioServer, stopLMStudioServer } from "../../lib/api";
import { useDashboardStore } from "../../state/dashboard-store";
import { Card } from "../ui/Card";
import { Button } from "../ui/Button";
import { ConfirmModal } from "../ui/ConfirmModal";

// Quality preset definitions
const QUALITY_PRESETS = {
  high: {
    name: "High Quality",
    description: "Best models for RTX 5080 - optimal performance and accuracy",
    models: {
      embedding: "jinaai/jina-embeddings-v2-base-code",
      ragSummarizer: "microsoft/Phi-3-mini-4k-instruct",
      rollingSummarizer: "Qwen/Qwen2.5-1.5B-Instruct",
      main: ""
    }
  },
  medium: {
    name: "Balanced",
    description: "Good performance on RTX 3060+ with reasonable speed",
    models: {
      embedding: "sentence-transformers/all-MiniLM-L12-v2",
      ragSummarizer: "microsoft/Phi-2",
      rollingSummarizer: "Qwen/Qwen2.5-1.5B-Instruct",
      main: ""
    }
  },
  low: {
    name: "Fast & Lightweight",
    description: "Works on any modern GPU with minimal resources",
    models: {
      embedding: "Xenova/all-MiniLM-L6-v2",
      ragSummarizer: "microsoft/Phi-2",
      rollingSummarizer: "Qwen/Qwen2.5-1.5B-Instruct",
      main: ""
    }
  }
};

const AVAILABLE_MODELS = {
  embedding: [
    { value: "jinaai/jina-embeddings-v2-base-code", label: "Jina Embeddings v2 Base Code (High Quality)" },
    { value: "sentence-transformers/all-MiniLM-L12-v2", label: "MiniLM L12 (Balanced)" },
    { value: "Xenova/all-MiniLM-L6-v2", label: "MiniLM L6 (Fast)" },
    { value: "nomic-ai/nomic-embed-text-v1.5", label: "Nomic Embed v1.5 (High Quality)" }
  ],
  ragSummarizer: [
    { value: "microsoft/Phi-3-mini-4k-instruct", label: "Phi-3 Mini 4K (High Quality)" },
    { value: "microsoft/Phi-2", label: "Phi-2 (Balanced)" },
    { value: "Qwen/Qwen2.5-1.5B-Instruct", label: "Qwen 2.5 1.5B (Fast)" }
  ],
  rollingSummarizer: [
    { value: "Qwen/Qwen2.5-1.5B-Instruct", label: "Qwen 2.5 1.5B (Recommended - Fast)" },
    { value: "microsoft/Phi-2", label: "Phi-2 (Balanced)" },
    { value: "microsoft/Phi-3-mini-4k-instruct", label: "Phi-3 Mini (High Quality)" }
  ]
};

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

  const [mode, setMode] = useState<"local" | "cloud">("local");
  const [quality, setQuality] = useState<"high" | "medium" | "low">("high");
  const [models, setModels] = useState<ModelSelection>({
    embedding: QUALITY_PRESETS.high.models.embedding,
    ragSummarizer: QUALITY_PRESETS.high.models.ragSummarizer,
    rollingSummarizer: QUALITY_PRESETS.high.models.rollingSummarizer,
    main: QUALITY_PRESETS.high.models.main
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

  // Update models when quality changes
  useEffect(() => {
    const preset = QUALITY_PRESETS[quality];
    setModels({
      embedding: preset.models.embedding,
      ragSummarizer: preset.models.ragSummarizer,
      rollingSummarizer: preset.models.rollingSummarizer,
      main: models.main // Keep user-defined main model
    });
  }, [quality]);

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
      if (config.models?.summarization?.model_name) {
        setModels(prev => ({ ...prev, rollingSummarizer: config.models.summarization.model_name }));
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
          // Wait a bit for server to fully start
          setTimeout(() => {
            if (mounted) checkHealth();
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
    if (!lmStudioHealth.ready && lmStudioHealth.error && !lmStudioError) {
      setLMStudioError({
        title: "LM Studio Connection Issue",
        description: `Cannot connect to LM Studio: ${lmStudioHealth.error}`,
        action: "Ensure LM Studio is installed and running",
        retryable: true
      });
    } else if (lmStudioHealth.ready && lmStudioError) {
      // Clear error when connection is restored
      setLMStudioError(null);
    }
  }, [lmStudioHealth.ready, lmStudioHealth.error, lmStudioError]);

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
          summarization: {
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
          summarization: {
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

  const handleModelChange = (modelType: keyof ModelSelection, value: string) => {
    setModels(prev => ({ ...prev, [modelType]: value }));
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
            <div className="grid gap-4 md:grid-cols-3">
              {Object.entries(QUALITY_PRESETS).map(([key, preset]) => (
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
                  {quality === key && (
                    <div className="mt-2 text-xs text-cyan-400 font-semibold">✓ Selected</div>
                  )}
                </div>
              ))}
            </div>
          </Card>

          {/* Model Dropdowns */}
          <Card title="Model Configuration" subtitle="Customize individual models (presets auto-fill these)">
            <div className="grid gap-6 md:grid-cols-2">
              <div className="space-y-2">
                <label className="block text-sm font-semibold text-white">Embedding Model (RAG)</label>
                <select
                  value={models.embedding}
                  onChange={(e) => handleModelChange("embedding", e.target.value)}
                  className="w-full rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-sm text-white focus:border-cyan-400 focus:outline-none"
                >
                  {AVAILABLE_MODELS.embedding.map(model => (
                    <option key={model.value} value={model.value}>
                      {model.label}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-white/50">Used for semantic search and code understanding</p>
              </div>

              <div className="space-y-2">
                <label className="block text-sm font-semibold text-white">RAG Summarizer</label>
                <select
                  value={models.ragSummarizer}
                  onChange={(e) => handleModelChange("ragSummarizer", e.target.value)}
                  className="w-full rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-sm text-white focus:border-cyan-400 focus:outline-none"
                >
                  {AVAILABLE_MODELS.ragSummarizer.map(model => (
                    <option key={model.value} value={model.value}>
                      {model.label}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-white/50">Summarizes code chunks during indexing (offline)</p>
              </div>

              <div className="space-y-2">
                <label className="block text-sm font-semibold text-white">Rolling Summarizer</label>
                <select
                  value={models.rollingSummarizer}
                  onChange={(e) => handleModelChange("rollingSummarizer", e.target.value)}
                  className="w-full rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-sm text-white focus:border-cyan-400 focus:outline-none"
                >
                  {AVAILABLE_MODELS.rollingSummarizer.map(model => (
                    <option key={model.value} value={model.value}>
                      {model.label}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-white/50">Maintains conversation memory (real-time)</p>
              </div>

              <div className="space-y-2">
                <label className="block text-sm font-semibold text-white">Main Chat Model</label>
                <input
                  type="text"
                  value={models.main}
                  onChange={(e) => handleModelChange("main", e.target.value)}
                  className="w-full rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-sm text-white focus:border-cyan-400 focus:outline-none"
                  placeholder="e.g., meta-llama/Llama-3.1-8B-Instruct"
                />
                <p className="text-xs text-white/50">Your primary conversational AI model</p>
              </div>
            </div>
          </Card>
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
                  <label className="block text-sm font-semibold text-white">Rolling Summarizer</label>
                  <select
                    value={models.rollingSummarizer}
                    onChange={(e) => handleModelChange("rollingSummarizer", e.target.value)}
                    className="w-full rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-sm text-white focus:border-cyan-400 focus:outline-none"
                  >
                    {AVAILABLE_MODELS.rollingSummarizer.map(model => (
                      <option key={model.value} value={model.value}>
                        {model.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-2">
                  <label className="block text-sm font-semibold text-white">Main Chat Model</label>
                  <input
                    type="text"
                    value={models.main}
                    onChange={(e) => handleModelChange("main", e.target.value)}
                    className="w-full rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-sm text-white focus:border-cyan-400 focus:outline-none"
                    placeholder="e.g., meta-llama/Llama-3.1-8B-Instruct"
                  />
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
          onCancel={lmStudioError.retryable ? () => setLMStudioError(null) : () => setLMStudioError(null)}
        />
      )}
    </div>
  );
}