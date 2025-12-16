// =============================================================================
// Model Configuration Constants
// =============================================================================

import type { RagTier, RagTierConfig } from './types';

// =============================================================================
// RAG PIPELINE TIERS (Closed System - matches rag_pipeline_config.js)
// =============================================================================

// MUST MATCH: src/rag_pipeline_config.js
export const RAG_TIERS: Record<RagTier, RagTierConfig> = {
  low: {
    name: "Low",
    description: "Fast indexing, lightweight code-aware embeddings",
    targetGPU: "RTX 3060 / 8GB VRAM",
    embedder: {
      model_name: "nomic-ai/nomic-embed-text-v1.5",
      identifier: "text-embedding-nomic-embed-text-v1.5@q4_k_m",
      dimension: 768
    },
    ragSummarizer: {
      model_name: "Phi 3.1 Mini 128k Instruct",
      identifier: "phi-3.1-mini-128k-instruct"
    }
  },
  medium: {
    name: "Medium",
    description: "Balanced quality and speed for code RAG",
    targetGPU: "RTX 4070 / 12GB VRAM",
    embedder: {
      model_name: "nomic-ai/nomic-embed-text-v1.5",
      identifier: "text-embedding-nomic-embed-text-v1.5@q8_0",
      dimension: 768
    },
    ragSummarizer: {
      model_name: "Qwen2.5 Coder 1.5B Instruct",
      identifier: "qwen2.5-coder-1.5b-instruct"
    }
  },
  high: {
    name: "High",
    description: "Maximum code understanding and summarization quality",
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
