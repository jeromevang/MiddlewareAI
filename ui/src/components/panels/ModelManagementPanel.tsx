/**
 * Model Management Panel
 * 
 * Dedicated panel for managing all downloaded models:
 * - View all available models
 * - Lock/unlock models to prevent removal during bootstrap re-analysis
 * - View model details and capabilities
 * - Filter and search models
 */

import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { 
  Search, 
  Lock, 
  Unlock, 
  Star, 
  HardDrive, 
  Cpu, 
  MessageSquare,
  RefreshCw,
  Filter,
  ChevronDown,
  ChevronUp,
  Check
} from 'lucide-react';
import { getAvailableModels, getModelLocks, toggleModelLock, getModelStatus } from '../../lib/api';
import { getModelDisplayName } from './model-config/constants';

interface ModelInfo {
  modelKey: string;
  displayName?: string;
  function?: 'main' | 'summarizer' | 'embedder';
  qualityTier?: 'high' | 'medium' | 'low';
  sizeGB?: number;
  quantization?: string;
  contextLength?: number;
}

type FilterRole = 'all' | 'main' | 'summarizer' | 'embedder';
type FilterTier = 'all' | 'high' | 'medium' | 'low';

export function ModelManagementPanel() {
  const [searchQuery, setSearchQuery] = useState('');
  const [filterRole, setFilterRole] = useState<FilterRole>('all');
  const [filterTier, setFilterTier] = useState<FilterTier>('all');
  const [showFilters, setShowFilters] = useState(false);
  const [expandedModel, setExpandedModel] = useState<string | null>(null);
  
  const queryClient = useQueryClient();

  // Fetch available models
  const { data: modelsData, isLoading: modelsLoading, refetch: refetchModels } = useQuery({
    queryKey: ['availableModels'],
    queryFn: getAvailableModels,
    staleTime: 30000,
  });

  // Fetch model locks
  const { data: locksData, isLoading: locksLoading } = useQuery({
    queryKey: ['modelLocks'],
    queryFn: getModelLocks,
    staleTime: 5000,
  });

  // Fetch model status (loaded models) - WebSocket provides real-time updates
  const { data: statusData } = useQuery({
    queryKey: ['modelStatus'],
    queryFn: getModelStatus,
    staleTime: 60000, // Consider data fresh for 1 minute
    refetchInterval: false, // WebSocket handles real-time updates
  });

  // Toggle lock mutation
  const toggleLockMutation = useMutation({
    mutationFn: (modelId: string) => toggleModelLock(modelId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['modelLocks'] });
    },
  });

  const models: ModelInfo[] = modelsData?.models || [];
  const locks: Record<string, { preset?: boolean; loaded?: boolean }> = locksData?.locks || {};
  const loadedModels: string[] = statusData?.loadedModels || [];

  // Filter and search models
  const filteredModels = useMemo(() => {
    return models.filter(model => {
      // Search filter
      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        const matchesSearch = 
          model.modelKey.toLowerCase().includes(query) ||
          (model.displayName?.toLowerCase().includes(query));
        if (!matchesSearch) return false;
      }

      // Role filter
      if (filterRole !== 'all' && model.function !== filterRole) {
        return false;
      }

      // Tier filter
      if (filterTier !== 'all' && model.qualityTier !== filterTier) {
        return false;
      }

      return true;
    });
  }, [models, searchQuery, filterRole, filterTier]);

  // Get star rating based on quality tier
  const getStarRating = (model: ModelInfo) => {
    if (model.qualityTier === 'high') return { stars: 5, label: 'High Quality' };
    if (model.qualityTier === 'medium') return { stars: 3, label: 'Balanced' };
    if (model.qualityTier === 'low') return { stars: 1, label: 'Lightweight' };
    
    // Fallback based on size
    if (model.sizeGB) {
      if (model.sizeGB > 10) return { stars: 5, label: 'Large' };
      if (model.sizeGB > 5) return { stars: 4, label: 'Medium-Large' };
      if (model.sizeGB > 2) return { stars: 3, label: 'Medium' };
      if (model.sizeGB > 1) return { stars: 2, label: 'Small' };
    }
    return { stars: 1, label: 'Compact' };
  };

  // Get role icon
  const getRoleIcon = (role?: string) => {
    switch (role) {
      case 'main': return <MessageSquare className="h-4 w-4 text-cyan-400" />;
      case 'summarizer': return <Cpu className="h-4 w-4 text-purple-400" />;
      case 'embedder': return <HardDrive className="h-4 w-4 text-green-400" />;
      default: return <HardDrive className="h-4 w-4 text-white/40" />;
    }
  };

  // Count stats
  const lockedCount = Object.values(locks).filter(l => l.preset).length;
  const loadedCount = loadedModels.length;

  const isLoading = modelsLoading || locksLoading;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-white">Model Management</h2>
          <p className="text-sm text-white/60">
            Manage downloaded models and prevent removal during re-analysis
          </p>
        </div>
        <button
          onClick={() => refetchModels()}
          className="p-2 rounded-lg bg-white/5 hover:bg-white/10 text-white/60 hover:text-white transition-colors"
          title="Refresh models"
        >
          <RefreshCw className="h-4 w-4" />
        </button>
      </div>

      {/* Stats Bar */}
      <div className="flex items-center gap-4 text-sm">
        <div className="px-3 py-1.5 rounded-lg bg-white/5 border border-white/10">
          <span className="text-white/60">Total:</span>
          <span className="ml-2 text-white font-medium">{models.length}</span>
        </div>
        <div className="px-3 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/30">
          <Lock className="h-3.5 w-3.5 text-amber-400 inline mr-1" />
          <span className="text-amber-400">Locked:</span>
          <span className="ml-2 text-amber-300 font-medium">{lockedCount}</span>
        </div>
        <div className="px-3 py-1.5 rounded-lg bg-green-500/10 border border-green-500/30">
          <span className="text-green-400">Loaded:</span>
          <span className="ml-2 text-green-300 font-medium">{loadedCount}</span>
        </div>
      </div>

      {/* Search and Filters */}
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          {/* Search */}
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-white/40" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search models..."
              className="w-full pl-10 pr-4 py-2.5 bg-white/5 border border-white/10 rounded-lg text-white placeholder-white/40 focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/30 outline-none transition-colors"
            />
          </div>

          {/* Filter Toggle */}
          <button
            onClick={() => setShowFilters(!showFilters)}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-lg border transition-colors ${
              showFilters || filterRole !== 'all' || filterTier !== 'all'
                ? 'bg-cyan-500/20 border-cyan-500/30 text-cyan-400'
                : 'bg-white/5 border-white/10 text-white/60 hover:bg-white/10'
            }`}
          >
            <Filter className="h-4 w-4" />
            <span>Filters</span>
            {showFilters ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </button>

          {/* Bulk Actions */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                // Lock all filtered models
                filteredModels.forEach(model => {
                  if (!locks[model.modelKey]?.preset) {
                    toggleLockMutation.mutate(model.modelKey);
                  }
                });
              }}
              className="px-3 py-2 text-sm bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 rounded-lg text-amber-400 transition-colors"
              title="Lock all visible models"
            >
              <Lock className="h-4 w-4" />
            </button>
            <button
              onClick={() => {
                // Unlock all filtered models
                filteredModels.forEach(model => {
                  if (locks[model.modelKey]?.preset) {
                    toggleLockMutation.mutate(model.modelKey);
                  }
                });
              }}
              className="px-3 py-2 text-sm bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-white/60 hover:text-white transition-colors"
              title="Unlock all visible models"
            >
              <Unlock className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Filter Options */}
        {showFilters && (
          <div className="flex items-center gap-6 p-4 bg-white/5 border border-white/10 rounded-lg">
            {/* Role Filter */}
            <div className="space-y-2">
              <label className="text-xs text-white/60 uppercase tracking-wider">Role</label>
              <div className="flex items-center gap-2">
                {(['all', 'main', 'summarizer', 'embedder'] as FilterRole[]).map(role => (
                  <button
                    key={role}
                    onClick={() => setFilterRole(role)}
                    className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${
                      filterRole === role
                        ? 'bg-cyan-500/20 border border-cyan-500/40 text-cyan-400'
                        : 'bg-white/5 border border-white/10 text-white/60 hover:bg-white/10'
                    }`}
                  >
                    {role === 'all' ? 'All' : role.charAt(0).toUpperCase() + role.slice(1)}
                  </button>
                ))}
              </div>
            </div>

            {/* Tier Filter */}
            <div className="space-y-2">
              <label className="text-xs text-white/60 uppercase tracking-wider">Quality Tier</label>
              <div className="flex items-center gap-2">
                {(['all', 'high', 'medium', 'low'] as FilterTier[]).map(tier => (
                  <button
                    key={tier}
                    onClick={() => setFilterTier(tier)}
                    className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${
                      filterTier === tier
                        ? 'bg-cyan-500/20 border border-cyan-500/40 text-cyan-400'
                        : 'bg-white/5 border border-white/10 text-white/60 hover:bg-white/10'
                    }`}
                  >
                    {tier === 'all' ? 'All' : tier.charAt(0).toUpperCase() + tier.slice(1)}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Models List */}
      <div className="space-y-2 max-h-[600px] overflow-y-auto pr-2">
        {isLoading ? (
          <div className="text-center py-12 text-white/60">
            <RefreshCw className="h-6 w-6 animate-spin mx-auto mb-3" />
            Loading models...
          </div>
        ) : filteredModels.length === 0 ? (
          <div className="text-center py-12 text-white/60">
            {searchQuery || filterRole !== 'all' || filterTier !== 'all'
              ? 'No models match your filters'
              : 'No models found'
            }
          </div>
        ) : (
          filteredModels.map(model => {
            const isLocked = !!locks[model.modelKey]?.preset;
            const isLoaded = loadedModels.includes(model.modelKey);
            const isExpanded = expandedModel === model.modelKey;
            const { stars, label } = getStarRating(model);

            return (
              <div key={model.modelKey} className="space-y-2">
                <div
                  className={`flex items-center gap-4 p-4 rounded-lg border transition-all cursor-pointer ${
                    isLocked
                      ? 'bg-amber-500/5 border-amber-500/30'
                      : 'bg-white/5 border-white/10 hover:bg-white/10'
                  }`}
                  onClick={() => setExpandedModel(isExpanded ? null : model.modelKey)}
                >
                  {/* Role Icon */}
                  <div className="flex-shrink-0">
                    {getRoleIcon(model.function)}
                  </div>

                  {/* Model Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-white truncate">
                        {getModelDisplayName(model.modelKey)}
                      </span>
                      {isLoaded && (
                        <span className="flex items-center gap-1 px-2 py-0.5 text-xs bg-green-500/20 text-green-400 rounded">
                          <Check className="h-3 w-3" />
                          Loaded
                        </span>
                      )}
                      {isLocked && (
                        <span className="flex items-center gap-1 px-2 py-0.5 text-xs bg-amber-500/20 text-amber-400 rounded">
                          <Lock className="h-3 w-3" />
                          Locked
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-white/50 truncate">
                      {model.modelKey}
                    </div>
                  </div>

                  {/* Role Badge */}
                  {model.function && (
                    <span className={`px-2 py-1 text-xs rounded ${
                      model.function === 'main' ? 'bg-cyan-500/20 text-cyan-400' :
                      model.function === 'summarizer' ? 'bg-purple-500/20 text-purple-400' :
                      'bg-green-500/20 text-green-400'
                    }`}>
                      {model.function}
                    </span>
                  )}

                  {/* Star Rating */}
                  <div className="flex items-center gap-1">
                    {[...Array(5)].map((_, i) => (
                      <Star
                        key={i}
                        className={`h-3 w-3 ${
                          i < stars ? 'text-yellow-400 fill-yellow-400' : 'text-white/20'
                        }`}
                      />
                    ))}
                  </div>

                  {/* Lock Toggle */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleLockMutation.mutate(model.modelKey);
                    }}
                    className={`p-2 rounded-lg transition-colors ${
                      isLocked
                        ? 'bg-amber-500/20 text-amber-400 hover:bg-amber-500/30'
                        : 'bg-white/5 text-white/40 hover:bg-white/10 hover:text-white/60'
                    }`}
                    title={isLocked
                      ? "Locked - Won't be removed during re-analysis. Click to unlock."
                      : "Click to lock - Prevent removal during re-analysis"
                    }
                  >
                    {isLocked ? <Lock className="h-4 w-4" /> : <Unlock className="h-4 w-4" />}
                  </button>
                </div>

                {/* Expanded Details */}
                {isExpanded && (
                  <div className="ml-8 p-4 bg-white/5 border border-white/10 rounded-lg space-y-4">
                    <div className="grid grid-cols-2 gap-4 text-sm">
                      <div>
                        <span className="text-white/60">Model Key:</span>
                        <div className="text-white font-mono text-xs mt-1">{model.modelKey}</div>
                      </div>
                      <div>
                        <span className="text-white/60">Quality Tier:</span>
                        <div className="text-white capitalize mt-1">{model.qualityTier || 'Unknown'}</div>
                      </div>
                      <div>
                        <span className="text-white/60">Role:</span>
                        <div className="text-white capitalize mt-1">{model.function || 'Unassigned'}</div>
                      </div>
                      <div>
                        <span className="text-white/60">Quality:</span>
                        <div className="flex items-center gap-1 mt-1">
                          {[...Array(5)].map((_, i) => (
                            <Star
                              key={i}
                              className={`h-3 w-3 ${
                                i < stars ? 'text-yellow-400 fill-yellow-400' : 'text-white/20'
                              }`}
                            />
                          ))}
                          <span className="text-white ml-1">{label}</span>
                        </div>
                      </div>
                      {model.sizeGB && (
                        <div>
                          <span className="text-white/60">Size:</span>
                          <div className="text-white mt-1">{model.sizeGB.toFixed(1)} GB</div>
                        </div>
                      )}
                      {model.contextLength && (
                        <div>
                          <span className="text-white/60">Context Length:</span>
                          <div className="text-white mt-1">{model.contextLength.toLocaleString()} tokens</div>
                        </div>
                      )}
                    </div>

                    <div className="pt-3 border-t border-white/10 text-xs text-white/50">
                      {isLocked 
                        ? "This model is locked and won't be removed from presets during re-analysis."
                        : "Lock this model to prevent it from being removed during bootstrap re-analysis."
                      }
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

export default ModelManagementPanel;

