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
      model_name: "jinaai/jina-embeddings-v2-small-en",
      identifier: "jinaai/jina-embeddings-v2-small-en",
      dimension: 512
    },
    ragSummarizer: {
      model_name: "microsoft/phi-2",
      identifier: "microsoft/phi-2"
    }
  },
  medium: {
    name: "Medium",
    description: "Balanced quality and speed",
    targetGPU: "RTX 4070 / 12GB VRAM",
    embedder: {
      model_name: "jinaai/jina-embeddings-v2-base-en",
      identifier: "jinaai/jina-embeddings-v2-base-en",
      dimension: 768
    },
    ragSummarizer: {
      model_name: "codellama/CodeLlama-7b-Instruct-hf",
      identifier: "codellama/CodeLlama-7b-Instruct-hf"
    }
  },
  high: {
    name: "High",
    description: "Best quality summaries, slower indexing",
    targetGPU: "RTX 5080 / 16GB VRAM",
    embedder: {
      model_name: "thenlper/gte-large",
      identifier: "thenlper/gte-large",
      dimension: 1024
    },
    ragSummarizer: {
      model_name: "codellama/CodeLlama-13b-Instruct-hf",
      identifier: "codellama/CodeLlama-13b-Instruct-hf"
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
