/**
 * Models Module Index
 * Re-exports all model-related functionality for backwards compatibility
 */

// Database operations
const {
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
} = require('./database.js');

// Preset management
const {
    getPresets,
    getPreset,
    updatePreset,
    getSuggestedModels,
    addSuggestedModel,
    approveModel,
    dismissSuggestedModel,
    reRankPresetModels
} = require('./presets.js');

// Model ID matching
const {
    normalizeModelIdForMatching,
    extractModelTokens,
    tokenOverlapScore,
    findLMStudioModelId
} = require('./matcher.js');

// Downloading
const {
    getDownloadedModels,
    getDownloadStatus,
    getActiveDownloads,
    downloadModel
} = require('./downloader.js');

module.exports = {
    // Database
    MODELS_DB_PATH,
    createDefaultDatabase,
    loadModelDatabase,
    saveModelDatabase,
    invalidateCache,
    getModelSpec,
    getAllModelSpecs,
    getModelsByType,
    getLastActiveModel,
    setActiveModel,
    
    // Presets
    getPresets,
    getPreset,
    updatePreset,
    getSuggestedModels,
    addSuggestedModel,
    approveModel,
    dismissSuggestedModel,
    reRankPresetModels,
    
    // Matching
    normalizeModelIdForMatching,
    extractModelTokens,
    tokenOverlapScore,
    findLMStudioModelId,
    
    // Downloading
    getDownloadedModels,
    getDownloadStatus,
    getActiveDownloads,
    downloadModel
};
