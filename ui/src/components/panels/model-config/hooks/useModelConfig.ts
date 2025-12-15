/**
 * useModelConfig Hook
 * Manages model configuration state and mutations
 */

import { useState, useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { 
  getPresets, 
  setActiveModel, 
  getModelStatus, 
  downloadModel,
  loadPresetModels 
} from '../../../../lib/api';
import type { QualityPreset, ModelAvailability } from '../../../../lib/api';

export interface ModelSelection {
  embedding: string;
  ragSummarizer: string;
  rollingSummarizer: string;
  main: string;
}

export interface UseModelConfigReturn {
  // State
  quality: 'high' | 'medium' | 'low';
  setQuality: (q: 'high' | 'medium' | 'low') => void;
  models: ModelSelection;
  setModels: React.Dispatch<React.SetStateAction<ModelSelection>>;
  presets: Record<string, QualityPreset>;
  lastActiveModel: string;
  
  // Loading states
  presetsLoading: boolean;
  
  // Model availability
  modelAvailability: Record<string, ModelAvailability>;
  loadedModels: string[];
  
  // Mutations - using any to avoid complex generic types
  setActiveModelMutation: any;
  downloadModelMutation: any;
  loadPresetModelsMutation: any;
  
  // Helpers
  isModelAvailable: (modelId: string) => boolean;
  isModelDownloading: (modelId: string) => boolean;
  isModelLoaded: (modelId: string) => boolean;
  handleMainModelChange: (modelId: string) => void;
  handleDownloadModel: (modelId: string) => void;
  handlePresetChange: (preset: 'high' | 'medium' | 'low') => void;
  refetchModelStatus: () => void;
}

export function useModelConfig(): UseModelConfigReturn {
  const queryClient = useQueryClient();
  
  // Quality preset state
  const [quality, setQuality] = useState<'high' | 'medium' | 'low'>('high');
  
  // Model selection state
  const [models, setModels] = useState<ModelSelection>({
    embedding: '',
    ragSummarizer: '',
    rollingSummarizer: '',
    main: ''
  });

  // Fetch presets
  const { data: presetsData, isLoading: presetsLoading } = useQuery({
    queryKey: ['presets'],
    queryFn: getPresets,
    staleTime: 30000,
  });

  // Fetch model status
  const { data: modelStatusData, refetch: refetchModelStatus } = useQuery({
    queryKey: ['modelStatus'],
    queryFn: getModelStatus,
    staleTime: 10000,
    refetchInterval: 15000,
  });

  const presets = presetsData?.presets || {
    high: { name: 'High Quality', description: 'Loading...', embedding: '', ragSummarizer: '', rollingSummarizer: '', mainOptions: [] },
    medium: { name: 'Balanced', description: 'Loading...', embedding: '', ragSummarizer: '', rollingSummarizer: '', mainOptions: [] },
    low: { name: 'Fast & Lightweight', description: 'Loading...', embedding: '', ragSummarizer: '', rollingSummarizer: '', mainOptions: [] },
  };
  
  const lastActiveModel = presetsData?.lastActiveModel || '';
  const modelAvailability: Record<string, ModelAvailability> = modelStatusData?.availability || {};
  const loadedModels: string[] = modelStatusData?.loadedModels || [];

  // Update models.main when lastActiveModel changes
  useEffect(() => {
    if (lastActiveModel && lastActiveModel !== models.main) {
      setModels(prev => ({ ...prev, main: lastActiveModel }));
    }
  }, [lastActiveModel]);

  // Set Active Model Mutation
  const setActiveModelMutation = useMutation({
    mutationFn: (modelId: string) => setActiveModel(modelId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['presets'] });
    },
  });

  // Download Model Mutation
  const downloadModelMutation = useMutation({
    mutationFn: ({ modelId, quant }: { modelId: string; quant?: string }) => 
      downloadModel(modelId, quant),
    onSuccess: () => {
      setTimeout(() => {
        refetchModelStatus();
        queryClient.invalidateQueries({ queryKey: ['modelStatus'] });
      }, 2000);
    },
  });

  // Load Preset Models Mutation
  const loadPresetModelsMutation = useMutation({
    mutationFn: (preset: string) => loadPresetModels(preset),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['modelStatus'] });
    },
  });

  // Helper functions
  const isModelAvailable = (modelId: string): boolean => {
    return modelAvailability[modelId]?.available ?? false;
  };

  const isModelDownloading = (modelId: string): boolean => {
    return modelAvailability[modelId]?.downloading ?? downloadModelMutation.isPending;
  };

  const isModelLoaded = (modelId: string): boolean => {
    return loadedModels.some(loadedId =>
      loadedId === modelId ||
      loadedId.includes(modelId) ||
      modelId.includes(loadedId)
    );
  };

  const handleMainModelChange = (modelId: string) => {
    setModels(prev => ({ ...prev, main: modelId }));
    setActiveModelMutation.mutate(modelId);
  };

  const handleDownloadModel = (modelId: string, quant?: string) => {
    downloadModelMutation.mutate({ modelId, quant });
  };

  const handlePresetChange = (preset: 'high' | 'medium' | 'low') => {
    setQuality(preset);
    loadPresetModelsMutation.mutate(preset);
  };

  return {
    quality,
    setQuality,
    models,
    setModels,
    presets,
    lastActiveModel,
    presetsLoading,
    modelAvailability,
    loadedModels,
    setActiveModelMutation,
    downloadModelMutation,
    loadPresetModelsMutation,
    isModelAvailable,
    isModelDownloading,
    isModelLoaded,
    handleMainModelChange,
    handleDownloadModel,
    handlePresetChange,
    refetchModelStatus,
  };
}
