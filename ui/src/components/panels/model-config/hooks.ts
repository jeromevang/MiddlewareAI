// =============================================================================
// Model Configuration Hooks
// =============================================================================

// Note: This hooks file contains advanced state management that's not currently used
// by the simplified ModelConfigPanel implementation. The panel now uses basic useState.
// This file is kept for future reference or if more complex state management is needed.

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useDashboardStore } from "../../../state/dashboard-store";
import type { ModelSelection, CloudSettings, ConfirmConfig, RagTier } from './types';

export function useModelConfigState() {
  const status = useDashboardStore((s) => s.status);
  const sessions = status?.sessions ?? [];
  const processing = status?.processing;
  const selectSession = useDashboardStore((s) => s.selectSession);
  const queryClient = useQueryClient();

  // Basic state
  const [mode, setMode] = useState<"local" | "cloud">("local");
  const [quality, setQuality] = useState<"high" | "medium" | "low" | "custom">("high");
  const [showModelDiscovery, setShowModelDiscovery] = useState(false);

  // Model selections
  const [models, setModels] = useState<ModelSelection>({
    embedding: "",
    ragSummarizer: "",
    rollingSummarizer: "",
    main: ""
  });

  // Cloud settings
  const [cloudSettings, setCloudSettings] = useState<CloudSettings>({
    googleStudioKey: "",
    qdrantUrl: "",
    qdrantApiKey: ""
  });

  // UI state
  const [message, setMessage] = useState("");
  const keepRecentConfigured = processing?.summary_keep_recent_turns ?? 3;
  const [draftKeepRecent, setDraftKeepRecent] = useState(keepRecentConfigured);
  const [confirmConfig, setConfirmConfig] = useState<ConfirmConfig | null>(null);
  const [confirmLoading, setConfirmLoading] = useState(false);

  // RAG Pipeline Tier Management
  const [ragTier, setRagTier] = useState<RagTier>('low');
  const [pendingTierChange, setPendingTierChange] = useState<RagTier | null>(null);

  return {
    // Store values
    status,
    sessions,
    processing,
    selectSession,
    queryClient,

    // State
    mode,
    setMode,
    quality,
    setQuality,
    showModelDiscovery,
    setShowModelDiscovery,
    models,
    setModels,
    cloudSettings,
    setCloudSettings,
    message,
    setMessage,
    keepRecentConfigured,
    draftKeepRecent,
    setDraftKeepRecent,
    confirmConfig,
    setConfirmConfig,
    confirmLoading,
    setConfirmLoading,
    ragTier,
    setRagTier,
    pendingTierChange,
    setPendingTierChange,
  };
}

export function useModelConfigQueries() {
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
    staleTime: 2000, // 2 seconds when downloads active
    // Poll faster when downloads are active
    refetchInterval: (query) => {
      const hasActiveDownloads = Object.keys(query.state.data?.activeDownloads || {}).length > 0;
      return hasActiveDownloads ? 1000 : 15000; // 1s during downloads, 15s otherwise
    },
  });

  // Fetch RAG pipeline configuration
  const { data: ragTierData } = useQuery({
    queryKey: ['ragTier'],
    queryFn: async () => {
      const res = await fetch("/rag/tier");
      return res.json();
    },
    staleTime: 30000,
  });

  // Fetch bootstrap status
  const { data: bootstrapData } = useQuery({
    queryKey: ['bootstrapStatus'],
    queryFn: getBootstrapStatus,
    staleTime: 2000, // 2 seconds
    refetchInterval: (query) => query.state.data?.running ? 1000 : 10000, // Poll faster when running
  });

  // Fetch available models for Custom Preset panel
  const { data: availableModelsData, refetch: refetchAvailableModels } = useQuery({
    queryKey: ['availableModels'],
    queryFn: async () => {
      const response = await fetch('/models/available');
      if (!response.ok) throw new Error('Failed to fetch available models');
      return response.json();
    },
    staleTime: 30000, // 30 seconds
    enabled: quality === 'custom', // Only fetch when custom preset is selected
  });

  return {
    presetsData,
    presetsLoading,
    modelStatusData,
    refetchModelStatus,
    ragTierData,
    bootstrapData,
    availableModelsData,
    refetchAvailableModels,
  };
}

// Additional hook implementations would go here...
