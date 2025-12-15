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
        description: 'Fast indexing, good for quick iterations',
        targetGPU: 'RTX 3060 / 8GB VRAM',
        embedder: FIXED_EMBEDDER,
        ragSummarizer: {
            model_name: 'qwen2.5-coder-0.5b-instruct',
            identifier: 'qwen2.5-coder-0.5b-instruct',
            context_length: 4096,
            description: 'Lightweight code summarizer for RAG chunks',
            sizeGB: 0.4
        },
        indexingSpeed: 'fast',
        summaryQuality: 'basic'
    },
    medium: {
        name: 'Medium',
        description: 'Balanced quality and speed',
        targetGPU: 'RTX 4070 / 12GB VRAM',
        embedder: FIXED_EMBEDDER,
        ragSummarizer: {
            model_name: 'qwen2.5-coder-1.5b-instruct',
            identifier: 'qwen2.5-coder-1.5b-instruct',
            context_length: 4096,
            description: 'Balanced code summarizer for RAG chunks',
            sizeGB: 0.9
        },
        indexingSpeed: 'moderate',
        summaryQuality: 'good'
    },
    high: {
        name: 'High',
        description: 'Best quality summaries, slower indexing',
        targetGPU: 'RTX 5080 / 16GB VRAM',
        embedder: FIXED_EMBEDDER,
        ragSummarizer: {
            model_name: 'phi-3.1-mini-128k-instruct',
            identifier: 'phi-3.1-mini-128k-instruct',
            context_length: 4096,
            description: 'High-quality code summarizer for RAG chunks',
            sizeGB: 2.2
        },
        indexingSpeed: 'slow',
        summaryQuality: 'excellent'
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
 * Get the fixed embedder config (same for all tiers)
 * @returns {Object} Embedder configuration
 */
function getFixedEmbedderConfig() {
    return { ...FIXED_EMBEDDER };
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
    // 1. Embedder changes (dimension mismatch)
    // 2. RAG summarizer changes (summary quality changes)
    const embedderChanged = from.embedder.model_name !== to.embedder.model_name;
    const summarizerChanged = from.ragSummarizer.identifier !== to.ragSummarizer.identifier;
    
    return embedderChanged || summarizerChanged;
}

module.exports = {
    FIXED_EMBEDDER,
    RAG_PIPELINE_TIERS,
    DEFAULT_ROLLING_SUMMARIZERS,
    DEFAULT_MAIN_MODELS,
    getRagPipelineConfig,
    getFixedEmbedderConfig,
    getRagSummarizerConfig,
    getDefaultRollingSummarizer,
    getDefaultMainModel,
    getAllTiers,
    requiresReindex
};

