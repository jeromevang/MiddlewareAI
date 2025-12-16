#!/usr/bin/env node
/**
 * Centralized LM Studio API Client
 * 
 * ALL LM Studio API calls should go through this module.
 * This provides:
 * - Single point of control for all LM Studio communication
 * - In-memory state tracking of loaded models
 * - WebSocket broadcasting of model changes
 * - Request queueing to prevent interference during streaming
 */

const axios = require('axios');
const crypto = require('crypto');
const { getLMStudioConfig } = require('../config.js');
const { getLMStudioCLIPath } = require('../lmstudio_manager.js');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

// Configuration
const lmStudioConfig = getLMStudioConfig();
const LM_STUDIO_URL = lmStudioConfig.url;
const LM_STUDIO_TIMEOUT_MS = lmStudioConfig.timeout_ms || 60000;
const MAX_RETRIES = lmStudioConfig.max_retries || 3;

// ============================================
// State Tracking
// ============================================

// In-memory model state (source of truth after initialization)
const modelState = {
    loaded: new Map(),  // modelId -> { id, name, loadedAt, role, contextLength }
    loading: new Set(), // modelIds currently loading
    initialized: false, // Whether we've done initial sync
};

// Request queue for serializing LM Studio requests
const requestQueue = [];
let isProcessingQueue = false;

// WebSocket broadcast callback (set by server.js)
let broadcastCallback = null;

// ============================================
// Utilities
// ============================================

function generateRequestId() {
    return crypto.randomBytes(4).toString('hex');
}

/**
 * Set the WebSocket broadcast function
 * @param {Function} callback - Function to broadcast messages
 */
function setBroadcastCallback(callback) {
    broadcastCallback = callback;
}

/**
 * Broadcast model status change to all connected clients
 */
function broadcastModelStatus() {
    if (!broadcastCallback) return;
    
    const loadedModels = Array.from(modelState.loaded.values());
    broadcastCallback({
        type: 'model-status',
        payload: {
            loadedModels: loadedModels.map(m => m.id),
            details: loadedModels,
            timestamp: Date.now()
        }
    });
}

/**
 * Get current loaded models (from our state, no API call)
 * @returns {Array} Array of loaded model objects
 */
function getLoadedModels() {
    return Array.from(modelState.loaded.values());
}

/**
 * Get loaded model IDs only
 * @returns {string[]} Array of loaded model IDs
 */
function getLoadedModelIds() {
    return Array.from(modelState.loaded.keys());
}

/**
 * Check if a model is loaded (from our state, no API call)
 * @param {string} modelId - Model identifier
 * @returns {boolean}
 */
function isModelLoaded(modelId) {
    if (!modelId) return false;
    // Check exact match first
    if (modelState.loaded.has(modelId)) return true;
    // Check normalized match
    const normalized = normalizeModelId(modelId);
    for (const key of modelState.loaded.keys()) {
        if (normalizeModelId(key) === normalized) return true;
    }
    return false;
}

/**
 * Normalize model ID for comparison
 */
function normalizeModelId(id) {
    if (!id) return '';
    return String(id).trim().toLowerCase().replace(/\\/g, '/');
}

// ============================================
// Request Queue (prevents interference during streaming)
// ============================================

/**
 * Queue a function to execute with LM Studio
 * Ensures requests don't interfere with active streams
 */
async function queueRequest(fn, options = {}) {
    const { priority = 'normal', skipQueue = false } = options;
    
    if (skipQueue) {
        return fn();
    }
    
    return new Promise((resolve, reject) => {
        const job = { fn, resolve, reject, priority };
        
        if (priority === 'high') {
            requestQueue.unshift(job);
        } else {
            requestQueue.push(job);
        }
        
        processQueue();
    });
}

async function processQueue() {
    if (isProcessingQueue) return;
    isProcessingQueue = true;
    
    while (requestQueue.length > 0) {
        const job = requestQueue.shift();
        try {
            const result = await job.fn();
            job.resolve(result);
        } catch (err) {
            job.reject(err);
        }
    }
    
    isProcessingQueue = false;
}

// ============================================
// LM Studio API Calls
// ============================================

/**
 * Initialize by syncing with LM Studio's actual state
 * Called once at server start after unloading all models
 */
async function initialize() {
    console.log('[LMStudio API] Initializing - unloading all models for clean state...');
    
    try {
        // Unload all models via CLI
        const cliPath = getLMStudioCLIPath();
        await execAsync(`"${cliPath}" unload --all`);
        console.log('[LMStudio API] All models unloaded');
    } catch (error) {
        console.warn('[LMStudio API] Failed to unload all models:', error.message);
    }
    
    // Clear our state
    modelState.loaded.clear();
    modelState.loading.clear();
    modelState.initialized = true;
    
    // Broadcast the clean state
    broadcastModelStatus();
    
    console.log('[LMStudio API] Initialized with clean state');
    return { success: true };
}

/**
 * Load a model via CLI
 * @param {string} modelId - Model identifier
 * @param {object} options - Load options (gpu, contextLength, role)
 */
async function loadModel(modelId, options = {}) {
    const requestId = generateRequestId();
    const { gpu = 'max', contextLength = null, role = 'main' } = options;
    
    // Check if already loaded
    if (isModelLoaded(modelId)) {
        console.log(`[LMStudio API] ${requestId} - Model already loaded: ${modelId}`);
        return { success: true, alreadyLoaded: true };
    }
    
    // Check if currently loading
    if (modelState.loading.has(modelId)) {
        console.log(`[LMStudio API] ${requestId} - Model already loading: ${modelId}`);
        return { success: true, loading: true };
    }
    
    modelState.loading.add(modelId);
    
    try {
        const cliPath = getLMStudioCLIPath();
        let cliArgs = `load "${modelId}" --yes --gpu ${gpu}`;
        if (contextLength) {
            cliArgs += ` --context-length ${contextLength}`;
        }
        
        console.log(`[LMStudio API] ${requestId} - Loading model: ${modelId} (gpu=${gpu}, ctx=${contextLength || 'default'})`);
        
        const { stdout, stderr } = await execAsync(`"${cliPath}" ${cliArgs}`);
        
        if (stderr && stderr.trim()) {
            console.log(`[LMStudio API] ${requestId} - CLI stderr: ${stderr.trim()}`);
        }
        
        // Update our state
        modelState.loaded.set(modelId, {
            id: modelId,
            loadedAt: Date.now(),
            role,
            contextLength,
            gpu
        });
        
        console.log(`[LMStudio API] ${requestId} - Model loaded: ${modelId}`);
        
        // Broadcast the change
        broadcastModelStatus();
        
        return { success: true };
    } catch (error) {
        const errorMsg = error.message || String(error);
        if (errorMsg.includes('already loaded') || errorMsg.includes('Already loaded')) {
            // Model was already loaded - update our state
            modelState.loaded.set(modelId, {
                id: modelId,
                loadedAt: Date.now(),
                role,
                contextLength,
                gpu
            });
            broadcastModelStatus();
            return { success: true, alreadyLoaded: true };
        }
        console.error(`[LMStudio API] ${requestId} - Failed to load: ${error.message}`);
        throw error;
    } finally {
        modelState.loading.delete(modelId);
    }
}

/**
 * Unload a model via CLI
 * @param {string} modelId - Model identifier
 */
async function unloadModel(modelId) {
    const requestId = generateRequestId();
    
    if (!isModelLoaded(modelId)) {
        console.log(`[LMStudio API] ${requestId} - Model not loaded, skipping unload: ${modelId}`);
        return { success: true, notLoaded: true };
    }
    
    try {
        const cliPath = getLMStudioCLIPath();
        console.log(`[LMStudio API] ${requestId} - Unloading model: ${modelId}`);
        
        await execAsync(`"${cliPath}" unload "${modelId}"`);
        
        // Update our state
        modelState.loaded.delete(modelId);
        // Also check normalized matches
        for (const key of modelState.loaded.keys()) {
            if (normalizeModelId(key) === normalizeModelId(modelId)) {
                modelState.loaded.delete(key);
            }
        }
        
        console.log(`[LMStudio API] ${requestId} - Model unloaded: ${modelId}`);
        
        // Broadcast the change
        broadcastModelStatus();
        
        return { success: true };
    } catch (error) {
        console.error(`[LMStudio API] ${requestId} - Failed to unload: ${error.message}`);
        throw error;
    }
}

/**
 * Unload all models
 */
async function unloadAllModels() {
    const requestId = generateRequestId();
    
    try {
        const cliPath = getLMStudioCLIPath();
        console.log(`[LMStudio API] ${requestId} - Unloading all models`);
        
        await execAsync(`"${cliPath}" unload --all`);
        
        // Clear our state
        modelState.loaded.clear();
        
        console.log(`[LMStudio API] ${requestId} - All models unloaded`);
        
        // Broadcast the change
        broadcastModelStatus();
        
        return { success: true };
    } catch (error) {
        console.error(`[LMStudio API] ${requestId} - Failed to unload all: ${error.message}`);
        throw error;
    }
}

/**
 * Send a chat completion request
 * @param {object} payload - Chat completion payload
 * @param {object} options - Additional options
 */
async function chatCompletion(payload, options = {}) {
    const requestId = generateRequestId();
    const { stream = false, resStream = null } = options;
    
    return queueRequest(async () => {
        const axiosOptions = {
            timeout: LM_STUDIO_TIMEOUT_MS,
            headers: { 'Content-Type': 'application/json' },
        };
        
        if (stream && resStream) {
            axiosOptions.responseType = 'stream';
        }
        
        console.log(`[LMStudio API] ${requestId} - Chat completion (model=${payload.model}, stream=${stream})`);
        
        const response = await axios.post(
            `${LM_STUDIO_URL}/v1/chat/completions`,
            payload,
            axiosOptions
        );
        
        console.log(`[LMStudio API] ${requestId} - Chat completion success`);
        return response;
    });
}

/**
 * Send an embedding request
 * @param {string} input - Text to embed
 * @param {string} model - Model identifier
 */
async function generateEmbedding(input, model) {
    const requestId = generateRequestId();
    
    return queueRequest(async () => {
        console.log(`[LMStudio API] ${requestId} - Generating embedding (model=${model})`);
        
        const response = await axios.post(
            `${LM_STUDIO_URL}/api/v0/embeddings`,
            { model, input },
            {
                timeout: LM_STUDIO_TIMEOUT_MS,
                headers: { 'Content-Type': 'application/json' },
            }
        );
        
        console.log(`[LMStudio API] ${requestId} - Embedding generated`);
        return response;
    });
}

/**
 * Get LM Studio server status (doesn't go through queue - quick check)
 */
async function getServerStatus() {
    try {
        const response = await axios.get(`${LM_STUDIO_URL}/api/v0/models`, { 
            timeout: 5000  // Quick timeout for status check
        });
        return { 
            status: 'running', 
            modelCount: response.data?.data?.length || 0 
        };
    } catch (error) {
        return { 
            status: 'offline', 
            error: error.message 
        };
    }
}

/**
 * Sync our state with LM Studio (for recovery/validation)
 * Only call this when needed, not for routine status checks
 */
async function syncWithLMStudio() {
    const requestId = generateRequestId();
    console.log(`[LMStudio API] ${requestId} - Syncing state with LM Studio...`);
    
    try {
        const response = await axios.get(`${LM_STUDIO_URL}/api/v0/models`, { 
            timeout: LM_STUDIO_TIMEOUT_MS 
        });
        const models = response.data?.data || [];
        const loaded = models.filter(m => m.state === 'loaded');
        
        // Update our state
        modelState.loaded.clear();
        for (const model of loaded) {
            modelState.loaded.set(model.id, {
                id: model.id,
                name: model.name,
                loadedAt: Date.now(),
                contextLength: model.context_length
            });
        }
        
        console.log(`[LMStudio API] ${requestId} - Synced: ${loaded.length} models loaded`);
        broadcastModelStatus();
        
        return { success: true, count: loaded.length };
    } catch (error) {
        console.error(`[LMStudio API] ${requestId} - Sync failed: ${error.message}`);
        throw error;
    }
}

// ============================================
// Exports
// ============================================

module.exports = {
    // Configuration
    LM_STUDIO_URL,
    LM_STUDIO_TIMEOUT_MS,
    MAX_RETRIES,
    
    // Setup
    setBroadcastCallback,
    initialize,
    
    // State queries (no API calls)
    getLoadedModels,
    getLoadedModelIds,
    isModelLoaded,
    
    // Model management
    loadModel,
    unloadModel,
    unloadAllModels,
    
    // API calls
    chatCompletion,
    generateEmbedding,
    getServerStatus,
    syncWithLMStudio,
    
    // Queue
    queueRequest,
    
    // Utilities
    generateRequestId,
    normalizeModelId,
    broadcastModelStatus,
};

