import { useState, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";

import {
  detectHardware,
  getModelLocks,
  toggleModelLock,
  getPresets,
  optimizePreset,
  saveCustomPreset,
  type ModelLock,
  type CustomPresetConfig,
} from "../../lib/api";
import { VRAMProgressBar } from "../ui/VRAMProgressBar";
import { StarRating, getStarRatingFromSize } from "../ui/StarRating";
import { LockButton } from "../ui/LockButton";
import { Badge } from "../ui/Badge";
import { ModelSearch } from "../ui/ModelSearch";

// Role descriptions for the UI
const ROLE_INFO = {
  main: {
    name: "Main Model",
    description: "Handles chat completions and tool calling. This is the primary AI that responds to your queries.",
    recommended: "Models with tool use capability (Qwen, Llama, etc.)",
    icon: "🤖",
  },
  summarizer: {
    name: "Summarizer",
    description: "Compresses conversation history to maintain context without exceeding token limits.",
    recommended: "Smaller, fast models (1-3B params)",
    icon: "📝",
  },
  embedder: {
    name: "Embedder",
    description: "Creates vector embeddings for semantic search in RAG (Retrieval-Augmented Generation).",
    recommended: "Embedding models (MiniLM, Nomic)",
    icon: "🔍",
  },
};

interface ModelOption {
  id: string;
  name: string;
  sizeGB?: number;
  trainedForToolUse?: boolean;
  maxContextLength?: number;
  type?: string;
}

interface CustomPresetPanelProps {
  availableModels: ModelOption[];
  onConfigChange?: (config: CustomPresetConfig) => void;
  onModelDownloaded?: () => void;
}

export function CustomPresetPanel({
  availableModels,
  onConfigChange,
  onModelDownloaded,
}: CustomPresetPanelProps) {
  const queryClient = useQueryClient();
  
  // Show/hide model search
  const [showModelSearch, setShowModelSearch] = useState(false);

  // Local state for selections
  const [config, setConfig] = useState<CustomPresetConfig>({
    main: null,
    summarizer: null,
    embedder: null,
  });

  // Hardware detection
  const { data: hardwareData } = useQuery({
    queryKey: ["hardware"],
    queryFn: () => detectHardware(),
    staleTime: 60000, // Cache for 1 minute
  });

  // Model locks
  const { data: locksData, refetch: refetchLocks } = useQuery({
    queryKey: ["modelLocks"],
    queryFn: getModelLocks,
  });

  // Get presets to populate initial selections
  const { data: presetsData } = useQuery({
    queryKey: ["presets"],
    queryFn: getPresets,
  });

  // Toggle lock mutation
  const lockMutation = useMutation({
    mutationFn: ({ modelId }: { modelId: string }) => toggleModelLock(modelId, "both"),
    onSuccess: () => {
      refetchLocks();
    },
  });

  // Optimize mutation
  const optimizeMutation = useMutation({
    mutationFn: optimizePreset,
    onSuccess: (data) => {
      if (data.recommendation) {
        setConfig({
          main: data.recommendation.main,
          summarizer: data.recommendation.summarizer,
          embedder: data.recommendation.embedder,
        });
      }
    },
  });

  // Save mutation
  const saveMutation = useMutation({
    mutationFn: saveCustomPreset,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["presets"] });
    },
  });

  // Initialize with defaults from presets
  useEffect(() => {
    if (presetsData?.presets?.low) {
      const lowPreset = presetsData.presets.low;
      setConfig({
        main: lowPreset.mainOptions?.[0] || null,
        summarizer: lowPreset.rollingSummarizer || null,
        embedder: lowPreset.embedding || null,
      });
    }
  }, [presetsData]);

  // Notify parent of config changes
  useEffect(() => {
    onConfigChange?.(config);
  }, [config, onConfigChange]);

  const hardware = hardwareData?.hardware;
  const locks = locksData?.locks || {};

  // Calculate VRAM usage
  const getModelSize = (modelId: string | null): number => {
    if (!modelId) return 0;
    const model = availableModels.find((m) => m.id === modelId);
    return model?.sizeGB || 0;
  };

  const vramBreakdown = {
    main: getModelSize(config.main),
    summarizer: getModelSize(config.summarizer),
    embedder: getModelSize(config.embedder),
  };
  const totalVRAM = vramBreakdown.main + vramBreakdown.summarizer + vramBreakdown.embedder;

  // Filter models by role
  const mainModels = availableModels.filter(
    (m) => m.type !== "embedder" && m.type !== "embedding"
  );
  const summarizerModels = availableModels.filter(
    (m) => m.type !== "embedder" && m.type !== "embedding"
  );
  const embedderModels = availableModels.filter(
    (m) => m.type === "embedder" || m.type === "embedding"
  );

  const handleSave = () => {
    saveMutation.mutate(config);
  };

  return (
    <div className="space-y-6 p-4 bg-surface-panel rounded-xl border border-white/10">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-white">Custom Preset</h3>
          <p className="text-sm text-white/60">
            Configure models for each role manually
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => optimizeMutation.mutate()}
            disabled={optimizeMutation.isPending}
            className={clsx(
              "px-4 py-2 rounded-lg font-medium text-sm transition-all",
              "bg-accent-primary/20 text-accent-primary border border-accent-primary/40",
              "hover:bg-accent-primary/30",
              "disabled:opacity-50 disabled:cursor-not-allowed"
            )}
          >
            {optimizeMutation.isPending ? "Optimizing..." : "⚡ Optimize"}
          </button>
          <button
            onClick={handleSave}
            disabled={saveMutation.isPending}
            className={clsx(
              "px-4 py-2 rounded-lg font-medium text-sm transition-all",
              "bg-accent-success/20 text-accent-success border border-accent-success/40",
              "hover:bg-accent-success/30",
              "disabled:opacity-50 disabled:cursor-not-allowed"
            )}
          >
            {saveMutation.isPending ? "Saving..." : "Save"}
          </button>
        </div>
      </div>

      {/* Hardware Info */}
      {hardware && (
        <div className="p-3 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center justify-between text-sm">
            <span className="text-white/70">
              Detected: {hardware.gpu?.name || "No GPU"}
            </span>
            <span className="text-white/50">
              {hardware.gpu?.totalGB?.toFixed(1) || 0} GB VRAM
            </span>
          </div>
        </div>
      )}

      {/* VRAM Progress Bar */}
      <VRAMProgressBar
        usedGB={totalVRAM}
        totalGB={hardware?.gpu?.totalGB || 8}
        breakdown={vramBreakdown}
        showLabels
        showBreakdown
      />

      {/* Role Selectors */}
      <div className="space-y-4">
        <RoleSelector
          role="main"
          info={ROLE_INFO.main}
          value={config.main}
          options={mainModels}
          locks={locks}
          onSelect={(id) => setConfig((c) => ({ ...c, main: id }))}
          onToggleLock={(id) => lockMutation.mutate({ modelId: id })}
        />

        <RoleSelector
          role="summarizer"
          info={ROLE_INFO.summarizer}
          value={config.summarizer}
          options={summarizerModels}
          locks={locks}
          onSelect={(id) => setConfig((c) => ({ ...c, summarizer: id }))}
          onToggleLock={(id) => lockMutation.mutate({ modelId: id })}
        />

        <RoleSelector
          role="embedder"
          info={ROLE_INFO.embedder}
          value={config.embedder}
          options={embedderModels}
          locks={locks}
          onSelect={(id) => setConfig((c) => ({ ...c, embedder: id }))}
          onToggleLock={(id) => lockMutation.mutate({ modelId: id })}
        />
      </div>

      {/* Optimization result message */}
      {optimizeMutation.isSuccess && optimizeMutation.data?.recommendation && (
        <div className="p-3 rounded-lg bg-accent-success/10 border border-accent-success/30">
          <p className="text-sm text-accent-success">
            {optimizeMutation.data.recommendation.reasoning}
          </p>
        </div>
      )}

      {optimizeMutation.isError && (
        <div className="p-3 rounded-lg bg-accent-danger/10 border border-accent-danger/30">
          <p className="text-sm text-accent-danger">
            Optimization failed. Try again or select models manually.
          </p>
        </div>
      )}

      {/* Model Search Toggle */}
      <div className="pt-4 border-t border-white/10">
        <button
          onClick={() => setShowModelSearch(!showModelSearch)}
          className={clsx(
            "w-full px-4 py-2 rounded-lg font-medium text-sm transition-all",
            "bg-white/5 text-white/70 border border-white/20",
            "hover:bg-white/10 hover:text-white"
          )}
        >
          {showModelSearch ? "▼ Hide Model Search" : "► Search Hugging Face for More Models"}
        </button>
      </div>

      {/* Model Search Panel */}
      {showModelSearch && (
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <h4 className="text-sm font-medium text-white mb-3">
            Search Hugging Face
          </h4>
          <ModelSearch
            onModelDownloaded={() => {
              queryClient.invalidateQueries({ queryKey: ["presets"] });
              onModelDownloaded?.();
            }}
          />
        </div>
      )}
    </div>
  );
}

interface RoleSelectorProps {
  role: "main" | "summarizer" | "embedder";
  info: {
    name: string;
    description: string;
    recommended: string;
    icon: string;
  };
  value: string | null;
  options: ModelOption[];
  locks: Record<string, ModelLock>;
  onSelect: (id: string) => void;
  onToggleLock: (id: string) => void;
}

function RoleSelector({
  role: _role,
  info,
  value,
  options,
  locks,
  onSelect,
  onToggleLock,
}: RoleSelectorProps) {
  // _role is available for future use (e.g., role-specific styling)
  const selectedModel = options.find((m) => m.id === value);
  const { stars, label } = selectedModel?.sizeGB
    ? getStarRatingFromSize(selectedModel.sizeGB)
    : { stars: 0, label: "Unknown" };
  const isLocked = value ? !!locks[value]?.loaded || !!locks[value]?.preset : false;

  return (
    <div className="p-4 rounded-lg bg-white/5 border border-white/10 space-y-3">
      {/* Role Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2">
          <span className="text-2xl">{info.icon}</span>
          <div>
            <h4 className="font-medium text-white">{info.name}</h4>
            <p className="text-xs text-white/50">{info.description}</p>
          </div>
        </div>
        <StarRating stars={stars} label={label} showLabel size="sm" />
      </div>

      {/* Model Selector */}
      <div className="flex items-center gap-2">
        <select
          value={value || ""}
          onChange={(e) => onSelect(e.target.value)}
          className={clsx(
            "flex-1 px-3 py-2 rounded-lg text-sm",
            "bg-white/5 border border-white/20 text-white",
            "focus:outline-none focus:ring-2 focus:ring-accent-primary/50"
          )}
        >
          <option value="" disabled>
            Select a model...
          </option>
          {options.map((model) => (
            <option key={model.id} value={model.id}>
              {model.name || model.id}
              {model.sizeGB ? ` (${model.sizeGB.toFixed(1)}GB)` : ""}
            </option>
          ))}
        </select>

        {value && (
          <LockButton
            locked={isLocked}
            onToggle={() => onToggleLock(value)}
            size="md"
            tooltip={isLocked ? "Model is locked (won't be unloaded or replaced)" : "Lock this model"}
          />
        )}
      </div>

      {/* Model Details */}
      {selectedModel && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {selectedModel.trainedForToolUse && (
            <Badge tone="info">🔧 Tool Use</Badge>
          )}
          {selectedModel.maxContextLength && (
            <Badge tone="neutral">
              {(selectedModel.maxContextLength / 1000).toFixed(0)}K Context
            </Badge>
          )}
          {selectedModel.sizeGB && (
            <Badge tone="neutral">~{selectedModel.sizeGB.toFixed(1)} GB</Badge>
          )}
          {isLocked && <Badge tone="warn">🔒 Locked</Badge>}
        </div>
      )}

      {/* Recommended hint */}
      <p className="text-xs text-white/40">
        Recommended: {info.recommended}
      </p>
    </div>
  );
}

export default CustomPresetPanel;

