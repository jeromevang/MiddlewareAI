/**
 * Model Presets Management
 * Handles preset operations and suggested models
 */

const { loadModelDatabase, saveModelDatabase } = require('./database.js');

/**
 * Get all presets
 * @returns {Object} All presets
 */
function getPresets() {
    const db = loadModelDatabase();
    return db.presets || {};
}

/**
 * Get a specific preset by quality tier
 * @param {string} quality - 'high', 'medium', or 'low'
 * @returns {Object|null} Preset
 */
function getPreset(quality) {
    const presets = getPresets();
    return presets[quality] || null;
}

/**
 * Update a preset
 * @param {string} quality - Preset quality tier
 * @param {Object} updates - Updates to apply
 * @returns {Object} Updated preset
 */
function updatePreset(quality, updates) {
    const db = loadModelDatabase();
    if (!db.presets[quality]) {
        throw new Error(`Preset '${quality}' not found`);
    }
    db.presets[quality] = { ...db.presets[quality], ...updates };
    saveModelDatabase(db);
    return db.presets[quality];
}

/**
 * Get suggested models
 * @returns {Array} Suggested models
 */
function getSuggestedModels() {
    const db = loadModelDatabase();
    return db.suggestedModels || [];
}

/**
 * Add a suggested model
 * @param {Object} model - Model to suggest
 */
function addSuggestedModel(model) {
    const db = loadModelDatabase();
    if (!db.suggestedModels) {
        db.suggestedModels = [];
    }
    
    // Check for duplicates
    const exists = db.suggestedModels.some(m => m.id === model.id);
    if (!exists) {
        db.suggestedModels.push({
            ...model,
            suggestedAt: new Date().toISOString()
        });
        saveModelDatabase(db);
    }
}

/**
 * Approve a suggested model (add to presets)
 * @param {string} modelId - Model ID to approve
 * @returns {Object} Result
 */
function approveModel(modelId) {
    const db = loadModelDatabase();
    const idx = db.suggestedModels?.findIndex(m => m.id === modelId) ?? -1;
    
    if (idx === -1) {
        return { success: false, message: 'Model not found in suggestions' };
    }
    
    const model = db.suggestedModels[idx];
    
    // Add to appropriate preset based on model tier
    const tier = model.tier || 'medium';
    if (!db.presets[tier].mainOptions.includes(modelId)) {
        db.presets[tier].mainOptions.push(modelId);
    }
    
    // Remove from suggestions
    db.suggestedModels.splice(idx, 1);
    saveModelDatabase(db);
    
    return { success: true, message: 'Model approved and added to preset' };
}

/**
 * Dismiss a suggested model
 * @param {string} modelId - Model ID to dismiss
 * @returns {Object} Result
 */
function dismissSuggestedModel(modelId) {
    const db = loadModelDatabase();
    const idx = db.suggestedModels?.findIndex(m => m.id === modelId) ?? -1;
    
    if (idx === -1) {
        return { success: false, message: 'Model not found in suggestions' };
    }
    
    db.suggestedModels.splice(idx, 1);
    saveModelDatabase(db);
    
    return { success: true, message: 'Model dismissed' };
}

/**
 * Re-rank preset models based on performance
 * @param {string} quality - Preset quality tier
 * @param {Array} rankedModelIds - Model IDs in ranked order
 * @returns {Object} Updated preset
 */
function reRankPresetModels(quality, rankedModelIds) {
    const db = loadModelDatabase();
    if (!db.presets[quality]) {
        throw new Error(`Preset '${quality}' not found`);
    }
    
    db.presets[quality].mainOptions = rankedModelIds;
    saveModelDatabase(db);
    
    return db.presets[quality];
}

module.exports = {
    getPresets,
    getPreset,
    updatePreset,
    getSuggestedModels,
    addSuggestedModel,
    approveModel,
    dismissSuggestedModel,
    reRankPresetModels
};
