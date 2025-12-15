// =============================================================================
// Model Configuration Types
// =============================================================================

export interface ModelSelection {
  embedding: string;
  ragSummarizer: string;
  rollingSummarizer: string;
  main: string;
}

export interface CloudSettings {
  googleStudioKey: string;
  qdrantUrl: string;
  qdrantApiKey: string;
}

export interface ConfirmConfig {
  title: string;
  description: string;
  tone?: "default" | "danger";
  confirmLabel?: string;
  onConfirm: () => Promise<unknown> | void;
}

export type RagTier = 'low' | 'medium' | 'high';

export interface RagTierConfig {
  name: string;
  description: string;
  targetGPU: string;
}
