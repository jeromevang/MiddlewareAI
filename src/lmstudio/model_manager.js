#!/usr/bin/env node

const axios = require('axios');
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
};
