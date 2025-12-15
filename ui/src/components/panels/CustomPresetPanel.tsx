import { useState, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";

import {
  detectHardware,
  getModelLocks,
  toggleModelLock,
  optimizePreset,
  saveCustomPreset,
  type ModelLock,
  type CustomPresetConfig,
} from "../../lib/api";
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
    selectable: true,
  },
  rollingSummarizer: {
    name: "Rolling Summarizer",
    description: "Compresses conversation history to maintain context across long sessions.",
    recommended: "Smaller, fast models (0.5-3B params)",
    icon: "📝",
    selectable: true,
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
  
  // RAG Pipeline tier (closed system)
  // Show/hide model search
  const [showModelSearch, setShowModelSearch] = useState(false);

  // Local state for user-selectable models only
  const [config, setConfig] = useState<CustomPresetConfig>({
    main: null,
    rollingSummarizer: null,
  });

  // Hardware detection
  const { data: hardwareData } = useQuery({
    queryKey: ["hardware"],
    queryFn: () => detectHardware(),
    staleTime: 60000,
  });

  // Model locks
  const { data: locksData, refetch: refetchLocks } = useQuery({
    queryKey: ["modelLocks"],
    queryFn: getModelLocks,
  });


  // Toggle lock mutation
  const lockMutation = useMutation({
    mutationFn: ({ modelId }: { modelId: string }) => toggleModelLock(modelId, "both"),
    onSuccess: () => {
      refetchLocks();
    },
  });

  // Optimize mutation (for main + rolling summarizer only)
  const optimizeMutation = useMutation({
    mutationFn: optimizePreset,
    onSuccess: (data) => {
      if (data.recommendation) {
        setConfig({
          main: data.recommendation.main,
          rollingSummarizer: data.recommendation.summarizer, // Map to rollingSummarizer
        });
      }
    },
  });

  // Save custom preset
  const saveMutation = useMutation({
    mutationFn: saveCustomPreset,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["presets"] });
    },
  });

  // Change RAG tier (triggers re-index)

  // Notify parent of config changes
  useEffect(() => {
    onConfigChange?.(config);
  }, [config, onConfigChange]);

  const hardware = hardwareData?.hardware;
  const locks = locksData?.locks || {};

  // Filter models
  const selectableModels = availableModels.filter(
    (m) => m.type !== "embedder" && m.type !== "embedding"
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
            Configure main model and conversation summarizer
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



      {/* =========================================== */}
      {/* USER-SELECTABLE MODELS */}
      {/* =========================================== */}
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <span className="text-lg">⚙️</span>
          <h4 className="font-medium text-white">User-Selectable Models</h4>
        </div>

        <RoleSelector
          role="main"
          info={ROLE_INFO.main}
          value={config.main}
          options={selectableModels}
          locks={locks}
          onSelect={(id) => setConfig((c) => ({ ...c, main: id }))}
          onToggleLock={(id) => lockMutation.mutate({ modelId: id })}
        />

        <RoleSelector
          role="rollingSummarizer"
          info={ROLE_INFO.rollingSummarizer}
          value={config.rollingSummarizer}
          options={selectableModels}
          locks={locks}
          onSelect={(id) => setConfig((c) => ({ ...c, rollingSummarizer: id }))}
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
  role: "main" | "rollingSummarizer";
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
            "bg-gray-800 border border-white/20 text-white",
            "focus:outline-none focus:ring-2 focus:ring-accent-primary/50",
            "[&>option]:bg-gray-800 [&>option]:text-white"
          )}
        >
          <option value="" disabled className="bg-gray-800 text-white/50">
            Select a model...
          </option>
          {options.map((model) => (
            <option key={model.id} value={model.id} className="bg-gray-800 text-white">
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
