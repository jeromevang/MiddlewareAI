/**
 * Model Database - Core CRUD operations
 * Handles loading, saving, and basic operations on models.json
 */

const fs = require('fs');
const path = require('path');

const MODELS_DB_PATH = path.join(__dirname, '../../data/models.json');

let modelsCache = null;

/**
 * Create default database structure
 * @returns {Object} Default database
 */
function createDefaultDatabase() {
    return {
        version: '1.0.0',
        lastUpdated: new Date().toISOString(),
        lastLLMCheck: null,
        lastActiveModel: null,
        presets: {
            high: {
                name: 'High Quality',
                description: 'Best quality for complex tasks',
                embedding: 'Xenova/all-MiniLM-L6-v2',
                ragSummarizer: null,
                rollingSummarizer: null,
                mainOptions: []
            },
            medium: {
                name: 'Balanced',
                description: 'Good balance of quality and speed',
                embedding: 'Xenova/all-MiniLM-L6-v2',
                ragSummarizer: null,
                rollingSummarizer: null,
                mainOptions: []
            },
            low: {
                name: 'Fast & Lightweight',
                description: 'Fastest inference, minimal VRAM',
                embedding: 'Xenova/all-MiniLM-L6-v2',
                ragSummarizer: null,
                rollingSummarizer: null,
                mainOptions: []
            }
        },
        modelSpecs: {},
        suggestedModels: []
    };
}

/**
 * Load the models database from disk
 * @returns {Object} Models database
 */
function loadModelDatabase() {
    if (modelsCache) return modelsCache;
    
    if (!fs.existsSync(MODELS_DB_PATH)) {
        console.warn('[ModelDB] models.json not found, creating default...');
        const defaultDb = createDefaultDatabase();
        saveModelDatabase(defaultDb);
        return defaultDb;
    }
    
    try {
        const raw = fs.readFileSync(MODELS_DB_PATH, 'utf8');
        modelsCache = JSON.parse(raw);
        return modelsCache;
    } catch (error) {
        console.error('[ModelDB] Failed to load models.json:', error.message);
        throw error;
    }
}

/**
 * Save the models database to disk
 * @param {Object} db - Database to save
 * @returns {Object} Saved database
 */
function saveModelDatabase(db) {
    try {
        db.lastUpdated = new Date().toISOString();
        fs.writeFileSync(MODELS_DB_PATH, JSON.stringify(db, null, 2));
        modelsCache = db;
        console.log('[ModelDB] Database saved successfully');
        return db;
    } catch (error) {
        console.error('[ModelDB] Failed to save models.json:', error.message);
        throw error;
    }
}

/**
 * Invalidate the cache to force reload
 */
function invalidateCache() {
    modelsCache = null;
}

/**
 * Get model spec by ID
 * @param {string} modelId - Model ID
 * @returns {Object|null} Model spec
 */
function getModelSpec(modelId) {
    const db = loadModelDatabase();
    return db.modelSpecs?.[modelId] || null;
}

/**
 * Get all model specs
 * @returns {Object} All model specs
 */
function getAllModelSpecs() {
    const db = loadModelDatabase();
    return db.modelSpecs || {};
}

/**
 * Get models by type
 * @param {string} type - Model type
 * @returns {Array} Models of the specified type
 */
function getModelsByType(type) {
    const specs = getAllModelSpecs();
    return Object.entries(specs)
        .filter(([_, spec]) => spec.type === type)
        .map(([id, spec]) => ({ id, ...spec }));
}

/**
 * Get the last active model
 * @returns {string|null} Last active model ID
 */
function getLastActiveModel() {
    const db = loadModelDatabase();
    return db.lastActiveModel || null;
}

/**
 * Set the active model
 * @param {string} modelId - Model ID to set as active
 * @returns {string} The set model ID
 */
function setActiveModel(modelId) {
    const db = loadModelDatabase();
    db.lastActiveModel = modelId;
    saveModelDatabase(db);
    return modelId;
}

module.exports = {
    MODELS_DB_PATH,
    createDefaultDatabase,
    loadModelDatabase,
    saveModelDatabase,
    invalidateCache,
    getModelSpec,
    getAllModelSpecs,
    getModelsByType,
    getLastActiveModel,
    setActiveModel
};
