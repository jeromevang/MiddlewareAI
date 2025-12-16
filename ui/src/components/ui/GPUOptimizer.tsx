/**
 * GPU Optimizer Component
 * 
 * Displays GPU optimization status, allows triggering optimization,
 * and shows cached settings with manual override capabilities.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Zap, RefreshCw, Trash2, ChevronDown, ChevronUp } from 'lucide-react';

interface GPUStatus {
  optimization: {
    isOptimizing: boolean;
    currentModel: string | null;
    iteration: number;
    maxIterations: number;
    progress: number;
    message: string;
    results: Record<string, any>;
  };
  gpu: {
    name: string;
    totalVRAM: number;
    available: boolean;
  } | null;
  vram: {
    usedGB: number;
    freeGB: number;
    totalGB: number;
    usagePercent: number;
  } | null;
}

interface CachedSettings {
  combinationHash: string;
  modelIds: string[];
  cached: {
    settings: Record<string, {
      modelId: string;
      role: string;
      optimalGPU: number;
      tokensPerSecond: number;
      gpuUtilization: number;
      vramUsedGB: number;
    }>;
    calibratedAt: string;
    gpuName: string;
    totalVRAMUsed: number;
  } | null;
  hasCached: boolean;
}

interface ModelSetting {
  modelId: string;
  role: string;
  optimalGPU: number;
  tokensPerSecond: number;
  gpuUtilization: number;
  vramUsedGB: number;
  manual?: boolean;
}

export function GPUOptimizer() {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [manualOverrides, setManualOverrides] = useState<Record<string, number>>({});

  // Fetch GPU status
  const { data: gpuStatus, isLoading: statusLoading, error: statusError } = useQuery<GPUStatus>({
    queryKey: ['gpuStatus'],
    queryFn: async () => {
      const res = await fetch('/gpu/status');
      if (!res.ok) throw new Error('Failed to fetch GPU status');
      return res.json();
    },
    refetchInterval: (query) => {
      // Poll more frequently when optimizing
      return query.state.data?.optimization?.isOptimizing ? 1000 : 10000;
    },
    staleTime: 2000,
    retry: 3,
  });

  // Fetch cached settings
  const { data: cachedSettings } = useQuery<CachedSettings>({
    queryKey: ['gpuSettings'],
    queryFn: async () => {
      const res = await fetch('/gpu/settings');
      if (!res.ok) throw new Error('Failed to fetch GPU settings');
      return res.json();
    },
    staleTime: 10000,
  });

  // Trigger optimization mutation
  const optimizeMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/gpu/optimize', { method: 'POST' });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || 'Failed to start optimization');
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['gpuStatus'] });
      queryClient.invalidateQueries({ queryKey: ['gpuSettings'] });
    },
  });

  // Clear cache mutation
  const clearCacheMutation = useMutation({
    mutationFn: async (hash: string) => {
      const res = await fetch(`/gpu/settings/${hash}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to clear cache');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['gpuSettings'] });
    },
  });

  // Apply cached settings mutation
  const applyCachedMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/gpu/apply-cached', { method: 'POST' });
      if (!res.ok) throw new Error('Failed to apply cached settings');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['gpuStatus'] });
    },
  });

  // Manual GPU override mutation
  const manualOverrideMutation = useMutation({
    mutationFn: async ({ modelId, gpu, role }: { modelId: string; gpu: number; role: string }) => {
      const res = await fetch(`/gpu/settings/${encodeURIComponent(modelId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gpu, role }),
      });
      if (!res.ok) throw new Error('Failed to apply manual override');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['gpuStatus'] });
      queryClient.invalidateQueries({ queryKey: ['gpuSettings'] });
    },
  });

  const isOptimizing = gpuStatus?.optimization?.isOptimizing;
  const progress = gpuStatus?.optimization?.progress || 0;
  const message = gpuStatus?.optimization?.message || '';

  const handleManualOverride = (modelId: string, role: string) => {
    const gpu = manualOverrides[modelId];
    if (gpu !== undefined) {
      manualOverrideMutation.mutate({ modelId, gpu, role });
    }
  };

  if (statusLoading) {
    return (
      <div className="p-4 bg-white/5 border border-white/10 rounded-lg">
        <div className="flex items-center gap-2 text-white/60">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading GPU status...
        </div>
      </div>
    );
  }

  if (statusError) {
    return (
      <div className="p-4 bg-red-500/10 border border-red-500/30 rounded-lg">
        <div className="flex items-center gap-2 text-red-400">
          <Zap className="w-4 h-4" />
          <span>GPU monitoring error: {statusError.message}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white/5 border border-white/10 rounded-lg overflow-hidden">
      {/* Header */}
      <div
        className="p-4 flex items-center justify-between cursor-pointer hover:bg-white/5"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-3">
          <Zap className="w-5 h-5 text-yellow-400" />
          <div>
            <h3 className="font-semibold text-white">GPU Optimization</h3>
            <p className="text-sm text-white/60">
              {gpuStatus?.gpu?.name || 'Unknown GPU'} • {gpuStatus?.vram?.usedGB?.toFixed(1) || '?'}GB / {gpuStatus?.vram?.totalGB?.toFixed(1) || '?'}GB VRAM
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {cachedSettings?.hasCached && (
            <span className="px-2 py-1 text-xs bg-green-500/20 text-green-400 rounded">Optimized</span>
          )}
          {expanded ? <ChevronUp className="w-5 h-5 text-white/60" /> : <ChevronDown className="w-5 h-5 text-white/60" />}
        </div>
      </div>

      {/* Expanded Content */}
      {expanded && (
        <div className="px-4 pb-4 space-y-4">
          {/* Optimization Progress */}
          {isOptimizing && (
            <div className="p-3 bg-yellow-500/10 border border-yellow-500/30 rounded-lg">
              <div className="flex items-center gap-2 mb-2">
                <Loader2 className="w-4 h-4 animate-spin text-yellow-400" />
                <span className="text-yellow-400 font-medium">Optimizing...</span>
              </div>
              <p className="text-sm text-white/80 mb-2">{message}</p>
              <div className="w-full bg-white/10 rounded-full h-2">
                <div
                  className="bg-yellow-400 h-2 rounded-full transition-all duration-300"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => optimizeMutation.mutate()}
              disabled={isOptimizing || optimizeMutation.isPending}
              className="flex items-center gap-2 px-3 py-2 bg-yellow-500 hover:bg-yellow-600 disabled:opacity-50 disabled:cursor-not-allowed text-black font-medium rounded-lg transition-colors"
            >
              {(isOptimizing || optimizeMutation.isPending) ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Zap className="w-4 h-4" />
              )}
              {isOptimizing ? 'Optimizing...' : 'Optimize GPU'}
            </button>

            {cachedSettings?.hasCached && (
              <>
                <button
                  onClick={() => applyCachedMutation.mutate()}
                  disabled={applyCachedMutation.isPending}
                  className="flex items-center gap-2 px-3 py-2 bg-blue-500/20 hover:bg-blue-500/30 text-blue-400 rounded-lg transition-colors"
                >
                  <RefreshCw className={`w-4 h-4 ${applyCachedMutation.isPending ? 'animate-spin' : ''}`} />
                  Apply Cached
                </button>
                <button
                  onClick={() => clearCacheMutation.mutate(cachedSettings.combinationHash)}
                  disabled={clearCacheMutation.isPending}
                  className="flex items-center gap-2 px-3 py-2 bg-red-500/20 hover:bg-red-500/30 text-red-400 rounded-lg transition-colors"
                >
                  <Trash2 className="w-4 h-4" />
                  Clear Cache
                </button>
              </>
            )}
          </div>

          {/* Cached Settings Display */}
          {cachedSettings?.cached && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-medium text-white/80">Cached Settings</h4>
                <span className="text-xs text-white/50">
                  Calibrated: {new Date(cachedSettings.cached.calibratedAt).toLocaleString()}
                </span>
              </div>

              <div className="space-y-2">
                {Object.values(cachedSettings.cached.settings).map((setting: ModelSetting) => (
                  <div
                    key={setting.modelId}
                    className="p-3 bg-white/5 border border-white/10 rounded-lg"
                  >
                    <div className="flex items-center justify-between mb-2">
                      <div>
                        <span className="font-medium text-white">{setting.modelId}</span>
                        <span className="ml-2 text-xs px-2 py-0.5 bg-white/10 rounded text-white/60">
                          {setting.role}
                        </span>
                      </div>
                      <div className="text-sm text-white/60">
                        {setting.tokensPerSecond?.toFixed(1) || '?'} t/s
                      </div>
                    </div>

                    <div className="grid grid-cols-3 gap-2 text-sm">
                      <div>
                        <span className="text-white/50">GPU:</span>
                        <span className="ml-1 text-white">{(setting.optimalGPU * 100).toFixed(0)}%</span>
                      </div>
                      <div>
                        <span className="text-white/50">Util:</span>
                        <span className="ml-1 text-white">{setting.gpuUtilization?.toFixed(0) || '?'}%</span>
                      </div>
                      <div>
                        <span className="text-white/50">VRAM:</span>
                        <span className="ml-1 text-white">{setting.vramUsedGB?.toFixed(1) || '?'}GB</span>
                      </div>
                    </div>

                    {/* Manual Override */}
                    <div className="mt-3 flex items-center gap-2">
                      <span className="text-xs text-white/50">Override:</span>
                      <input
                        type="range"
                        min="0"
                        max="100"
                        step="5"
                        value={(manualOverrides[setting.modelId] ?? setting.optimalGPU) * 100}
                        onChange={(e) =>
                          setManualOverrides((prev) => ({
                            ...prev,
                            [setting.modelId]: parseInt(e.target.value) / 100,
                          }))
                        }
                        className="flex-1 h-1 bg-white/20 rounded-lg appearance-none cursor-pointer accent-yellow-400"
                      />
                      <span className="text-xs text-white/70 w-10">
                        {((manualOverrides[setting.modelId] ?? setting.optimalGPU) * 100).toFixed(0)}%
                      </span>
                      <button
                        onClick={() => handleManualOverride(setting.modelId, setting.role)}
                        disabled={manualOverrideMutation.isPending}
                        className="px-2 py-1 text-xs bg-white/10 hover:bg-white/20 text-white rounded transition-colors"
                      >
                        Apply
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* No Cache Message */}
          {!cachedSettings?.hasCached && !isOptimizing && (
            <div className="p-3 bg-white/5 border border-white/10 rounded-lg text-center">
              <p className="text-white/60 text-sm">
                No cached optimization settings for current model combination.
              </p>
              <p className="text-white/40 text-xs mt-1">
                Click "Optimize GPU" to find optimal settings.
              </p>
            </div>
          )}

          {/* Info */}
          <div className="text-xs text-white/40 space-y-1">
            <p>• Optimization finds the best GPU offload settings for your model combination</p>
            <p>• Settings are cached per model combination and applied automatically on load</p>
            <p>• Manual overrides let you fine-tune individual model GPU allocation</p>
          </div>
        </div>
      )}
    </div>
  );
}

export default GPUOptimizer;

