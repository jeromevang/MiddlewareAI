#!/usr/bin/env node

/**
 * Model Sync Service
 * 
 * Syncs models from LM Studio using `lms ls --json` and categorizes them
 * by function (main/summarizer/embedder) and quality tier (low/medium/high).
 */

const { exec } = require('child_process');
const { promisify } = require('util');
const { getLMStudioCLIPath } = require('../lmstudio_manager.js');
const { getPresetVRAMBudget } = require('../hardware_detector.js');
const { getSystemSettings } = require('../config.js');

const execAsync = promisify(exec);

// Cache for synced models
let syncedModelsCache = null;
let lastSyncTime = 0;
const CACHE_TTL_MS = 60000; // 1 minute

/**
 * Role-specific inference defaults
 */
const ROLE_DEFAULTS = {
    main: {
        temperature: 0.4,
        topP: 0.9,
        topK: 40,
        repeatPenalty: 1.1,
        gpu: 'max',
        maxTokens: -1,
        contextLength: 32768  // Default 32K context for main model - can be overridden per-model
    },
    summarizer: {
        temperature: 0,
        topP: 0.5,
        topK: 20,
        repeatPenalty: 1.2,
        gpu: 0.3,
        maxTokens: 500,
        contextLength: 4096
    },
    embedder: {
        gpu: 'off',
        contextLength: 8192  // Jina code embedder supports 8K
    }
};

/**
 * Get role defaults for a specific role (reads context lengths from system settings)
 * @param {string} role - 'main', 'summarizer', or 'embedder'
 * @returns {object}
 */
function getRoleDefaults(role) {
    const settings = getSystemSettings();
    const defaults = { ...ROLE_DEFAULTS[role] } || { ...ROLE_DEFAULTS.summarizer };
    
    // Override context lengths from system settings
    if (role === 'main') {
        // Main model uses minimum as baseline, can be scaled up dynamically
        defaults.contextLength = settings.minMainContextTokens || 16384;
    } else if (role === 'summarizer') {
        defaults.contextLength = settings.summarizerContextTokens || 4096;
    }
    
    return defaults;
}

/**
 * Fetch models from LM Studio using CLI
 * @returns {Promise<Array>} Raw model list from LM Studio
 */
async function fetchModelsFromLMStudio() {
    try {
        const cliPath = getLMStudioCLIPath();
        const { stdout } = await execAsync(`"${cliPath}" ls --json`, {
            timeout: 30000,
            encoding: 'utf8',
            maxBuffer: 10 * 1024 * 1024 // 10MB buffer for large model lists
        });
        
        const models = JSON.parse(stdout);
        console.log(`[ModelSync] Fetched ${models.length} models from LM Studio`);
        return models;
    } catch (error) {
        console.error('[ModelSync] Failed to fetch models from LM Studio:', error.message);
        return [];
    }
}

/**
 * Determine the function/role of a model based on its properties
 * @param {object} model - Model from LM Studio
 * @returns {'main' | 'summarizer' | 'embedder' | 'excluded'}
 */
function determineModelFunction(model) {
    const settings = getSystemSettings();
    const minMainContext = settings.minMainContextTokens || 16384;
    const filterBelowMin = settings.filterBelowMinContext !== false;
    
    // Embeddings are clearly marked
    if (model.type === 'embedding') {
        return 'embedder';
    }
    
    // Check if model meets minimum context requirement for main role
    const modelMaxContext = model.maxContextLength || 4096;
    const meetsMinContext = modelMaxContext >= minMainContext;
    
    // Models with tool use capability are best for main role (if they meet context requirement)
    if (model.trainedForToolUse && meetsMinContext) {
        return 'main';
    }
    
    // If model doesn't meet minimum context and filtering is enabled, it can only be summarizer
    if (filterBelowMin && !meetsMinContext) {
        // Small context models can still be summarizers (they only need 4K)
        if (modelMaxContext >= 4096) {
            return 'summarizer';
        }
        // Models with less than 4K context are excluded
        console.log(`[ModelSync] Excluding model ${model.path || model.modelKey}: context ${modelMaxContext} < 4096`);
        return 'excluded';
    }
    
    // Default to summarizer for other LLMs
    return 'summarizer';
}

/**
 * Determine which quality tiers a model fits in based on size
 * @param {object} model - Model with sizeBytes
 * @returns {string[]} Array of tier names the model fits in
 */
function determineModelTiers(model) {
    const sizeGB = (model.sizeBytes || 0) / (1024 * 1024 * 1024);
    const tiers = [];
    
    // Get budget limits for each tier
    const lowBudget = getPresetVRAMBudget('low');
    const medBudget = getPresetVRAMBudget('medium');
    const highBudget = getPresetVRAMBudget('high');
    
    // Model fits in a tier if it leaves room for other models
    if (sizeGB <= lowBudget.maxMainModelGB) {
        tiers.push('low', 'medium', 'high');
    } else if (sizeGB <= medBudget.maxMainModelGB) {
        tiers.push('medium', 'high');
    } else if (sizeGB <= highBudget.maxMainModelGB) {
        tiers.push('high');
    }
    // Models larger than high tier max don't fit any preset
    
    return tiers;
}

/**
 * Quantization quality tiers
 */
const QUANT_QUALITY = {
    8: { tier: 'excellent', minBits: 8, label: 'Q8', reliable: true },
    6: { tier: 'very_good', minBits: 6, label: 'Q6', reliable: true },
    5: { tier: 'good', minBits: 5, label: 'Q5', reliable: true },
    4: { tier: 'acceptable', minBits: 4, label: 'Q4', reliable: true },
    3: { tier: 'degraded', minBits: 3, label: 'Q3', reliable: false },
    2: { tier: 'poor', minBits: 2, label: 'Q2', reliable: false },
    1: { tier: 'very_poor', minBits: 1, label: 'Q1', reliable: false }
};

/**
 * Get quantization quality info
 * @param {object} model - Model object
 * @returns {object} Quantization quality info
 */
function getQuantQuality(model) {
    const bits = model.quantization?.bits || 4;
    const quality = QUANT_QUALITY[bits] || QUANT_QUALITY[4];
    return {
        bits,
        ...quality,
        isReliableForTools: bits >= 4
    };
}

/**
 * Calculate agentic score (0-100)
 * Higher = better for agentic/tool-calling tasks
 * @param {object} model - Model object
 * @returns {number} Score 0-100
 */
function calculateAgenticScore(model) {
    let score = 0;
    
    // Tool use support is critical (40 points)
    if (model.trainedForToolUse) score += 40;
    
    // Quantization quality (25 points max)
    const bits = model.quantization?.bits || 4;
    if (bits >= 6) score += 25;
    else if (bits >= 5) score += 20;
    else if (bits >= 4) score += 15;
    else if (bits >= 3) score += 5;
    // Q2 and below get 0 points
    
    // Context length (20 points max)
    const ctx = model.maxContextLength || 4096;
    if (ctx >= 32768) score += 20;
    else if (ctx >= 16384) score += 15;
    else if (ctx >= 8192) score += 10;
    else if (ctx >= 4096) score += 5;
    
    // Model size for reasoning capability (15 points max)
    const params = parseParamSize(model.paramsString);
    if (params >= 30) score += 15;
    else if (params >= 13) score += 12;
    else if (params >= 7) score += 10;
    else if (params >= 3) score += 5;
    
    return Math.min(100, score);
}

/**
 * Determine model's role badge
 * @param {object} model - Model object
 * @returns {string} Role badge: 'agentic', 'toolUse', 'chat', 'summarizer', 'embedder'
 */
function getModelRoleBadge(model) {
    // Embedding models
    if (model.type === 'embedding') return 'embedder';
    
    const agenticScore = calculateAgenticScore(model);
    const quantBits = model.quantization?.bits || 4;
    
    // Full agentic: tool support + good quant + good context
    if (model.trainedForToolUse && quantBits >= 4 && agenticScore >= 70) {
        return 'agentic';
    }
    
    // Has tool use but limited (low quant or context)
    if (model.trainedForToolUse && quantBits >= 4) {
        return 'toolUse';
    }
    
    // Small/fast models good for summarization
    const params = parseParamSize(model.paramsString);
    if (params > 0 && params <= 3) {
        return 'summarizer';
    }
    
    // Default to chat
    return 'chat';
}

/**
 * Check if model is suitable for main/agentic role
 * @param {object} model - Model object
 * @returns {{suitable: boolean, reason: string}}
 */
function isAgenticViable(model) {
    const quantBits = model.quantization?.bits || 4;
    const ctx = model.maxContextLength || 4096;
    
    if (model.type === 'embedding') {
        return { suitable: false, reason: 'Embedding model cannot be used for chat' };
    }
    
    if (!model.trainedForToolUse) {
        return { suitable: false, reason: 'Model not trained for tool use' };
    }
    
    if (quantBits < 4) {
        return { suitable: false, reason: `Quantization too low (Q${quantBits}) - unreliable for tool calling` };
    }
    
    if (ctx < 8192) {
        return { suitable: false, reason: 'Context too small for agentic tasks' };
    }
    
    return { suitable: true, reason: 'Model is suitable for agentic tasks' };
}

/**
 * Generate capability badges for a model
 * @param {object} model - Model from LM Studio
 * @returns {string[]} Array of capability badge keys
 */
function getModelCapabilities(model) {
    const capabilities = [];
    
    if (model.trainedForToolUse) capabilities.push('toolUse');
    if (model.vision) capabilities.push('vision');
    if (model.maxContextLength > 32768) capabilities.push('longContext');
    if (model.type === 'embedding') capabilities.push('embedding');
    
    // Quantization quality
    const bits = model.quantization?.bits || 4;
    if (bits >= 6) capabilities.push('highQuality');
    else if (bits >= 4) capabilities.push('goodQuality');
    else capabilities.push('lowQuality');
    
    // Check if it's a small/fast model
    const params = parseFloat(model.paramsString) || 0;
    if (params > 0 && params < 3) capabilities.push('fast');
    
    return capabilities;
}

/**
 * Parse parameter string to number (e.g., "7B" -> 7, "1.5B" -> 1.5)
 * @param {string} paramsString 
 * @returns {number}
 */
function parseParamSize(paramsString) {
    if (!paramsString) return 0;
    const match = paramsString.match(/^([\d.]+)/);
    return match ? parseFloat(match[1]) : 0;
}

/**
 * Categorize a single model
 * @param {object} model - Raw model from LM Studio
 * @returns {object} Categorized model
 */
function categorizeModel(model) {
    const sizeGB = (model.sizeBytes || 0) / (1024 * 1024 * 1024);
    const func = determineModelFunction(model);
    const tiers = determineModelTiers(model);
    const capabilities = getModelCapabilities(model);
    const paramSize = parseParamSize(model.paramsString);
    const agenticScore = calculateAgenticScore(model);
    const roleBadge = getModelRoleBadge(model);
    const quantQuality = getQuantQuality(model);
    const agenticViability = isAgenticViable(model);
    
    return {
        // Core identification - modelKey is the canonical ID
        modelKey: model.modelKey,
        displayName: model.displayName,
        publisher: model.publisher,
        
        // Classification
        function: func,
        tiers,
        capabilities,
        
        // Agentic/capability info
        agenticScore,
        roleBadge, // 'agentic', 'toolUse', 'chat', 'summarizer', 'embedder'
        agenticViable: agenticViability.suitable,
        agenticViableReason: agenticViability.reason,
        
        // Quantization quality
        quantQuality: quantQuality.tier,
        quantLabel: quantQuality.label,
        quantBits: quantQuality.bits,
        reliableForTools: quantQuality.isReliableForTools,
        
        // Size info
        sizeGB: Math.round(sizeGB * 100) / 100,
        paramsString: model.paramsString,
        paramSize,
        
        // Technical details
        architecture: model.architecture,
        format: model.format,
        maxContextLength: model.maxContextLength,
        quantization: model.quantization,
        
        // Feature flags
        trainedForToolUse: model.trainedForToolUse || false,
        vision: model.vision || false,
        
        // Full path for reference
        path: model.path,
        
        // Inference defaults based on function
        inferenceDefaults: getRoleDefaults(func)
    };
}

/**
 * Sync models from LM Studio and categorize them
 * @param {boolean} forceRefresh - Force refresh even if cache is valid
 * @returns {Promise<{models: object[], byFunction: object, byTier: object, lastSync: number}>}
 */
async function syncModels(forceRefresh = false) {
    const now = Date.now();
    
    // Return cached data if still valid
    if (!forceRefresh && syncedModelsCache && (now - lastSyncTime) < CACHE_TTL_MS) {
        return syncedModelsCache;
    }
    
    console.log('[ModelSync] Syncing models from LM Studio...');
    
    const rawModels = await fetchModelsFromLMStudio();
    const models = rawModels.map(categorizeModel);
    
    // Group by function
    const byFunction = {
        main: models.filter(m => m.function === 'main'),
        summarizer: models.filter(m => m.function === 'summarizer'),
        embedder: models.filter(m => m.function === 'embedder')
    };
    
    // Group by tier
    const byTier = {
        low: models.filter(m => m.tiers.includes('low')),
        medium: models.filter(m => m.tiers.includes('medium')),
        high: models.filter(m => m.tiers.includes('high'))
    };
    
    // Sort each group by size (smaller first for faster models)
    Object.values(byFunction).forEach(arr => arr.sort((a, b) => a.sizeGB - b.sizeGB));
    Object.values(byTier).forEach(arr => arr.sort((a, b) => a.sizeGB - b.sizeGB));
    
    syncedModelsCache = {
        models,
        byFunction,
        byTier,
        lastSync: now,
        count: {
            total: models.length,
            main: byFunction.main.length,
            summarizer: byFunction.summarizer.length,
            embedder: byFunction.embedder.length
        }
    };
    
    lastSyncTime = now;
    
    console.log(`[ModelSync] Synced ${models.length} models: ${byFunction.main.length} main, ${byFunction.summarizer.length} summarizer, ${byFunction.embedder.length} embedder`);
    
    return syncedModelsCache;
}

/**
 * Get a model by its modelKey
 * @param {string} modelKey - The exact modelKey from LM Studio
 * @returns {Promise<object | null>}
 */
async function getModelByKey(modelKey) {
    const { models } = await syncModels();
    return models.find(m => m.modelKey === modelKey) || null;
}

/**
 * Get models suitable for a specific role and tier
 * @param {string} role - 'main', 'summarizer', or 'embedder'
 * @param {string} tier - 'low', 'medium', or 'high'
 * @returns {Promise<object[]>}
 */
async function getModelsForRoleAndTier(role, tier) {
    const { byFunction, byTier } = await syncModels();
    
    // Get models that match both role and tier
    const roleModels = byFunction[role] || [];
    const tierModels = new Set((byTier[tier] || []).map(m => m.modelKey));
    
    return roleModels.filter(m => tierModels.has(m.modelKey));
}

/**
 * Suggest optimal models for a preset
 * @param {string} tier - 'low', 'medium', or 'high'
 * @returns {Promise<{main: object|null, summarizer: object|null, embedder: object|null}>}
 */
async function suggestModelsForPreset(tier) {
    const mainModels = await getModelsForRoleAndTier('main', tier);
    const summarizerModels = await getModelsForRoleAndTier('summarizer', tier);
    const embedderModels = await getModelsForRoleAndTier('embedder', tier);
    
    // Prefer models with tool use for main
    const mainWithTools = mainModels.filter(m => m.trainedForToolUse);
    const bestMain = mainWithTools[0] || mainModels[0] || null;
    
    // Prefer smaller models for summarizer (faster)
    const bestSummarizer = summarizerModels[0] || null;
    
    // First embedder available
    const bestEmbedder = embedderModels[0] || null;
    
    return {
        main: bestMain,
        summarizer: bestSummarizer,
        embedder: bestEmbedder
    };
}

/**
 * Invalidate the sync cache
 */
function invalidateSyncCache() {
    syncedModelsCache = null;
    lastSyncTime = 0;
}

/**
 * Get the role defaults configuration
 * @returns {object}
 */
function getAllRoleDefaults() {
    return ROLE_DEFAULTS;
}

module.exports = {
    syncModels,
    getModelByKey,
    getModelsForRoleAndTier,
    suggestModelsForPreset,
    categorizeModel,
    determineModelFunction,
    determineModelTiers,
    getModelCapabilities,
    getRoleDefaults,
    getAllRoleDefaults,
    invalidateSyncCache,
    ROLE_DEFAULTS,
    // New agentic/capability functions
    calculateAgenticScore,
    getModelRoleBadge,
    isAgenticViable,
    getQuantQuality,
    QUANT_QUALITY
};

