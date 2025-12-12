#!/usr/bin/env node

/**
 * Configuration Loader for Middleware
 *
 * Loads and validates configuration from config.json.
 */

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '../config.json');

let configCache = null;

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

    const requiredModels = ['embedding', 'summarization', 'main'];
    for (const modelKey of requiredModels) {
        const model = config.models[modelKey];
        if (!model || !model.identifier) {
            throw new Error(`Missing identifier for model: ${modelKey}`);
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

    if (!fs.existsSync(CONFIG_PATH)) {
        throw new Error(`Configuration file not found at: ${CONFIG_PATH}`);
    }

    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    validateConfig(parsed);
    configCache = parsed;
    return configCache;
}

function getConfig() {
    return loadConfig();
}

function getLMStudioConfig() {
    return loadConfig().lmstudio;
}

function getModelConfig(role) {
    const cfg = loadConfig();
    if (!cfg.models[role]) {
        throw new Error(`Model configuration not found for role: ${role}`);
    }
    return cfg.models[role];
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

module.exports = {
    getConfig,
    getLMStudioConfig,
    getModelConfig,
    getProcessingConfig,
    getStorageConfig,
    getRuntimeConfig,
    getSessionConfig,
};

