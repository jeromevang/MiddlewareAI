/**
 * Model Lock Service
 * 
 * Manages lock states to prevent:
 * - Loaded models from being unloaded during preset switches
 * - Preset models from being replaced during auto-discovery/bootstrap
 */

const fs = require('fs');
const path = require('path');

const LOCKS_FILE = path.join(__dirname, '../data/model_locks.json');

// In-memory cache of locks
let locksCache = null;

/**
 * Load locks from file
 * @returns {Object} - Lock data structure
 */
function loadLocks() {
    if (locksCache) {
        return locksCache;
    }
    
    try {
        if (fs.existsSync(LOCKS_FILE)) {
            const data = fs.readFileSync(LOCKS_FILE, 'utf-8');
            locksCache = JSON.parse(data);
        } else {
            locksCache = { lockedModels: {} };
        }
    } catch (error) {
        console.warn('[Lock Service] Error loading locks file:', error.message);
        locksCache = { lockedModels: {} };
    }
    
    return locksCache;
}

/**
 * Save locks to file
 */
function saveLocks() {
    try {
        const dir = path.dirname(LOCKS_FILE);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(LOCKS_FILE, JSON.stringify(locksCache, null, 2));
    } catch (error) {
        console.error('[Lock Service] Error saving locks:', error.message);
    }
}

/**
 * Lock a model
 * @param {string} modelId - Model identifier
 * @param {Object} options - Lock options
 * @param {boolean} options.loaded - Prevent unloading
 * @param {boolean} options.preset - Prevent preset replacement
 * @returns {Object} - Updated lock state for the model
 */
function lockModel(modelId, options = { loaded: true, preset: true }) {
    const locks = loadLocks();
    
    if (!locks.lockedModels[modelId]) {
        locks.lockedModels[modelId] = {};
    }
    
    if (options.loaded !== undefined) {
        locks.lockedModels[modelId].loaded = options.loaded;
    }
    if (options.preset !== undefined) {
        locks.lockedModels[modelId].preset = options.preset;
    }
    
    // Add timestamp
    locks.lockedModels[modelId].lockedAt = new Date().toISOString();
    
    saveLocks();
    
    console.log(`[Lock Service] Locked model: ${modelId}`, locks.lockedModels[modelId]);
    return locks.lockedModels[modelId];
}

/**
 * Unlock a model
 * @param {string} modelId - Model identifier
 * @param {Object} options - Unlock options
 * @param {boolean} options.loaded - Remove unload lock
 * @param {boolean} options.preset - Remove preset lock
 * @returns {Object|null} - Updated lock state or null if fully unlocked
 */
function unlockModel(modelId, options = { loaded: true, preset: true }) {
    const locks = loadLocks();
    
    if (!locks.lockedModels[modelId]) {
        return null;
    }
    
    if (options.loaded) {
        delete locks.lockedModels[modelId].loaded;
    }
    if (options.preset) {
        delete locks.lockedModels[modelId].preset;
    }
    
    // Remove model entirely if no locks remain
    const remaining = locks.lockedModels[modelId];
    if (!remaining.loaded && !remaining.preset) {
        delete locks.lockedModels[modelId];
        saveLocks();
        console.log(`[Lock Service] Fully unlocked model: ${modelId}`);
        return null;
    }
    
    saveLocks();
    console.log(`[Lock Service] Partially unlocked model: ${modelId}`, remaining);
    return remaining;
}

/**
 * Check if a model is locked for unloading
 * @param {string} modelId - Model identifier
 * @returns {boolean}
 */
function isLoadLocked(modelId) {
    const locks = loadLocks();
    return locks.lockedModels[modelId]?.loaded === true;
}

/**
 * Check if a model is locked for preset changes
 * @param {string} modelId - Model identifier
 * @returns {boolean}
 */
function isPresetLocked(modelId) {
    const locks = loadLocks();
    return locks.lockedModels[modelId]?.preset === true;
}

/**
 * Get lock state for a specific model
 * @param {string} modelId - Model identifier
 * @returns {Object|null}
 */
function getModelLock(modelId) {
    const locks = loadLocks();
    return locks.lockedModels[modelId] || null;
}

/**
 * Get all locked models
 * @returns {Object} - Map of modelId to lock state
 */
function getAllLocks() {
    const locks = loadLocks();
    return locks.lockedModels;
}

/**
 * Get all models locked for unloading
 * @returns {string[]} - Array of model IDs
 */
function getLoadLockedModels() {
    const locks = loadLocks();
    return Object.entries(locks.lockedModels)
        .filter(([_, state]) => state.loaded === true)
        .map(([id, _]) => id);
}

/**
 * Get all models locked for preset changes
 * @returns {string[]} - Array of model IDs
 */
function getPresetLockedModels() {
    const locks = loadLocks();
    return Object.entries(locks.lockedModels)
        .filter(([_, state]) => state.preset === true)
        .map(([id, _]) => id);
}

/**
 * Toggle lock for a model (convenience function)
 * @param {string} modelId - Model identifier
 * @param {string} lockType - 'loaded', 'preset', or 'both'
 * @returns {Object} - New lock state
 */
function toggleLock(modelId, lockType = 'both') {
    const current = getModelLock(modelId);
    
    if (lockType === 'loaded') {
        if (current?.loaded) {
            return unlockModel(modelId, { loaded: true, preset: false });
        } else {
            return lockModel(modelId, { loaded: true, preset: false });
        }
    } else if (lockType === 'preset') {
        if (current?.preset) {
            return unlockModel(modelId, { loaded: false, preset: true });
        } else {
            return lockModel(modelId, { loaded: false, preset: true });
        }
    } else {
        // Toggle both
        if (current?.loaded || current?.preset) {
            return unlockModel(modelId, { loaded: true, preset: true });
        } else {
            return lockModel(modelId, { loaded: true, preset: true });
        }
    }
}

/**
 * Clear all locks
 */
function clearAllLocks() {
    locksCache = { lockedModels: {} };
    saveLocks();
    console.log('[Lock Service] Cleared all locks');
}

/**
 * Invalidate cache (for testing or manual refresh)
 */
function invalidateCache() {
    locksCache = null;
}

module.exports = {
    lockModel,
    unlockModel,
    isLoadLocked,
    isPresetLocked,
    getModelLock,
    getAllLocks,
    getLoadLockedModels,
    getPresetLockedModels,
    toggleLock,
    clearAllLocks,
    invalidateCache
};

