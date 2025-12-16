#!/usr/bin/env node

/**
 * Configuration Loader for Middleware
 *
 * Loads and validates configuration from config.json.
 * 
 * RAG Pipeline (embedding + ragSummarization) is a CLOSED SYSTEM.
 * These configs come from rag_pipeline_config.js based on the active tier.
 * 
 * User-selectable models: main, rollingSummarization
 */

const fs = require('fs');
const path = require('path');
const { getRagPipelineConfig, getFixedEmbedderConfig, getEmbedderConfig, getRagSummarizerConfig } = require('./rag_pipeline_config.js');

const CONFIG_PATH = path.join(__dirname, '../config.json');

let configCache = null;

function readConfigFromDisk() {
    if (!fs.existsSync(CONFIG_PATH)) {
        throw new Error(`Configuration file not found at: ${CONFIG_PATH}`);
    }
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    return JSON.parse(raw);
}

function persistConfig(config) {
    validateConfig(config);
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    configCache = config;
    return configCache;
}

/**
 * Validate configuration structure.
 */
function validateConfig(config) {
    const requiredSections = ['lmstudio', 'models', 'processing', 'storage'];
    for (const section of requiredSections) {
        if (!config[section]) {
            throw new Error(`Missing required configuration section: ${section}`);
        }
    }

    // Validate LM Studio URL format
    if (config.lmstudio?.url) {
        try {
            new URL(config.lmstudio.url);
        } catch (e) {
            throw new Error(`Invalid LM Studio URL format: ${config.lmstudio.url}`);
        }
    }

    // User-selectable models only (embedding and ragSummarization come from RAG pipeline)
    const requiredUserModels = ['rollingSummarization', 'main'];
    for (const modelKey of requiredUserModels) {
        const model = config.models[modelKey];
        if (!model || !model.identifier) {
            throw new Error(`Missing identifier for user-selectable model: ${modelKey}`);
        }
    }

    // Validate RAG pipeline tier if present
    if (config.ragPipeline) {
        const validTiers = ['low', 'medium', 'high'];
        if (config.ragPipeline.tier && !validTiers.includes(config.ragPipeline.tier)) {
            throw new Error(`Invalid RAG pipeline tier: ${config.ragPipeline.tier}`);
        }
    }

    // Validate perQualityMainModels if present (should be an object with string values)
    if (config.models.perQualityMainModels) {
        if (typeof config.models.perQualityMainModels !== 'object') {
            throw new Error('perQualityMainModels must be an object');
        }
        const validKeys = ['high', 'medium', 'low'];
        for (const key of Object.keys(config.models.perQualityMainModels)) {
            if (!validKeys.includes(key)) {
                throw new Error(`Invalid perQualityMainModels key: ${key}`);
            }
            if (typeof config.models.perQualityMainModels[key] !== 'string') {
                throw new Error(`perQualityMainModels.${key} must be a string`);
            }
        }
    }

    // Validate perQualityRollingSummarizers if present (should be an object with string values)
    if (config.models.perQualityRollingSummarizers) {
        if (typeof config.models.perQualityRollingSummarizers !== 'object') {
            throw new Error('perQualityRollingSummarizers must be an object');
        }
        const validKeys = ['high', 'medium', 'low'];
        for (const key of Object.keys(config.models.perQualityRollingSummarizers)) {
            if (!validKeys.includes(key)) {
                throw new Error(`Invalid perQualityRollingSummarizers key: ${key}`);
            }
            if (typeof config.models.perQualityRollingSummarizers[key] !== 'string') {
                throw new Error(`perQualityRollingSummarizers.${key} must be a string`);
            }
        }
    }

    // Validate system settings
    if (config.system) {
        if (typeof config.system.autoLoadModels !== 'undefined' && typeof config.system.autoLoadModels !== 'boolean') {
            throw new Error('system.autoLoadModels must be a boolean');
        }
        if (typeof config.system.autoLoadDelayMs !== 'undefined' && typeof config.system.autoLoadDelayMs !== 'number') {
            throw new Error('system.autoLoadDelayMs must be a number');
        }
    }

    if (!config.lmstudio.url) {
        throw new Error('Missing LM Studio URL in configuration');
    }
}

/**
 * Load configuration from disk (cached after first load).
 */
function loadConfig() {
    if (configCache) return configCache;
    const parsed = readConfigFromDisk();
    validateConfig(parsed);
    configCache = parsed;
    return configCache;
}

function updateConfigFile(mutator) {
    const current = readConfigFromDisk();
    const draft = typeof mutator === 'function' ? mutator({ ...current }) : current;
    if (!draft) {
        throw new Error('Configuration update function must return a config object');
    }
    return persistConfig(draft);
}

function getConfig() {
    return loadConfig();
}

function getLMStudioConfig() {
    return loadConfig().lmstudio;
}

/**
 * Get model configuration for a role.
 * 
 * CLOSED SYSTEM: embedding and ragSummarization come from RAG pipeline tier.
 * USER SELECTABLE: main and rollingSummarization come from config.
 * 
 * @param {string} role - 'embedding' | 'ragSummarization' | 'rollingSummarization' | 'main'
 * @returns {Object} Model configuration
 */
function getModelConfig(role) {
    const cfg = loadConfig();
    const tier = cfg.ragPipeline?.tier || 'medium';
    
    // CLOSED RAG PIPELINE - These are NOT user configurable
    if (role === 'embedding') {
        // Use tier-specific embedder (not deprecated fixed config)
        const embedder = getEmbedderConfig(tier);
        return {
            ...embedder,
            engine: 'local',
            embedding_dimension: embedder.dimension
        };
    }
    
    if (role === 'ragSummarization') {
        const ragSum = getRagSummarizerConfig(tier);
        return {
            ...ragSum,
            engine: 'lmstudio'
        };
    }
    
    // USER SELECTABLE - These can be changed by user
    if (!cfg.models[role]) {
        throw new Error(`Model configuration not found for role: ${role}`);
    }
    return cfg.models[role];
}

/**
 * Get the current RAG pipeline tier
 * @returns {'low'|'medium'|'high'} Current tier
 */
function getRagPipelineTier() {
    const cfg = loadConfig();
    return cfg.ragPipeline?.tier || 'medium';
}

/**
 * Set the RAG pipeline tier (triggers re-index requirement)
 * @param {'low'|'medium'|'high'} tier 
 */
function setRagPipelineTier(tier) {
    const validTiers = ['low', 'medium', 'high'];
    if (!validTiers.includes(tier)) {
        throw new Error(`Invalid tier: ${tier}`);
    }
    
    updateConfigFile(cfg => {
        cfg.ragPipeline = cfg.ragPipeline || {};
        cfg.ragPipeline.tier = tier;
        cfg.ragPipeline.locked = true;
        return cfg;
    });
    
    console.log(`[Config] RAG pipeline tier changed to: ${tier}`);
}

function getProcessingConfig() {
    return loadConfig().processing;
}

function getStorageConfig() {
    return loadConfig().storage;
}

function getRuntimeConfig() {
    return loadConfig().runtime || { mode: 'local' };
}

function getSessionConfig() {
    return loadConfig().sessions || { default_retention_days: 30 };
}

/**
 * Get system settings for context limits, VRAM management, etc.
 * @returns {object} System settings with defaults
 */
function getSystemSettings() {
    const config = loadConfig();
    const defaults = {
        minMainContextTokens: 16384,
        summarizerContextTokens: 4096,
        maxContextCap: 131072,
        vramHeadroomGB: 1.5,
        dynamicContextScaling: true,
        filterBelowMinContext: true,
        autoBootstrapOnStartup: true,
        autoLoadModels: true,
        autoLoadDelayMs: 2000
    };
    return { ...defaults, ...(config.system || {}) };
}

/**
 * Update system settings
 * @param {object} settings - Partial settings to update
 */
function updateSystemSettings(settings) {
    const config = loadConfig();
    config.system = { ...getSystemSettings(), ...settings };
    updateConfigFile(config);
    return config.system;
}

/**
 * Force refresh the config cache from disk.
 * Use this after external changes to ensure all subsequent getConfig() calls return fresh data.
 */
function refreshConfig() {
    configCache = null;
    return loadConfig();
}

module.exports = {
    getConfig,
    getLMStudioConfig,
    getModelConfig,
    getProcessingConfig,
    getStorageConfig,
    getRuntimeConfig,
    getSessionConfig,
    getSystemSettings,
    updateSystemSettings,
    updateConfigFile,
    getRagPipelineTier,
    setRagPipelineTier,
    refreshConfig,
};

