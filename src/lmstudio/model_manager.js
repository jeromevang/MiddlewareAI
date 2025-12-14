#!/usr/bin/env node

const axios = require('axios');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
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
    return {
        identifier: modelOrId.identifier || modelOrId.model_name || '',
        loadName: modelOrId.model_name || modelOrId.identifier || '',
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
    if (loadedModels.has(identifier)) return;
    if (loadingModels.has(identifier)) {
        await loadingModels.get(identifier);
        return;
    }

    if (engine === 'local') {
        loadedModels.add(identifier);
        return;
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
        const { stdout, stderr } = await execAsync(`lms unload "${identifier}"`);

        // Remove from our tracking
        loadedModels.delete(identifier);
        loadingModels.delete(identifier);

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
        const { stdout, stderr } = await execAsync('lms unload --all');

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
        const { stdout } = await execAsync('lms server status');
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
        const { stdout } = await execAsync('lms server start');
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
        const { stdout } = await execAsync('lms server stop');
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

    const requiredModels = [
        getModelConfig('main'),
        getModelConfig('summarization')
    ].filter(model => model && model.identifier);

    console.log('[LM Studio] Ensuring required models are loaded:', requiredModels.map(m => m.identifier));

    for (const model of requiredModels) {
        try {
            console.log(`[LM Studio] Loading model: ${model.identifier}`);
            await ensureModelLoaded(model);
            console.log(`[LM Studio] Successfully loaded model: ${model.identifier}`);
        } catch (error) {
            console.error(`[LM Studio] Failed to load model ${model.identifier}:`, error.message);
            throw error;
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
    initializeLMStudioWithModels,
};
