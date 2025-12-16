/**
 * Recommended Models Registry
 * 
 * Curated list of models recommended for each role and quality tier.
 * These models are known to work well with the middleware and LM Studio.
 */

/**
 * Recommended models by role and tier
 * Each entry includes:
 * - id: Hugging Face model ID or LM Studio registry ID
 * - quant: Recommended quantization (Q4_K_M is a good balance)
 * - reason: Why this model is recommended
 * - sizeGB: Approximate size in GB (for VRAM planning)
 * - minVRAM: Minimum VRAM required in GB
 */
const RECOMMENDED_MODELS = {
    main: {
        high: [
            { 
                id: 'meta-llama/Llama-3.3-70B-Instruct-GGUF', 
                quant: 'Q4_K_M', 
                reason: 'Best overall performance, excellent reasoning',
                sizeGB: 42,
                minVRAM: 24
            },
            { 
                id: 'Qwen/Qwen2.5-72B-Instruct-GGUF', 
                quant: 'Q4_K_M', 
                reason: 'Excellent coding and multilingual support',
                sizeGB: 44,
                minVRAM: 24
            },
            { 
                id: 'deepseek-ai/DeepSeek-V3-GGUF', 
                quant: 'Q4_K_M', 
                reason: 'State-of-the-art reasoning, competitive with GPT-4',
                sizeGB: 40,
                minVRAM: 24
            }
        ],
        medium: [
            { 
                id: 'Qwen/Qwen2.5-7B-Instruct-GGUF', 
                quant: 'Q4_K_M', 
                reason: 'Great balance of speed and quality',
                sizeGB: 4.5,
                minVRAM: 6
            },
            { 
                id: 'deepseek-ai/DeepSeek-Coder-V2-Lite-Instruct-GGUF', 
                quant: 'Q4_K_M', 
                reason: 'Optimized for code, fast inference',
                sizeGB: 5,
                minVRAM: 6
            },
            { 
                id: 'mistralai/Mistral-7B-Instruct-v0.3-GGUF', 
                quant: 'Q4_K_M', 
                reason: 'Reliable, well-tested model',
                sizeGB: 4.5,
                minVRAM: 6
            },
            { 
                id: 'Qwen/Qwen2.5-Coder-7B-Instruct-GGUF', 
                quant: 'Q4_K_M', 
                reason: 'Excellent code completion and understanding',
                sizeGB: 4.5,
                minVRAM: 6
            }
        ],
        low: [
            { 
                id: 'Qwen/Qwen2.5-3B-Instruct-GGUF', 
                quant: 'Q4_K_M', 
                reason: 'Fast and capable for basic tasks',
                sizeGB: 2,
                minVRAM: 4
            },
            { 
                id: 'microsoft/Phi-3-mini-4k-instruct-GGUF', 
                quant: 'Q4_K_M', 
                reason: 'Microsoft\'s efficient small model',
                sizeGB: 2.5,
                minVRAM: 4
            }
        ]
    },
    summarizer: {
        // Summarizers should always be small and fast - same for all tiers
        all: [
            { 
                id: 'Qwen/Qwen2.5-0.5B-Instruct-GGUF', 
                quant: 'Q8_0', 
                reason: 'Tiny but capable, perfect for summarization',
                sizeGB: 0.5,
                minVRAM: 1
            },
            { 
                id: 'Qwen/Qwen2.5-Coder-0.5B-Instruct-GGUF', 
                quant: 'Q8_0', 
                reason: 'Code-aware summarization',
                sizeGB: 0.5,
                minVRAM: 1
            },
            { 
                id: 'Qwen/Qwen2.5-1.5B-Instruct-GGUF', 
                quant: 'Q4_K_M', 
                reason: 'Slightly larger for better quality summaries',
                sizeGB: 1,
                minVRAM: 2
            }
        ]
    },
    embedder: {
        // Embedders are fixed per tier in the RAG pipeline
        all: [
            { 
                id: 'jinaai/jina-embeddings-v2-base-code', 
                quant: null, 
                reason: 'Best code embeddings, understands functions',
                sizeGB: 0.3,
                minVRAM: 1
            },
            { 
                id: 'nomic-ai/nomic-embed-text-v1.5-GGUF', 
                quant: 'Q8_0', 
                reason: 'Great general-purpose embeddings',
                sizeGB: 0.3,
                minVRAM: 1
            }
        ]
    }
};

/**
 * Essential models that should always be available
 * These are downloaded if the user has no models at all
 */
const ESSENTIAL_MODELS = {
    high: [
        { id: 'Qwen/Qwen2.5-72B-Instruct-GGUF', quant: 'Q4_K_M', role: 'main' },
        { id: 'Qwen/Qwen2.5-0.5B-Instruct-GGUF', quant: 'Q8_0', role: 'summarizer' }
    ],
    medium: [
        { id: 'Qwen/Qwen2.5-7B-Instruct-GGUF', quant: 'Q4_K_M', role: 'main' },
        { id: 'Qwen/Qwen2.5-0.5B-Instruct-GGUF', quant: 'Q8_0', role: 'summarizer' }
    ],
    low: [
        { id: 'Qwen/Qwen2.5-3B-Instruct-GGUF', quant: 'Q4_K_M', role: 'main' },
        { id: 'Qwen/Qwen2.5-0.5B-Instruct-GGUF', quant: 'Q8_0', role: 'summarizer' }
    ]
};

/**
 * Get recommended models for a specific role and tier
 * @param {'main' | 'summarizer' | 'embedder'} role 
 * @param {'high' | 'medium' | 'low'} tier 
 * @returns {Array<{id: string, quant: string, reason: string, sizeGB: number, minVRAM: number}>}
 */
function getRecommendedModels(role, tier) {
    const roleModels = RECOMMENDED_MODELS[role];
    if (!roleModels) return [];
    
    // Summarizer and embedder use 'all' regardless of tier
    if (role === 'summarizer' || role === 'embedder') {
        return roleModels.all || [];
    }
    
    return roleModels[tier] || roleModels.medium || [];
}

/**
 * Get essential models for a tier (for initial download)
 * @param {'high' | 'medium' | 'low'} tier 
 * @returns {Array<{id: string, quant: string, role: string}>}
 */
function getEssentialModels(tier) {
    return ESSENTIAL_MODELS[tier] || ESSENTIAL_MODELS.medium;
}

/**
 * Check if a model ID matches any recommended model
 * @param {string} modelId 
 * @returns {boolean}
 */
function isRecommendedModel(modelId) {
    if (!modelId) return false;
    const lower = modelId.toLowerCase();
    
    for (const role of Object.keys(RECOMMENDED_MODELS)) {
        const roleModels = RECOMMENDED_MODELS[role];
        const allModels = roleModels.all || [
            ...(roleModels.high || []),
            ...(roleModels.medium || []),
            ...(roleModels.low || [])
        ];
        
        for (const model of allModels) {
            if (lower.includes(model.id.toLowerCase().split('/').pop())) {
                return true;
            }
        }
    }
    
    return false;
}

/**
 * Get all unique recommended model IDs across all tiers
 * @returns {Array<string>}
 */
function getAllRecommendedModelIds() {
    const ids = new Set();
    
    for (const role of Object.keys(RECOMMENDED_MODELS)) {
        const roleModels = RECOMMENDED_MODELS[role];
        const allModels = roleModels.all || [
            ...(roleModels.high || []),
            ...(roleModels.medium || []),
            ...(roleModels.low || [])
        ];
        
        for (const model of allModels) {
            ids.add(model.id);
        }
    }
    
    return Array.from(ids);
}

module.exports = {
    RECOMMENDED_MODELS,
    ESSENTIAL_MODELS,
    getRecommendedModels,
    getEssentialModels,
    isRecommendedModel,
    getAllRecommendedModelIds
};

