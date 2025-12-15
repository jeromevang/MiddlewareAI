#!/usr/bin/env node

const axios = require('axios');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const { getLMStudioCLIPath } = require('../lmstudio_manager.js');
const { LM_STUDIO_URL, LM_STUDIO_TIMEOUT_MS, MAX_RETRIES, loadedModels, loadingModels, withLMStudioLock, generateRequestId, setLastLoadedSnapshot, getLastLoadedSnapshot } = require('./state.js');

function normalizeModelId(id) {
    if (!id) return '';
    let s = String(id).trim().toLowerCase();
    s = s.replace(/\\/g, '/');
    s = s.split('/').pop();
    s = s.replace(/\.gguf$/, '');
    s = s.replace(/^text-embedding-/, '');
    s = s.replace(/-gguf$/, '');
    s = s.replace(/-q\d.*$/, '');
    s = s.replace(/@.*$/, '');
    return s;
}

function resolveModelNames(modelOrId) {
    if (!modelOrId) return { identifier: '', loadName: '', engine: 'lmstudio' };
    if (typeof modelOrId === 'string') {
        return { identifier: modelOrId, loadName: modelOrId, engine: 'lmstudio' };
    }
    // Prioritize identifier (which may have been resolved to the actual LM Studio model ID)
    const identifier = modelOrId.identifier || modelOrId.model_name || '';
    return {
        identifier,
        loadName: identifier, // Use identifier as loadName to ensure we use the resolved ID
        engine: modelOrId.engine || 'lmstudio',
    };
}

function modelIdMatches(target, loadedId) {
    if (!target || !loadedId) return false;
    const t = normalizeModelId(target);
    const l = normalizeModelId(loadedId);
    if (!t || !l) return false;
    if (t === l) return true;
    return l.includes(t) || t.includes(l);
}

async function isModelLoadedRemote(identifier) {
    if (!identifier) return false;
    const res = await axios.get(`${LM_STUDIO_URL}/api/v0/models`, { timeout: LM_STUDIO_TIMEOUT_MS });
    const list = res.data?.data || [];
    return list.some(m => m.state === 'loaded' && modelIdMatches(identifier, m.id));
}

async function ensureModelLoaded(modelOrId) {
    const { identifier, engine } = resolveModelNames(modelOrId);
    if (!identifier) return;
    
    // Skip if we're already loading this model
    if (loadingModels.has(identifier)) {
        await loadingModels.get(identifier);
        return;
    }

    if (engine === 'local') {
        loadedModels.add(identifier);
        return;
    }

    // Always verify with LM Studio if model is actually loaded
    // The in-memory cache may be stale due to identifier mismatches during unload
    try {
        const actuallyLoaded = await isModelLoadedRemote(identifier);
        if (actuallyLoaded) {
            loadedModels.add(identifier);
            console.log(`[LM Studio] Model already loaded (verified): ${identifier}`);
            return;
        }
    } catch (err) {
        console.warn(`[LM Studio] Could not verify if model is loaded: ${err?.message || err}`);
    }

    const loadPromise = (async () => {
        try {
            await withLMStudioLock(() => openModel(modelOrId));
            loadedModels.add(identifier);
        } catch (err) {
            console.warn(`[LM Studio] Failed to open model ${identifier}:`, err?.message || err);
        } finally {
            loadingModels.delete(identifier);
        }
    })();

    loadingModels.set(identifier, loadPromise);
    await loadPromise;
}

async function warmModel(modelOrId) {
    const { identifier, loadName, engine } = resolveModelNames(modelOrId);
    if (!identifier) return;
    if (loadedModels.has(identifier)) return;
    if (loadingModels.has(identifier)) {
        await loadingModels.get(identifier);
        return;
    }
    if (engine === 'local') {
        loadedModels.add(identifier);
        return;
    }
    try {
        const alreadyLoaded = await isModelLoadedRemote(identifier);
        if (alreadyLoaded) {
            loadedModels.add(identifier);
            return;
        }
    } catch (err) {
        console.warn(`[LM Studio] Remote load check failed for ${identifier}:`, err?.message || err);
    }

    const modelField = typeof loadName === 'string' ? loadName : String(loadName || identifier);
    const loadPromise = (async () => {
        try {
            const body = {
                model: modelField,
                messages: [
                    { role: 'system', content: 'Always answer in rhymes.' },
                    { role: 'user', content: 'Introduce yourself.' },
                ],
                temperature: 0.7,
                max_tokens: -1,
                stream: false,
            };
            await withLMStudioLock(() =>
                axios.post(`${LM_STUDIO_URL}/api/v0/chat/completions`, body, {
                    timeout: LM_STUDIO_TIMEOUT_MS,
                    headers: { 'Content-Type': 'application/json' },
                })
            );
            loadedModels.add(identifier);
            console.log(`[LM Studio Warm] Model warmed via chat: ${identifier}`);
        } catch (err) {
            const msg = err?.response?.data || err?.message || err;
            console.warn(`[LM Studio Warm] Failed to warm model ${identifier}:`, msg);
        } finally {
            loadingModels.delete(identifier);
        }
    })();

    loadingModels.set(identifier, loadPromise);
    await loadPromise;
}

const warmEmbeddingModel = warmModel;

async function waitForModelsLoaded(modelIds, timeoutMs = 30000, intervalMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    const target = new Set(modelIds.filter(Boolean));
    while (Date.now() < deadline) {
        try {
            const res = await axios.get(`${LM_STUDIO_URL}/api/v0/models`, { timeout: LM_STUDIO_TIMEOUT_MS });
            const list = res.data?.data || [];
            const loadedIds = list.filter(m => m.state === 'loaded').map(m => m.id);
            const allLoaded = [...target].every(id => loadedIds.some(loadedId => modelIdMatches(id, loadedId)));
            if (allLoaded) {
                loadedIds.forEach(id => loadedModels.add(id));
                setLastLoadedSnapshot(loadedIds.join(', '));
                return true;
            }
            const snapshot = loadedIds.join(', ');
            if (snapshot !== getLastLoadedSnapshot()) {
                setLastLoadedSnapshot(snapshot);
            }
        } catch (err) {
            console.warn('[LM Studio Wait] Poll failed:', err?.message || err);
        }
        await new Promise(r => setTimeout(r, intervalMs));
    }
    throw new Error(`Models not loaded within ${timeoutMs}ms: ${[...target].join(', ')}`);
}

async function openModel(modelOrId) {
    const { identifier, loadName } = resolveModelNames(modelOrId);
    const modelName = loadName || identifier;
    const requestId = generateRequestId();

    // Load the model using CLI (REST API /api/v0/models/load is NOT a valid endpoint)
    try {
        console.log(`[LM Studio Load] Loading model via CLI: ${modelName}`);
        const cliPath = getLMStudioCLIPath();
        // Use --yes to suppress interactive prompts, --quiet for cleaner output
        const { stdout, stderr } = await execAsync(`"${cliPath}" load "${modelName}" --yes`);
        console.log(`[LM Studio Load] CLI output: ${stdout.trim()}`);
        if (stderr && stderr.trim()) {
            console.warn(`[LM Studio Load] CLI stderr: ${stderr.trim()}`);
        }
        console.log(`[LM Studio Load] Successfully loaded model via CLI: ${modelName}`);
    } catch (loadError) {
        // Check if the error is because model is already loaded
        const errorMsg = loadError.message || String(loadError);
        if (errorMsg.includes('already loaded') || errorMsg.includes('Already loaded')) {
            console.log(`[LM Studio Load] Model already loaded: ${modelName}`);
        } else {
            console.error(`[LM Studio Load] Failed to load model ${modelName}:`, errorMsg);
            throw loadError;
        }
    }

    // Wait for model to be fully loaded
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Verify model is loaded by checking loaded models list
    try {
        const loadedModels = await listLoadedModels();
        const isLoaded = loadedModels.some(m => modelIdMatches(modelName, m.id));
        if (!isLoaded) {
            console.warn(`[LM Studio Load] Model ${modelName} not found in loaded list after CLI load`);
        }
    } catch (verifyError) {
        console.warn(`[LM Studio Load] Could not verify model load:`, verifyError.message);
    }

    // Warm the model with a simple request
    let retries = MAX_RETRIES;
    while (retries > 0) {
        try {
            console.log(`[LM Studio Request] ${requestId} - Warming model via chat: ${modelName}`);
            await axios.post(
                `${LM_STUDIO_URL}/api/v0/chat/completions`,
                {
                    model: modelName,
                    messages: [
                        { role: 'system', content: 'Respond briefly.' },
                        { role: 'user', content: 'Ping' },
                    ],
                    temperature: 0.7,
                    max_tokens: -1,
                    stream: false,
                },
                {
                    timeout: LM_STUDIO_TIMEOUT_MS,
                    headers: { 'Content-Type': 'application/json' }
                }
            );
            console.log(`[LM Studio Success] ${requestId} - Model warmed via chat: ${modelName}`);
            return;
        } catch (error) {
            retries--;
            if (retries === 0) {
                console.error(`[LM Studio Request Failed] ${requestId} - Max retries reached. Error:`, error.message);
                throw error;
            }
            const delay = Math.pow(2, MAX_RETRIES - retries) * 1000;
            console.log(`[LM Studio Retry] ${requestId} - Retrying in ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

async function unloadModel(modelOrId) {
    const { identifier } = resolveModelNames(modelOrId);
    if (!identifier) {
        throw new Error('Model identifier is required for unloading');
    }

    try {
        console.log(`[LM Studio Unload] Unloading model: ${identifier}`);
        const { stdout, stderr } = await execAsync(`"${getLMStudioCLIPath()}" unload "${identifier}"`);

        // Remove from our tracking - also clear any matching entries (due to identifier format differences)
        loadedModels.delete(identifier);
        loadingModels.delete(identifier);
        
        // Also remove any entries that match via normalized comparison
        for (const cached of [...loadedModels]) {
            if (modelIdMatches(identifier, cached)) {
                loadedModels.delete(cached);
            }
        }

        console.log(`[LM Studio Unload] Successfully unloaded model: ${identifier}`);
        console.log(`[LM Studio Unload] CLI output: ${stdout.trim()}`);

        return { success: true, output: stdout.trim() };
    } catch (error) {
        console.error(`[LM Studio Unload] Failed to unload model ${identifier}:`, error.message);
        throw new Error(`Failed to unload model ${identifier}: ${error.message}`);
    }
}

async function unloadAllModels() {
    try {
        console.log(`[LM Studio Unload] Unloading all models`);
        const { stdout, stderr } = await execAsync(`"${getLMStudioCLIPath()}" unload --all`);

        // Clear our tracking
        loadedModels.clear();
        loadingModels.clear();

        console.log(`[LM Studio Unload] Successfully unloaded all models`);
        console.log(`[LM Studio Unload] CLI output: ${stdout.trim()}`);

        return { success: true, output: stdout.trim() };
    } catch (error) {
        console.error(`[LM Studio Unload] Failed to unload all models:`, error.message);
        throw new Error(`Failed to unload all models: ${error.message}`);
    }
}

async function listLoadedModels() {
    try {
        const res = await axios.get(`${LM_STUDIO_URL}/api/v0/models`, { timeout: LM_STUDIO_TIMEOUT_MS });
        const models = res.data?.data || [];
        const loaded = models.filter(m => m.state === 'loaded').map(m => ({
            id: m.id,
            name: m.name,
            state: m.state,
            size: m.size,
            context_length: m.context_length
        }));

        console.log(`[LM Studio Models] Found ${loaded.length} loaded models:`, loaded.map(m => m.id).join(', '));
        return loaded;
    } catch (error) {
        console.error(`[LM Studio Models] Failed to list models:`, error.message);
        throw error;
    }
}

async function getServerStatus() {
    try {
        const { stdout } = await execAsync(`"${getLMStudioCLIPath()}" server status`);
        return { status: 'running', output: stdout.trim() };
    } catch (error) {
        if (error.code === 1) {
            return { status: 'stopped', output: error.stdout?.trim() || '' };
        }
        throw error;
    }
}

async function startLMStudioServer() {
    try {
        console.log('[LM Studio Server] Starting LM Studio server...');
        const { stdout } = await execAsync(`"${getLMStudioCLIPath()}" server start`);
        console.log('[LM Studio Server] Server start command executed');

        // Wait a bit for server to initialize
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Verify server is actually running
        const status = await getServerStatus();
        if (status.status !== 'running') {
            throw new Error('Server failed to start properly');
        }

        return { success: true, status: 'running', output: stdout.trim() };
    } catch (error) {
        console.error('[LM Studio Server] Failed to start server:', error.message);
        throw new Error(`Failed to start LM Studio server: ${error.message}`);
    }
}

async function stopLMStudioServer() {
    try {
        console.log('[LM Studio Server] Stopping LM Studio server...');
        const { stdout } = await execAsync(`"${getLMStudioCLIPath()}" server stop`);
        console.log('[LM Studio Server] Server stop command executed');

        // Wait a bit for server to shut down
        await new Promise(resolve => setTimeout(resolve, 1000));

        return { success: true, status: 'stopped', output: stdout.trim() };
    } catch (error) {
        console.error('[LM Studio Server] Failed to stop server:', error.message);
        throw new Error(`Failed to stop LM Studio server: ${error.message}`);
    }
}

async function checkLMStudioHealth() {
    try {
        const serverStatus = await getServerStatus();
        const models = await listLoadedModels();

        return {
            ready: serverStatus.status === 'running',
            server: serverStatus,
            models_loaded: models.length,
            models: models,
            timestamp: Date.now()
        };
    } catch (error) {
        return {
            ready: false,
            error: error.message,
            timestamp: Date.now()
        };
    }
}

async function ensureRequiredModelsLoaded() {
    const { getModelConfig } = require('../config.js');
    const { findLMStudioModelId, getLastActiveModel } = require('../model_db_service.js');

    // First, unload all currently loaded models to ensure we start fresh
    console.log('[LM Studio] Unloading all currently loaded models...');
    try {
        await unloadAllModels();
        console.log('[LM Studio] All models unloaded successfully');
    } catch (error) {
        console.warn('[LM Studio] Failed to unload models:', error.message);
    }

    // Load all required models: main (from user selection) + both summarizers (from config)
    const modelConfigs = [];

    // For main model, use the user's last active selection instead of config default
    try {
        const lastActiveModel = getLastActiveModel();
        if (lastActiveModel) {
            // Create a config object for the active model
            const activeModelConfig = {
                identifier: lastActiveModel,
                model_name: lastActiveModel
            };
            modelConfigs.push({ type: 'main', config: activeModelConfig });
            console.log(`[LM Studio] Using active model: ${lastActiveModel}`);
        } else {
            // Fallback to config if no active model
            modelConfigs.push({ type: 'main', config: getModelConfig('main') });
            console.log('[LM Studio] No active model found, using config default');
        }
    } catch (e) {
        console.warn('[LM Studio] Could not get active model, using config default:', e.message);
        try { modelConfigs.push({ type: 'main', config: getModelConfig('main') }); } catch (e2) { console.warn('[LM Studio] Main model not configured'); }
    }

    // Summarization models still use config (not user-selectable)
    try { modelConfigs.push({ type: 'ragSummarization', config: getModelConfig('ragSummarization') }); } catch (e) { console.warn('[LM Studio] RAG summarization model not configured'); }
    try { modelConfigs.push({ type: 'rollingSummarization', config: getModelConfig('rollingSummarization') }); } catch (e) { console.warn('[LM Studio] Rolling summarization model not configured'); }

    const requiredModels = modelConfigs.filter(m => m.config && m.config.identifier);

    console.log('[LM Studio] Ensuring required models are loaded:', requiredModels.map(m => m.config.identifier));

    for (const { type, config } of requiredModels) {
        try {
            // Find the actual LM Studio model ID
            const actualId = await findLMStudioModelId(config.identifier);
            
            if (!actualId) {
                console.warn(`[LM Studio] Could not find LM Studio model matching: ${config.identifier} (${type})`);
                continue;
            }
            
            console.log(`[LM Studio] Loading model: ${actualId} (from config: ${config.identifier})`);
            await ensureModelLoaded({ ...config, identifier: actualId });
            console.log(`[LM Studio] Successfully loaded model: ${actualId}`);
        } catch (error) {
            console.error(`[LM Studio] Failed to load model ${config.identifier}:`, error.message);
            // Don't throw - continue loading other models
        }
    }

    console.log('[LM Studio] All required models loaded successfully');
}

async function initializeLMStudioWithModels() {
    try {
        console.log('[LM Studio] Initializing LM Studio and loading models...');

        // First, ensure server is running
        const health = await checkLMStudioHealth();
        if (!health.ready) {
            console.log('[LM Studio] Server not ready, starting...');
            await startLMStudioServer();
            await waitForServerReady();
        }

        // Then load required models
        await ensureRequiredModelsLoaded();

        console.log('[LM Studio] Initialization complete');
        return { success: true };
    } catch (error) {
        console.error('[LM Studio] Initialization failed:', error.message);
        throw error;
    }
}

async function waitForServerReady(timeoutMs = 30000) {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
        try {
            const health = await checkLMStudioHealth();
            if (health.ready) {
                console.log('[LM Studio Server] Server is ready');
                return health;
            }
            console.log('[LM Studio Server] Server not ready yet, waiting...');
            await new Promise(resolve => setTimeout(resolve, 2000));
        } catch (error) {
            console.log('[LM Studio Server] Health check failed:', error.message);
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }

    throw new Error(`LM Studio server did not become ready within ${timeoutMs}ms`);
}

/**
 * Smart preset model loading with intelligent unloading
 * Only unloads models not needed by the new preset, keeps shared ones
 * @param {string} presetName - 'high', 'medium', or 'low'
 * @returns {Promise<{loaded: string[], failed: string[], needsDownload: string[], unloaded: string[], kept: string[]}>}
 */
async function ensurePresetModelsLoaded(presetName) {
    const { getPreset, findLMStudioModelId, isModelAvailable } = require('../model_db_service.js');

    const result = {
        loaded: [],
        failed: [],
        needsDownload: [],
        unloaded: [],
        kept: []
    };

    const preset = getPreset(presetName);
    if (!preset) {
        throw new Error(`Preset '${presetName}' not found`);
    }

    // Build list of required models for this preset
    const requiredModels = [];

    // Embedding model (local, doesn't need LM Studio loading)
    if (preset.embedding) {
        console.log(`[LM Studio] Embedding model: ${preset.embedding} (local, no loading needed)`);
    }

    // RAG Summarizer
    if (preset.ragSummarizer) {
        requiredModels.push({ type: 'ragSummarizer', presetId: preset.ragSummarizer });
    }

    // Rolling Summarizer
    if (preset.rollingSummarizer) {
        requiredModels.push({ type: 'rollingSummarizer', presetId: preset.rollingSummarizer });
    }

    // Main model - use the first option from the preset
    if (preset.mainOptions && preset.mainOptions.length > 0) {
        const mainModelId = preset.mainOptions[0];
        requiredModels.push({ type: 'main', presetId: mainModelId });
        console.log(`[LM Studio] Using main model from preset: ${mainModelId}`);
    }

    // Resolve all preset IDs to actual LM Studio IDs
    const resolvedModels = [];
    for (const model of requiredModels) {
        const actualId = await findLMStudioModelId(model.presetId);
        if (actualId) {
            resolvedModels.push({ ...model, actualId });
        } else {
            // Check if model is available (downloaded)
            const available = isModelAvailable ? isModelAvailable(model.presetId) : false;
            if (!available) {
                result.needsDownload.push(model.presetId);
                console.warn(`[LM Studio] Model needs download: ${model.presetId} (${model.type})`);
            } else {
                result.failed.push(model.presetId);
                console.warn(`[LM Studio] Could not resolve model: ${model.presetId} (${model.type})`);
            }
        }
    }

    // Get currently loaded models
    let currentlyLoaded = [];
    try {
        const loadedList = await listLoadedModels();
        currentlyLoaded = loadedList.map(m => m.id);
    } catch (error) {
        console.warn('[LM Studio] Could not get loaded models list:', error.message);
    }

    // Determine what to unload (loaded but not needed)
    const neededIds = new Set(resolvedModels.map(m => m.actualId));
    const modelsToUnload = currentlyLoaded.filter(loadedId => {
        // Check if this loaded model matches any needed model
        return ![...neededIds].some(neededId => modelIdMatches(neededId, loadedId));
    });

    // Determine what's already loaded and can be kept
    const modelsToKeep = currentlyLoaded.filter(loadedId => {
        return [...neededIds].some(neededId => modelIdMatches(neededId, loadedId));
    });

    // Determine what needs to be loaded (needed but not loaded)
    const modelsToLoad = resolvedModels.filter(model => {
        return !currentlyLoaded.some(loadedId => modelIdMatches(model.actualId, loadedId));
    });

    console.log(`[LM Studio] Smart unloading: unload ${modelsToUnload.length}, keep ${modelsToKeep.length}, load ${modelsToLoad.length}`);

    // Unload models not needed by new preset
    for (const modelId of modelsToUnload) {
        try {
            console.log(`[LM Studio] Unloading unused model: ${modelId}`);
            await unloadModel(modelId);
            result.unloaded.push(modelId);
        } catch (error) {
            console.warn(`[LM Studio] Failed to unload ${modelId}:`, error.message);
        }
    }

    // Track kept models
    result.kept = modelsToKeep;
    modelsToKeep.forEach(id => console.log(`[LM Studio] Keeping already loaded: ${id}`));

    // Load new models
    for (const model of modelsToLoad) {
        try {
            console.log(`[LM Studio] Loading model: ${model.actualId} (${model.type})`);
            await ensureModelLoaded({ identifier: model.actualId });
            result.loaded.push(model.actualId);
            console.log(`[LM Studio] Successfully loaded: ${model.actualId}`);
        } catch (error) {
            console.error(`[LM Studio] Failed to load ${model.actualId}:`, error.message);
            result.failed.push(model.presetId);
        }
    }

    console.log(`[LM Studio] Preset '${presetName}' complete: loaded=${result.loaded.length}, kept=${result.kept.length}, unloaded=${result.unloaded.length}, failed=${result.failed.length}, needsDownload=${result.needsDownload.length}`);
    return result;
}

/**
 * Switch to a different main model (manual selection)
 * Unloads the previous main model and loads the new one
 * Keeps summarizer models loaded
 * @param {string} newModelId - The model ID to switch to
 * @param {string|null} previousModelId - The previous main model (optional, will be unloaded)
 * @returns {Promise<{success: boolean, loaded?: string, unloaded?: string, error?: string}>}
 */
// Helper function to check if a model is still needed for summarization tasks
async function isModelStillNeeded(modelId, currentlyLoaded) {
    const { getConfig } = require('../config.js');

    try {
        const config = getConfig();
        const { findLMStudioModelId } = require('../model_db_service.js');

        // Check if model is used for RAG summarizer
        if (config.models?.ragSummarization?.model_name) {
            const ragModelId = await findLMStudioModelId(config.models.ragSummarization.model_name);
            if (ragModelId && currentlyLoaded.some(id => modelIdMatches(ragModelId, id))) {
                const modelResolved = await findLMStudioModelId(modelId);
                if (modelResolved && modelIdMatches(ragModelId, modelResolved)) {
                    return true;
                }
            }
        }

        // Check if model is used for rolling summarizer
        if (config.models?.rollingSummarization?.model_name) {
            const rollingModelId = await findLMStudioModelId(config.models.rollingSummarization.model_name);
            if (rollingModelId && currentlyLoaded.some(id => modelIdMatches(rollingModelId, id))) {
                const modelResolved = await findLMStudioModelId(modelId);
                if (modelResolved && modelIdMatches(rollingModelId, modelResolved)) {
                    return true;
                }
            }
        }

        return false;
    } catch (error) {
        console.warn('[LM Studio] Error checking if model still needed:', error.message);
        return false; // Default to not needed if we can't check
    }
}

async function switchMainModel(newModelId, previousModelId = null) {
    const { findLMStudioModelId } = require('../model_db_service.js');

    const result = { success: false };

    if (!newModelId) {
        result.error = 'No model ID provided';
        return result;
    }

    // Resolve the new model ID to actual LM Studio ID
    const actualNewId = await findLMStudioModelId(newModelId);
    if (!actualNewId) {
        result.error = `Could not find LM Studio model matching: ${newModelId}`;
        return result;
    }

    // Check if new model is already loaded
    let currentlyLoaded = [];
    try {
        const loadedList = await listLoadedModels();
        currentlyLoaded = loadedList.map(m => m.id);
    } catch (error) {
        console.warn('[LM Studio] Could not get loaded models list:', error.message);
    }

    const newAlreadyLoaded = currentlyLoaded.some(id => modelIdMatches(actualNewId, id));
    if (newAlreadyLoaded) {
        console.log(`[LM Studio] Model already loaded: ${actualNewId}`);
        result.success = true;
        result.loaded = actualNewId;
        result.message = 'Model already loaded';
        return result;
    }

    // Unload previous main model if specified and different, but only if not still needed
    if (previousModelId && previousModelId !== newModelId) {
        const actualPrevId = await findLMStudioModelId(previousModelId);
        if (actualPrevId) {
            const prevLoaded = currentlyLoaded.some(id => modelIdMatches(actualPrevId, id));
            if (prevLoaded) {
                // Check if previous model is still needed for other purposes (RAG/rolling summarizer)
                const isStillNeeded = await isModelStillNeeded(previousModelId, currentlyLoaded);
                if (!isStillNeeded) {
                    try {
                        console.log(`[LM Studio] Unloading previous main model: ${actualPrevId}`);
                        await unloadModel(actualPrevId);
                        result.unloaded = actualPrevId;
                    } catch (error) {
                        console.warn(`[LM Studio] Failed to unload previous model: ${error.message}`);
                    }
                } else {
                    console.log(`[LM Studio] Keeping previous model ${actualPrevId} as it's still needed for summarization`);
                }
            }
        }
    }

    // Load the new model
    try {
        console.log(`[LM Studio] Loading new main model: ${actualNewId}`);
        await ensureModelLoaded({ identifier: actualNewId });
        result.success = true;
        result.loaded = actualNewId;
        console.log(`[LM Studio] Successfully switched to: ${actualNewId}`);
    } catch (error) {
        result.error = `Failed to load model: ${error.message}`;
        console.error(`[LM Studio] Failed to load ${actualNewId}:`, error.message);
    }

    return result;
}

module.exports = {
    normalizeModelId,
    resolveModelNames,
    modelIdMatches,
    ensureModelLoaded,
    warmModel,
    warmEmbeddingModel,
    waitForModelsLoaded,
    isModelLoadedRemote,
    openModel,
    unloadModel,
    unloadAllModels,
    listLoadedModels,
    getServerStatus,
    startLMStudioServer,
    stopLMStudioServer,
    checkLMStudioHealth,
    waitForServerReady,
    ensureRequiredModelsLoaded,
    ensurePresetModelsLoaded,
    switchMainModel,
    initializeLMStudioWithModels,
};