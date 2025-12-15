/**
 * RAG Pipeline Configuration
 * 
 * This defines the CLOSED RAG system with fixed, specialized models per tier.
 * The RAG pipeline (Embedder + RAG Summarizer + FAISS) is NOT user-configurable.
 * 
 * Only the Main Model and Rolling Summarizer are user-selectable.
 */

// ============================================================================
// FIXED EMBEDDER (Same for all tiers - code-aware)
// ============================================================================
const FIXED_EMBEDDER = {
    model_name: 'jinaai/jina-embeddings-v2-base-code',
    identifier: 'jina-embeddings-v2-base-code',
    engine: 'local', // Runs via @xenova/transformers
    dimension: 768,
    context_length: 8192,
    description: 'Code-aware embeddings optimized for programming languages',
    locked: true // Cannot be changed without full re-index
};

// ============================================================================
// RAG PIPELINE TIERS (Closed system - fixed models per tier)
// ============================================================================
const RAG_PIPELINE_TIERS = {
    low: {
        name: 'Low',
        description: 'Fast indexing, lightweight code-aware embeddings',
        targetGPU: 'RTX 3060 / 8GB VRAM',
        embedder: {
            model_name: 'nomic-ai/nomic-embed-text-v1.5',
            identifier: 'text-embedding-nomic-embed-text-v1.5@q4_k_m',
            engine: 'local',
            dimension: 768,  // Good semantic resolution
            context_length: 2048,
            description: 'Lightweight embeddings with good code understanding',
            locked: true
        },
        ragSummarizer: {
            model_name: 'Phi 3.1 Mini 128k Instruct',
            identifier: 'phi-3.1-mini-128k-instruct',
            context_length: 2048,
            description: 'Efficient code summarizer with strong function awareness',
            sizeGB: 2.23
        },
        indexingSpeed: 'fast',
        summaryQuality: 'good'
    },

    medium: {
        name: 'Medium',
        description: 'Balanced quality and speed for code RAG',
        targetGPU: 'RTX 4070 / 12GB VRAM',
        embedder: {
            model_name: 'nomic-ai/nomic-embed-text-v1.5',
            identifier: 'text-embedding-nomic-embed-text-v1.5@q8_0',
            engine: 'local',
            dimension: 768,  // Balanced semantic resolution
            context_length: 2048,
            description: 'High-quality embeddings for code understanding',
            locked: true
        },
        ragSummarizer: {
            model_name: 'Qwen2.5 Coder 1.5B Instruct',
            identifier: 'qwen2.5-coder-1.5b-instruct',
            context_length: 4096,
            description: 'Specialized code summarizer with excellent function analysis',
            sizeGB: 0.92
        },
        indexingSpeed: 'moderate',
        summaryQuality: 'excellent'
    },

    high: {
        name: 'High',
        description: 'Maximum code understanding and summarization quality',
        targetGPU: 'RTX 5080 / 16GB VRAM',
        embedder: {
            model_name: 'nomic-ai/nomic-embed-text-v1.5',
            identifier: 'text-embedding-nomic-embed-text-v1.5@q8_0',
            engine: 'local',
            dimension: 768,  // High quality semantic resolution
            context_length: 2048,
            description: 'Premium embeddings with excellent semantic understanding',
            locked: true
        },
        ragSummarizer: {
            model_name: 'Qwen2.5 7B Instruct 1M',
            identifier: 'qwen2.5-7b-instruct-1m',
            context_length: 4096,
            description: 'Professional-grade code summarizer with comprehensive analysis',
            sizeGB: 4.36
        },
        indexingSpeed: 'slow',
        summaryQuality: 'premium'
    }
};

// ============================================================================
// USER-SELECTABLE MODELS (Per preset)
// ============================================================================

// Default rolling summarizers per tier (user can override)
const DEFAULT_ROLLING_SUMMARIZERS = {
    low: {
        model_name: 'qwen2.5-coder-0.5b-instruct',
        identifier: 'qwen2.5-coder-0.5b-instruct',
        context_length: 4096,
        description: 'Fast conversation memory compression'
    },
    medium: {
        model_name: 'qwen2.5-coder-1.5b-instruct',
        identifier: 'qwen2.5-coder-1.5b-instruct',
        context_length: 4096,
        description: 'Balanced conversation memory'
    },
    high: {
        model_name: 'phi-3.1-mini-128k-instruct',
        identifier: 'phi-3.1-mini-128k-instruct',
        context_length: 4096,
        description: 'High-quality conversation memory'
    }
};

// Default main models per tier (user can override)
const DEFAULT_MAIN_MODELS = {
    low: 'qwen/qwen3-4b-2507',
    medium: 'qwen/qwen3-8b',
    high: 'qwen/qwen3-14b'
};

// ============================================================================
// API Functions
// ============================================================================

/**
 * Get the complete RAG pipeline config for a tier
 * @param {'low'|'medium'|'high'} tier 
 * @returns {Object} Pipeline configuration
 */
function getRagPipelineConfig(tier = 'medium') {
    const config = RAG_PIPELINE_TIERS[tier];
    if (!config) {
        console.warn(`[RAG Pipeline] Unknown tier "${tier}", falling back to medium`);
        return RAG_PIPELINE_TIERS.medium;
    }
    return config;
}

/**
 * Get the embedder config for a specific tier
 * @param {'low'|'medium'|'high'} tier
 * @returns {Object} Embedder configuration
 */
function getEmbedderConfig(tier = 'medium') {
    const config = RAG_PIPELINE_TIERS[tier];
    return config?.embedder || RAG_PIPELINE_TIERS.medium.embedder;
}

/**
 * Get the fixed embedder config (deprecated - use getEmbedderConfig)
 * @returns {Object} Embedder configuration
 * @deprecated Use getEmbedderConfig(tier) instead
 */
function getFixedEmbedderConfig() {
    return getEmbedderConfig('medium');
}

/**
 * Get the RAG summarizer for a tier (FIXED - not user selectable)
 * @param {'low'|'medium'|'high'} tier 
 * @returns {Object} RAG summarizer configuration
 */
function getRagSummarizerConfig(tier = 'medium') {
    const config = RAG_PIPELINE_TIERS[tier];
    return config?.ragSummarizer || RAG_PIPELINE_TIERS.medium.ragSummarizer;
}

/**
 * Get default rolling summarizer for a tier (user can override)
 * @param {'low'|'medium'|'high'} tier 
 * @returns {Object} Rolling summarizer configuration
 */
function getDefaultRollingSummarizer(tier = 'medium') {
    return DEFAULT_ROLLING_SUMMARIZERS[tier] || DEFAULT_ROLLING_SUMMARIZERS.medium;
}

/**
 * Get default main model for a tier (user can override)
 * @param {'low'|'medium'|'high'} tier 
 * @returns {string} Main model identifier
 */
function getDefaultMainModel(tier = 'medium') {
    return DEFAULT_MAIN_MODELS[tier] || DEFAULT_MAIN_MODELS.medium;
}

/**
 * Get all available tiers
 * @returns {Object} All tier configurations
 */
function getAllTiers() {
    return { ...RAG_PIPELINE_TIERS };
}

/**
 * Check if changing from one tier to another requires re-indexing
 * @param {string} fromTier
 * @param {string} toTier
 * @returns {boolean} True if re-index required
 */
function requiresReindex(fromTier, toTier) {
    if (fromTier === toTier) return false;

    const from = RAG_PIPELINE_TIERS[fromTier];
    const to = RAG_PIPELINE_TIERS[toTier];

    if (!from || !to) return true;

    // Re-index required if:
    // 1. Embedder changes (model or dimension mismatch)
    // 2. RAG summarizer changes (different model)
    const embedderChanged = from.embedder.model_name !== to.embedder.model_name ||
                           from.embedder.dimension !== to.embedder.dimension;
    const summarizerChanged = from.ragSummarizer.identifier !== to.ragSummarizer.identifier;

    return embedderChanged || summarizerChanged;
}

module.exports = {
    FIXED_EMBEDDER, // Deprecated - kept for backward compatibility
    RAG_PIPELINE_TIERS,
    DEFAULT_ROLLING_SUMMARIZERS,
    DEFAULT_MAIN_MODELS,
    getRagPipelineConfig,
    getFixedEmbedderConfig, // Deprecated - use getEmbedderConfig
    getEmbedderConfig,
    getRagSummarizerConfig,
    getDefaultRollingSummarizer,
    getDefaultMainModel,
    getAllTiers,
    requiresReindex
};

