import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getSuggestedModels, approveModel, dismissModel, discoverModels } from "../../lib/api";
import type { ModelSpec } from "../../lib/api";
import { Card } from "./Card";
import { Button } from "./Button";
import { Search, Check, X, RefreshCw, Sparkles, Cpu, HardDrive, Zap } from "lucide-react";

interface SuggestedModelsPanelProps {
  className?: string;
}

export function SuggestedModelsPanel({ className }: SuggestedModelsPanelProps) {
  const queryClient = useQueryClient();
  const [selectedTier, setSelectedTier] = useState<Record<string, 'high' | 'medium' | 'low'>>({});

  // Fetch suggested models
  const { data: suggestedData, isLoading } = useQuery({
    queryKey: ['suggestedModels'],
    queryFn: getSuggestedModels,
    refetchInterval: 60000, // Refresh every minute
  });

  const suggested = suggestedData?.suggested || [];

  // Discover mutation
  const discoverMutation = useMutation({
    mutationFn: discoverModels,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['suggestedModels'] });
      queryClient.invalidateQueries({ queryKey: ['presets'] });
    },
  });

  // Approve mutation
  const approveMutation = useMutation({
    mutationFn: ({ modelId, quality }: { modelId: string; quality: 'high' | 'medium' | 'low' }) =>
      approveModel(modelId, quality),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['suggestedModels'] });
      queryClient.invalidateQueries({ queryKey: ['presets'] });
    },
  });

  // Dismiss mutation
  const dismissMutation = useMutation({
    mutationFn: dismissModel,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['suggestedModels'] });
    },
  });

  const handleApprove = (modelId: string) => {
    const tier = selectedTier[modelId] || 'medium';
    approveMutation.mutate({ modelId, quality: tier });
  };

  const handleDismiss = (modelId: string) => {
    dismissMutation.mutate(modelId);
  };

  const getPerformanceColor = (level: string) => {
    switch (level) {
      case 'Excellent': return 'text-green-400';
      case 'Good': return 'text-blue-400';
      case 'Fair': return 'text-yellow-400';
      case 'Basic': return 'text-red-400';
      default: return 'text-gray-400';
    }
  };

  return (
    <Card title="Model Discovery" className={className}>
      <div className="space-y-4">
        {/* Discovery controls */}
        <div className="flex items-center justify-between">
          <p className="text-sm text-white/70">
            Discover new models from LM Studio and let AI analyze their capabilities.
          </p>
          <Button
            variant="primary"
            size="sm"
            onClick={() => discoverMutation.mutate()}
            disabled={discoverMutation.isPending}
          >
            {discoverMutation.isPending ? (
              <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Search className="h-4 w-4 mr-2" />
            )}
            Discover Models
          </Button>
        </div>

        {/* Discovery status */}
        {discoverMutation.isPending && (
          <div className="p-4 bg-cyan-500/10 border border-cyan-500/20 rounded-lg">
            <div className="flex items-center gap-2 text-cyan-400">
              <Sparkles className="h-4 w-4 animate-pulse" />
              <span className="text-sm">Scanning LM Studio for new models and analyzing with AI...</span>
            </div>
          </div>
        )}

        {discoverMutation.isSuccess && discoverMutation.data && (
          <div className="p-4 bg-green-500/10 border border-green-500/20 rounded-lg">
            <div className="flex items-center gap-2 text-green-400">
              <Check className="h-4 w-4" />
              <span className="text-sm">
                Discovery complete! Found {discoverMutation.data.discovered} new model(s).
              </span>
            </div>
          </div>
        )}

        {/* Suggested models list */}
        {isLoading ? (
          <div className="text-center py-8 text-white/60">
            <RefreshCw className="h-6 w-6 animate-spin mx-auto mb-2" />
            Loading suggested models...
          </div>
        ) : suggested.length === 0 ? (
          <div className="text-center py-8 text-white/60">
            <Sparkles className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p>No suggested models pending approval.</p>
            <p className="text-xs mt-1">Click "Discover Models" to scan for new models.</p>
          </div>
        ) : (
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-white">
              Pending Approval ({suggested.length})
            </h3>
            
            {suggested.map((model: ModelSpec) => (
              <div
                key={model.id}
                className="p-4 border border-white/10 bg-white/5 rounded-lg hover:bg-white/10 transition-colors"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <h4 className="font-semibold text-white truncate">{model.name}</h4>
                    <p className="text-xs text-white/60 mb-2">{model.author}</p>
                    <p className="text-sm text-white/80 line-clamp-2">{model.description}</p>
                    
                    {/* Model specs */}
                    <div className="flex flex-wrap gap-4 mt-3 text-xs">
                      <div className="flex items-center gap-1 text-white/70">
                        <HardDrive className="h-3 w-3" />
                        <span>{model.size}</span>
                      </div>
                      <div className="flex items-center gap-1 text-white/70">
                        <Cpu className="h-3 w-3" />
                        <span>{model.contextLength?.toLocaleString()} ctx</span>
                      </div>
                      {model.performance && (
                        <div className="flex items-center gap-1">
                          <Zap className="h-3 w-3 text-white/70" />
                          <span className={getPerformanceColor(model.performance.speed)}>
                            {model.performance.speed}
                          </span>
                        </div>
                      )}
                    </div>

                    {/* Suggested tier */}
                    {model.suggestedTier && (
                      <div className="mt-2">
                        <span className="text-xs text-white/60">AI suggests: </span>
                        <span className={`text-xs px-2 py-0.5 rounded ${
                          model.suggestedTier === 'high' ? 'bg-purple-500/20 text-purple-400' :
                          model.suggestedTier === 'medium' ? 'bg-blue-500/20 text-blue-400' :
                          'bg-green-500/20 text-green-400'
                        }`}>
                          {model.suggestedTier === 'high' ? 'High Quality' :
                           model.suggestedTier === 'medium' ? 'Balanced' :
                           'Fast & Lightweight'}
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="flex flex-col gap-2">
                    {/* Tier selector */}
                    <select
                      value={selectedTier[model.id] || model.suggestedTier || 'medium'}
                      onChange={(e) => setSelectedTier(prev => ({
                        ...prev,
                        [model.id]: e.target.value as 'high' | 'medium' | 'low'
                      }))}
                      className="text-xs bg-white/10 border border-white/20 rounded px-2 py-1 text-white"
                    >
                      <option value="high">High Quality</option>
                      <option value="medium">Balanced</option>
                      <option value="low">Lightweight</option>
                    </select>

                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => handleApprove(model.id)}
                      disabled={approveMutation.isPending}
                    >
                      <Check className="h-3 w-3 mr-1" />
                      Approve
                    </Button>

                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDismiss(model.id)}
                      disabled={dismissMutation.isPending}
                      className="text-red-400 hover:text-red-300"
                    >
                      <X className="h-3 w-3 mr-1" />
                      Dismiss
                    </Button>
                  </div>
                </div>

                {/* Capabilities */}
                {model.capabilities && model.capabilities.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-3">
                    {model.capabilities.slice(0, 5).map((cap: string) => (
                      <span
                        key={cap}
                        className="px-1.5 py-0.5 text-xs bg-white/10 text-white/70 rounded"
                      >
                        {cap}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}
