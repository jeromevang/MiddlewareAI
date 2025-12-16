// =============================================================================
// Model Configuration Constants
// =============================================================================

import type { RagTier, RagTierConfig } from './types';

// =============================================================================
// RAG PIPELINE TIERS (Closed System - matches rag_pipeline_config.js)
// =============================================================================

export const RAG_TIERS: Record<RagTier, RagTierConfig> = {
  low: {
    name: "Low",
    description: "Fast indexing, good for quick iterations",
    targetGPU: "RTX 3060 / 8GB VRAM",
    embedder: {
      model_name: "Xenova/all-MiniLM-L6-v2",
      identifier: "Xenova/all-MiniLM-L6-v2",
      dimension: 384
    },
    ragSummarizer: {
      model_name: "qwen2.5-coder-0.5b-instruct",
      identifier: "qwen2.5-coder-0.5b-instruct"
    }
  },
  medium: {
    name: "Medium",
    description: "Balanced quality and speed",
    targetGPU: "RTX 4070 / 12GB VRAM",
    embedder: {
      model_name: "Xenova/all-MiniLM-L6-v2",
      identifier: "Xenova/all-MiniLM-L6-v2",
      dimension: 768
    },
    ragSummarizer: {
      model_name: "qwen2.5-coder-1.5b-instruct",
      identifier: "qwen2.5-coder-1.5b-instruct"
    }
  },
  high: {
    name: "High",
    description: "Best quality summaries, slower indexing",
    targetGPU: "RTX 5080 / 16GB VRAM",
    embedder: {
      model_name: "nomic-ai/nomic-embed-text-v1.5",
      identifier: "text-embedding-nomic-embed-text-v1.5@q8_0",
      dimension: 768
    },
    ragSummarizer: {
      model_name: "Qwen2.5 7B Instruct 1M",
      identifier: "qwen2.5-7b-instruct-1m"
    }
  }
};

// =============================================================================
// Helper Functions
// =============================================================================

// Helper to get display name from modelKey
// Now handles exact modelKeys like "qwen/qwen3-8b" or "qwen2.5-coder-1.5b-instruct"
export function getModelDisplayName(modelId: string): string {
  if (!modelId) return 'Not set';

  // For modelKeys with publisher (e.g., "qwen/qwen3-8b")
  const parts = modelId.split('/');
  let name = parts[parts.length - 1];

  // Clean up common suffixes
  name = name
    .replace(/-GGUF$/i, '')
    .replace(/@.*$/, '')  // Remove quantization suffix
    .split('-')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
    .replace(/(\d+)b/gi, '$1B'); // Format model sizes

  return name;
}
