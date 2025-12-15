import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import clsx from "clsx";

import {
  searchHuggingFace,
  downloadHFModel,
  getHFQuantizations,
  discoverLMStudioModels,
  downloadLMStudioModel,
  type HFModelResult,
  type HFQuantization,
  type LMStudioModel,
  type HFSearchResponse,
  type LMStudioDiscoverResponse,
} from "../../lib/api";
import { Badge } from "./Badge";

interface ModelSearchProps {
  role?: "main" | "summarizer" | "embedder";
  onModelDownloaded?: (modelKey: string) => void;
  className?: string;
}

type ModelSource = 'huggingface' | 'lmstudio';

export function ModelSearch({
  role,
  onModelDownloaded,
  className,
}: ModelSearchProps) {
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<ModelSource>('lmstudio'); // Default to LM Studio
  const [selectedHFModel, setSelectedHFModel] = useState<HFModelResult | null>(null);
  const [selectedLMModel, setSelectedLMModel] = useState<LMStudioModel | null>(null);
  const [selectedQuant, setSelectedQuant] = useState<string | null>(null);

  // Search mutation
  const searchMutation = useMutation({
    mutationFn: async (q: string) => {
      if (source === 'huggingface') {
        return await searchHuggingFace(q, { role, limit: 15 });
      } else {
        return await discoverLMStudioModels(q, 15);
      }
    },
    onSuccess: () => {
      setSelectedHFModel(null);
      setSelectedLMModel(null);
      setSelectedQuant(null);
    },
  });

  // Quantization query (only for HF models)
  const { data: quantsData, isLoading: quantsLoading } = useQuery({
    queryKey: ["hf-quants", selectedHFModel?.id],
    queryFn: () => getHFQuantizations(selectedHFModel!.id),
    enabled: !!selectedHFModel,
  });

  // Download mutation
  const downloadMutation = useMutation({
    mutationFn: async () => {
      if (source === 'huggingface') {
        return await downloadHFModel(selectedHFModel!.id, selectedQuant || undefined);
      } else {
        return await downloadLMStudioModel(selectedLMModel!.modelKey);
      }
    },
    onSuccess: (data: any) => {
      const success = data.success || data.status === 'ok';
      const modelKey = data.modelKey || data.model?.modelKey;

      if (success && modelKey) {
        onModelDownloaded?.(modelKey);
        setSelectedHFModel(null);
        setSelectedLMModel(null);
        setSelectedQuant(null);
        setQuery("");
      }
    },
  });

  const handleSearch = () => {
    if (query.trim()) {
      searchMutation.mutate(query.trim());
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleSearch();
    }
  };

  return (
    <div className={clsx("space-y-4", className)}>
      {/* Source Selector */}
      <div className="flex items-center gap-2">
        <label className="text-sm font-medium text-white/70">Source:</label>
        <select
          value={source}
          onChange={(e) => {
            setSource(e.target.value as ModelSource);
            setSelectedHFModel(null);
            setSelectedLMModel(null);
            setSelectedQuant(null);
          }}
          className="px-3 py-1 rounded bg-white/10 border border-white/20 text-white text-sm"
        >
          <option value="lmstudio">LM Studio Registry</option>
          <option value="huggingface">Hugging Face</option>
        </select>
      </div>

      {/* Search Input */}
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            source === 'lmstudio'
              ? "Search LM Studio registry..."
              : "Search Hugging Face for models..."
          }
          className={clsx(
            "flex-1 px-3 py-2 rounded-lg text-sm",
            "bg-white/5 border border-white/20 text-white placeholder:text-white/40",
            "focus:outline-none focus:ring-2 focus:ring-accent-primary/50"
          )}
        />
        <button
          onClick={handleSearch}
          disabled={searchMutation.isPending || !query.trim()}
          className={clsx(
            "px-4 py-2 rounded-lg font-medium text-sm transition-all",
            "bg-accent-primary/20 text-accent-primary border border-accent-primary/40",
            "hover:bg-accent-primary/30",
            "disabled:opacity-50 disabled:cursor-not-allowed"
          )}
        >
          {searchMutation.isPending ? "..." : "Search"}
        </button>
      </div>

      {/* Role hint */}
      {role && (
        <p className="text-xs text-white/50">
          Searching for {role} models
        </p>
      )}

      {/* Search Results */}
      {(() => {
        const hfData = searchMutation.data as HFSearchResponse | undefined;
        const lmData = searchMutation.data as LMStudioDiscoverResponse | undefined;

        const results = source === 'huggingface'
          ? hfData?.results
          : lmData?.models;

        return results && results.length > 0 && (
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {results.map((model: any) => (
              <ModelResultCard
                key={source === 'huggingface' ? model.id : model.modelKey}
                model={model}
                source={source}
                selected={
                  source === 'huggingface'
                    ? selectedHFModel?.id === model.id
                    : selectedLMModel?.modelKey === model.modelKey
                }
                onSelect={() => {
                  if (source === 'huggingface') {
                    setSelectedHFModel(model as HFModelResult);
                    setSelectedLMModel(null);
                  } else {
                    setSelectedLMModel(model as LMStudioModel);
                    setSelectedHFModel(null);
                  }
                  setSelectedQuant(null);
                }}
              />
            ))}
          </div>
        );
      })()}

      {/* No results */}
      {(() => {
        const hfData = searchMutation.data as HFSearchResponse | undefined;
        const lmData = searchMutation.data as LMStudioDiscoverResponse | undefined;

        const results = source === 'huggingface'
          ? hfData?.results
          : lmData?.models;
        return results?.length === 0 && (
          <p className="text-sm text-white/50 text-center py-4">
            No models found. Try a different search term.
          </p>
        );
      })()}

      {/* Selected Model - Quantization Selection */}
      {(selectedHFModel || selectedLMModel) && (
        <div className="p-4 rounded-lg bg-white/10 border border-white/20 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h4 className="font-medium text-white">
                {source === 'huggingface' ? selectedHFModel!.name : selectedLMModel!.displayName}
              </h4>
              <p className="text-xs text-white/50">
                {source === 'huggingface'
                  ? selectedHFModel!.author
                  : `${selectedLMModel!.badge} • ${selectedLMModel!.source}`
                }
              </p>
            </div>
            <button
              onClick={() => {
                setSelectedHFModel(null);
                setSelectedLMModel(null);
                setSelectedQuant(null);
              }}
              className="text-white/40 hover:text-white"
            >
              ✕
            </button>
          </div>

          {/* Quantization options (only for HF) */}
          {source === 'huggingface' && (
            <>
              {quantsLoading && (
                <p className="text-sm text-white/50">Loading quantization options...</p>
              )}

              {quantsData?.quantizations && quantsData.quantizations.length > 0 && (
                <div className="space-y-2">
                  <label className="text-xs text-white/60">Select Quantization:</label>
                  <div className="flex flex-wrap gap-2">
                    {quantsData.quantizations.map((quant) => (
                      <QuantButton
                        key={quant.filename}
                        quant={quant}
                        selected={selectedQuant === quant.quantization}
                        onSelect={() => setSelectedQuant(quant.quantization)}
                      />
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {/* Download button */}
          <button
            onClick={() => downloadMutation.mutate()}
            disabled={downloadMutation.isPending}
            className={clsx(
              "w-full px-4 py-2 rounded-lg font-medium text-sm transition-all",
              "bg-accent-success/20 text-accent-success border border-accent-success/40",
              "hover:bg-accent-success/30",
              "disabled:opacity-50 disabled:cursor-not-allowed"
            )}
          >
            {downloadMutation.isPending
              ? "Downloading..."
              : `Download ${selectedQuant || "Default"}`}
          </button>

          {/* Download error */}
          {downloadMutation.isError && (
            <p className="text-xs text-accent-danger">
              Download failed. Please try again.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

interface ModelResultCardProps {
  model: HFModelResult | LMStudioModel;
  source: ModelSource;
  selected: boolean;
  onSelect: () => void;
}

function ModelResultCard({ model, source, selected, onSelect }: ModelResultCardProps) {
  const isHF = source === 'huggingface';
  const hfModel = model as HFModelResult;
  const lmModel = model as LMStudioModel;

  return (
    <button
      onClick={onSelect}
      className={clsx(
        "w-full p-3 rounded-lg text-left transition-all",
        "border",
        selected
          ? "bg-accent-primary/10 border-accent-primary/40"
          : "bg-white/5 border-white/10 hover:bg-white/10"
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <h5 className="font-medium text-white truncate">
            {isHF ? hfModel.name : lmModel.displayName}
          </h5>
          <p className="text-xs text-white/50">
            {isHF ? hfModel.author : `${lmModel.badge} • ${lmModel.source}`}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1 text-xs">
          {isHF ? (
            <>
              <span className="text-white/40">↓ {formatNumber(hfModel.downloads)}</span>
              <span className="text-white/40">♥ {formatNumber(hfModel.likes)}</span>
            </>
          ) : (
            <>
              <span className="text-white/40">{lmModel.sizeGB ? `${lmModel.sizeGB}GB` : 'Unknown'}</span>
              <Badge tone="neutral" className="text-xs">
                {lmModel.badge}
              </Badge>
            </>
          )}
        </div>
      </div>
      
      {/* Tags */}
      <div className="flex flex-wrap gap-1 mt-2">
        {isHF && hfModel.isGGUF && <Badge tone="positive">GGUF</Badge>}
        {isHF && hfModel.pipeline_tag && (
          <Badge tone="neutral">{hfModel.pipeline_tag}</Badge>
        )}
        {!isHF && lmModel.function && (
          <Badge tone="neutral">{lmModel.function}</Badge>
        )}
      </div>
    </button>
  );
}

interface QuantButtonProps {
  quant: HFQuantization;
  selected: boolean;
  onSelect: () => void;
}

function QuantButton({ quant, selected, onSelect }: QuantButtonProps) {
  return (
    <button
      onClick={onSelect}
      className={clsx(
        "px-3 py-1.5 rounded-lg text-xs font-medium transition-all",
        "border",
        selected
          ? "bg-accent-primary/20 text-accent-primary border-accent-primary/40"
          : "bg-white/5 text-white/70 border-white/20 hover:bg-white/10"
      )}
    >
      {quant.quantization}
      {quant.sizeGB && (
        <span className="ml-1 text-white/40">
          ({quant.sizeGB.toFixed(1)}GB)
        </span>
      )}
    </button>
  );
}

function formatNumber(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return n.toString();
}

export default ModelSearch;

