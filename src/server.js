#!/usr/bin/env node

/**
 * Middleware HTTP server bridging Cursor -> Middleware -> LM Studio.
 *
 * Exposes endpoints:
 *  - GET /health
 *  - POST /search { query, topK? }              -> RAG search results
 *  - POST /query  { prompt, topK?, temperature? } -> Executes RAG + rolling summary + main LLM
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const WebSocketLib = require('ws');
const { WebSocketServer } = WebSocketLib;
const { embedText, summarize, generateCompletion, proxyChatCompletion, warmModel, warmEmbeddingModel, waitForModelsLoaded } = require('./lmstudio_client.js');
const { SQLiteCacheManager } = require('./sqlite_cache.js');
const { FAISSIndexManager } = require('./faiss_storage.js');
const { initializeLMStudio, isLMStudioRunning } = require('./lmstudio_manager.js');
const { getProcessingConfig, getModelConfig, getConfig, getLMStudioConfig, getStorageConfig, getSessionConfig } = require('./config.js');
const { getRuntimeMode, isCloudMode, requireModeHealthCheck } = require('./runtime.js');
const { main: runIndexer } = require('./middleware.js'); // to trigger reindex
const { logDebugEvent, isTelemetryEnabled, setTelemetryOverride, getTelemetryOverride } = require('./debug_logger.js');
const { createRagService } = require('./services/rag_service.js');

// Global error logging to avoid silent crashes (opt-in via debug logger)
process.on('unhandledRejection', (err) => {
    console.error('[Fatal] Unhandled rejection:', err);
    void logDebugEvent({
        location: 'server.js:unhandledRejection',
        message: 'unhandled rejection',
        data: { error: err?.message || String(err), stack: err?.stack },
        hypothesisId: 'HX'
    });
});
process.on('uncaughtException', (err) => {
    console.error('[Fatal] Uncaught exception:', err);
    void logDebugEvent({
        location: 'server.js:uncaughtException',
        message: 'uncaught exception',
        data: { error: err?.message || String(err), stack: err?.stack },
        hypothesisId: 'HX'
    });
});
process.on('exit', (code) => {
    void logDebugEvent({
        location: 'server.js:exit',
        message: 'process exit',
        data: { code },
        hypothesisId: 'HX'
    });
});

const app = express();
app.use(express.json({ limit: '2mb' }));

// Log incoming requests (method, path, trimmed body) for debugging
app.use((req, _res, next) => {
    let bodyPreview = '';
    if (req.body && typeof req.body === 'object') {
        try {
            bodyPreview = JSON.stringify(req.body);
        } catch {
            bodyPreview = '[unserializable body]';
        }
    }
    console.log(`[REQ] ${req.method} ${req.url} body=${bodyPreview}`);
    next();
});

app.use(express.json({ limit: '2mb' }));

const sqliteCacheManager = new SQLiteCacheManager();
const faissIndexManager = new FAISSIndexManager();
const processingConfig = getProcessingConfig();
const summarizationModel = getModelConfig('summarization');
const serverConfig = (getConfig().server || {});
const embeddingModelCfg = getModelConfig('embedding');
const mainModelCfg = getModelConfig('main');
const runtimeMode = getRuntimeMode();
const cloudMode = isCloudMode();
const sessionConfig = getSessionConfig();
const SERVER_API_KEY = serverConfig.api_key;
const CONTEXT_MAX_TOKENS = processingConfig.max_context_tokens || 40000;
const CONTEXT_BUDGET_RATIO = processingConfig.context_budget_ratio || 0.7;
const CONTEXT_BUDGET_TOKENS = Math.floor(CONTEXT_MAX_TOKENS * CONTEXT_BUDGET_RATIO);
const REQUEST_BUFFER_LIMIT = 100;
const LOG_BUFFER_LIMIT = 200;
const DASHBOARD_PUSH_INTERVAL_MS = Number(process.env.DASHBOARD_PUSH_INTERVAL_MS || 4000);
const WS_HEARTBEAT_INTERVAL_MS = 30000;
const DASHBOARD_HISTORY_LIMIT = 20;
const DASHBOARD_LOG_LIMIT = 50;
const DEFAULT_CONVERSATION_ID = 'global';
const SESSION_METADATA_LIMIT = sessionConfig.list_limit || 100;
let indexingInProgress = false;
let activeIndexer = null;
let wss = null;
let dashboardBroadcastTimer = null;
let wsHeartbeatTimer = null;

const recentRequests = [];
const recentLogs = [];
const metrics = {
    totalRequests: 0,
    totalErrors: 0,
    avgDurationMs: 0,
    lastBudget: null,
    lastContextText: null,
    lastContextLength: 0,
    lastContextTs: null,
    lastRagResults: [],
    lastSummaryAction: null,
};

function isRagEnabled() {
    return !cloudMode;
}

const ragService = createRagService({
    sqliteCacheManager,
    faissIndexManager,
    embedText,
    isRagEnabled,
    isIndexing: () => indexingInProgress,
});

const { ragSearch, buildContextWithBudget, extractAssistantText } = ragService;

function generateSessionId() {
    if (crypto.randomUUID) {
        return crypto.randomUUID();
    }
    return crypto.randomBytes(16).toString('hex');
}

function resolveConversationId(requestedId) {
    if (typeof requestedId === 'string') {
        const trimmed = requestedId.trim();
        if (trimmed) {
            return { sessionId: trimmed, generated: false };
        }
    }
    return { sessionId: generateSessionId(), generated: true };
}

function buildTelemetryStatus() {
    const override = getTelemetryOverride();
    return {
        enabled: isTelemetryEnabled(),
        override: override === null ? null : override,
        source: override === null ? 'env' : 'override',
        envFlag: process.env.ENABLE_DEBUG_TELEMETRY || null
    };
}

function resetInMemoryStats() {
    recentRequests.length = 0;
    recentLogs.length = 0;
    metrics.totalRequests = 0;
    metrics.totalErrors = 0;
    metrics.avgDurationMs = 0;
    metrics.lastBudget = null;
    metrics.lastContextText = null;
    metrics.lastContextLength = 0;
    metrics.lastContextTs = null;
    metrics.lastRagResults = [];
    metrics.lastSummaryAction = null;
}

function modelSummary(cfg, extras = {}) {
    if (!cfg) return null;
    return {
        engine: cfg.engine || 'lmstudio',
        model_name: cfg.model_name || cfg.identifier,
        identifier: cfg.identifier,
        context_length: cfg.context_length,
        ...extras,
    };
}

async function ensureReady() {
    // Initialize LM Studio (start server + load models if configured)
    await initializeLMStudio();
    await sqliteCacheManager.initialize();
    await faissIndexManager.initialize();

    // Warm models once via chat to avoid repeated open calls
    try {
        const embeddingCfg = getModelConfig('embedding');
        const summarizationCfg = getModelConfig('summarization');
        const mainCfg = getModelConfig('main');
        const lmTargets = [
            summarizationCfg.identifier,
            cloudMode ? null : mainCfg.identifier,
            embeddingCfg.engine === 'local' ? null : embeddingCfg.identifier,
        ].filter(Boolean);

        const warmers = [
            warmEmbeddingModel(embeddingCfg),
            warmModel(summarizationCfg),
        ];
        if (!cloudMode) {
            warmers.push(warmModel(mainCfg));
        }
        await Promise.allSettled(warmers);

        if (lmTargets.length) {
            await waitForModelsLoaded(lmTargets, 30000, 5000);
        }

        console.log('[LM Studio Warm] All required models are loaded.');
    } catch (err) {
        console.error('[LM Studio Warm] Warm-up failed:', err?.message || err);
        // Continue startup; LM Studio may already be loaded even if warm failed.
    }

    if (cloudMode && requireModeHealthCheck()) {
        try {
            await generateCompletion({
                prompt: 'Ping',
                systemPrompt: 'You are a health check. Respond with OK.',
                temperature: 0
            });
            console.log('[Cloud] Main model health check succeeded.');
        } catch (err) {
            console.error('[Cloud] Main model health check failed:', err?.message || err);
        }
    }

    if (isRagEnabled()) {
        console.log('[Server] Starting automatic file scan and RAG indexing in background...');
        void startIndexer({ reason: 'startup', background: true });
    } else {
        console.log('[Server] Skipping auto-index; RAG disabled in current mode.');
    }
}

function getRedactedConfig() {
    const cfg = getConfig();
    const redacted = JSON.parse(JSON.stringify(cfg));
    if (redacted.server && redacted.server.api_key) {
        redacted.server.api_key = '***';
    }
    if (redacted.runtime && redacted.runtime.cloud_main && redacted.runtime.cloud_main.api_key) {
        redacted.runtime.cloud_main.api_key = '***';
    }
    return redacted;
}

/**
 * Optional API key check.
 */
function authMiddleware(req, res, next) {
    if (!SERVER_API_KEY || SERVER_API_KEY === 'changeme') {
        return next();
    }
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (token !== SERVER_API_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

app.use(authMiddleware);
app.use('/ui', express.static(path.join(__dirname, '../public')));
app.get('/', (_req, res) => res.redirect('/ui'));

function computeFreshChunkHash(cachedEntry) {
    if (!cachedEntry) {
        return { hash: null, status: 'missing-entry' };
    }
    const hasRange = typeof cachedEntry.chunk_start_line === 'number' && typeof cachedEntry.chunk_size === 'number';
    if (!hasRange) {
        return { hash: null, status: 'missing-range' };
    }
    const chunkContent = extractChunkFromFile({
        filePath: cachedEntry.file_path,
        language: cachedEntry.language,
        startLine: cachedEntry.chunk_start_line,
        length: cachedEntry.chunk_size,
    });
    if (chunkContent === null) {
        return { hash: null, status: 'unreadable' };
    }
    return { hash: generateChunkHash(chunkContent), status: 'ok' };
}

function appendLog(message, level = 'info') {
    const entry = { ts: Date.now(), level, message };
    recentLogs.push(entry);
    if (recentLogs.length > LOG_BUFFER_LIMIT) recentLogs.shift();
    void broadcastDashboardSnapshot();
}

function recordRequest(data) {
    recentRequests.push(data);
    if (recentRequests.length > REQUEST_BUFFER_LIMIT) recentRequests.shift();
    void broadcastDashboardSnapshot();
}

function updateMetrics(durationMs, budgetInfo, ok = true) {
    metrics.totalRequests += 1;
    if (!ok) metrics.totalErrors += 1;
    // simple moving average
    const n = metrics.totalRequests;
    metrics.avgDurationMs = ((metrics.avgDurationMs * (n - 1)) + durationMs) / n;
    if (budgetInfo) metrics.lastBudget = budgetInfo;
}

function isAbortError(error) {
    if (!error) return false;
    return error.name === 'AbortError' || error.code === 'ABORT_ERR';
}

function startIndexer({ modelVersion = null, reason = 'manual', background = false } = {}) {
    if (!isRagEnabled()) {
        const err = new Error('RAG is disabled; indexing unavailable.');
        err.code = 'RAG_DISABLED';
        return Promise.reject(err);
    }

    if (activeIndexer) {
        const err = new Error('Indexer already running.');
        err.code = 'INDEXING_IN_PROGRESS';
        return Promise.reject(err);
    }

    const controller = new AbortController();
    indexingInProgress = true;
    appendLog(`[Indexer] Starting (${reason})${background ? ' [background]' : ''}`, 'info');

    const promise = runIndexer({ modelVersion, signal: controller.signal })
        .then(() => {
            appendLog(`[Indexer] Completed (${reason})`, 'info');
        })
        .catch((err) => {
            if (isAbortError(err)) {
                appendLog(`[Indexer] Aborted (${reason})`, 'warn');
                throw err;
            }
            appendLog(`[Indexer] Failed (${reason}): ${err.message}`, 'error');
            throw err;
        })
        .finally(() => {
            if (activeIndexer && activeIndexer.promise === promise) {
                activeIndexer = null;
            }
            indexingInProgress = false;
        });

    activeIndexer = { controller, promise };

    if (background) {
        promise.catch((err) => {
            if (!isAbortError(err)) {
                console.error('[Indexer] Background run failed:', err);
            }
        });
    }

    return promise;
}

async function stopActiveIndexer(reason = 'manual stop') {
    if (!activeIndexer) return false;
    appendLog(`[Indexer] Stopping active run (${reason})`, 'warn');
    const { controller, promise } = activeIndexer;
    controller.abort();
    try {
        await promise;
    } catch (err) {
        if (!isAbortError(err)) {
            throw err;
        }
    }
    return true;
}

async function buildStatusPayload() {
    const cfg = getConfig();
    const lmOk = await isLMStudioRunning(cfg.lmstudio.url);
    const storageCfg = getStorageConfig();
    let sessionMeta = [];
    try {
        sessionMeta = await sqliteCacheManager.getSessionSummaries(SESSION_METADATA_LIMIT);
    } catch (err) {
        console.warn('[Status] Failed to load session metadata:', err?.message || err);
    }
    return {
        lmstudio: { url: cfg.lmstudio.url, healthy: lmOk },
        server: { port: (cfg.server && cfg.server.port) || 3001 },
        config: getRedactedConfig(),
        runtime: {
            mode: runtimeMode,
            rag_enabled: isRagEnabled(),
            cloud: cloudMode,
        },
        processing: {
            max_chunk_size: processingConfig.max_chunk_size,
            concurrency_limit: processingConfig.concurrency_limit,
            context_budget_tokens: CONTEXT_BUDGET_TOKENS,
            max_context_tokens: CONTEXT_MAX_TOKENS,
        },
        models: {
            embedding: modelSummary(embeddingModelCfg, { embedding_dimension: storageCfg.embedding_dimension }),
            summarization: modelSummary(summarizationModel),
            main: modelSummary(mainModelCfg),
        },
        storage: {
            embedding_dimension: storageCfg.embedding_dimension,
            faiss_index_path: storageCfg.faiss_index_path,
            sqlite_db_path: storageCfg.sqlite_db_path,
            faiss_entries: faissIndexManager.idMap?.length || 0,
            faiss_dim: faissIndexManager.dim || storageCfg.embedding_dimension,
        },
        context: metrics.lastBudget || null,
        context_snapshot: metrics.lastContextText ? {
            preview: metrics.lastContextText,
            length: metrics.lastContextLength,
            ts: metrics.lastContextTs,
            rag: metrics.lastRagResults || []
        } : null,
        last_summary: metrics.lastSummaryAction || null,
        indexingInProgress,
        sessions: sessionMeta,
        metrics,
    };
}

function buildMetricsPayload() {
    const storageCfg = getStorageConfig();
    return {
        ...metrics,
        models: {
            embedding: modelSummary(embeddingModelCfg, { embedding_dimension: storageCfg.embedding_dimension }),
            summarization: modelSummary(summarizationModel),
            main: modelSummary(mainModelCfg),
        },
        storage: {
            embedding_dimension: storageCfg.embedding_dimension,
            faiss_index_path: storageCfg.faiss_index_path,
            sqlite_db_path: storageCfg.sqlite_db_path,
            faiss_entries: faissIndexManager.idMap?.length || 0,
            faiss_dim: faissIndexManager.dim || storageCfg.embedding_dimension,
        },
        processing: {
            max_chunk_size: processingConfig.max_chunk_size,
            concurrency_limit: processingConfig.concurrency_limit,
            context_budget_tokens: CONTEXT_BUDGET_TOKENS,
            max_context_tokens: CONTEXT_MAX_TOKENS,
        },
    };
}

async function buildDashboardSnapshot() {
    const [status] = await Promise.all([buildStatusPayload()]);
    return {
        status,
        metrics: buildMetricsPayload(),
        history: recentRequests.slice(-DASHBOARD_HISTORY_LIMIT),
        logs: recentLogs.slice(-DASHBOARD_LOG_LIMIT),
    };
}

async function sendDashboardSnapshot(ws) {
    if (!ws || ws.readyState !== WebSocketLib.OPEN) return;
    const payload = await buildDashboardSnapshot();
    ws.send(JSON.stringify({ type: 'dashboard', payload }));
}

async function broadcastDashboardSnapshot() {
    if (!wss || wss.clients.size === 0) return;
    const snapshot = await buildDashboardSnapshot();
    const serialized = JSON.stringify({ type: 'dashboard', payload: snapshot });
    for (const client of wss.clients) {
        if (client.readyState === WebSocketLib.OPEN) {
            client.send(serialized);
        }
    }
}
/**
 * Update rolling summary: summarize (prior summary + interaction) using summarization model.
 */
async function updateRollingSummary(previousSummaryRow, interactionText, conversationId) {
    const previousSummary = previousSummaryRow?.summary || '';
    const base = previousSummary ? `${previousSummary}\n\n` : '';
    const toSummarize = `${base}${interactionText}`;
    const newSummary = await summarize(toSummarize);
    const nextTurnCount = (previousSummaryRow?.turn_count || 0) + 1;
    await sqliteCacheManager.saveRollingSummary(
        newSummary,
        summarizationModel.identifier,
        conversationId,
        nextTurnCount
    );
    return { summary: newSummary, turnCount: nextTurnCount };
}

// Health endpoint removed (LM Studio backend logs unexpected /health); use /status instead.

app.get('/status', async (_req, res) => {
    try {
        const payload = await buildStatusPayload();
                res.json(payload);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/metrics', async (_req, res) => {
    const payload = buildMetricsPayload();
        res.json(payload);
});

app.get('/logs', async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || '50', 10), LOG_BUFFER_LIMIT);
    res.json(recentLogs.slice(-limit));
});

app.get('/history', async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || '50', 10), REQUEST_BUFFER_LIMIT);
    res.json(recentRequests.slice(-limit));
});

app.get('/config', async (_req, res) => {
    res.json(getRedactedConfig());
});

app.patch('/config', async (req, res) => {
    try {
        const cfgPath = path.join(__dirname, '../config.json');
        const current = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        const updates = req.body || {};
        // Do not allow setting api_key in plain response
        const merged = { ...current, ...updates };
        fs.writeFileSync(cfgPath, JSON.stringify(merged, null, 2));
        res.json({ status: 'ok', note: 'Restart server to apply new config' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});


app.get('/telemetry', (_req, res) => {
    res.json(buildTelemetryStatus());
});

app.post('/telemetry', (req, res) => {
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') {
        return res.status(400).json({ error: 'enabled boolean required' });
    }
    setTelemetryOverride(enabled);
    appendLog(`Telemetry ${enabled ? 'enabled' : 'disabled'} via UI override`, 'info');
    res.json(buildTelemetryStatus());
});

app.post('/sessions/purge', async (req, res) => {
    try {
        const { conversationId = null, beforeTs = null } = req.body || {};
        await sqliteCacheManager.purgeSessions({ conversationId, beforeTs });
        appendLog(`Session purge executed (${conversationId || 'all'}${beforeTs ? ` <= ${beforeTs}` : ''})`, 'info');
        res.json({ status: 'ok' });
    } catch (error) {
        console.error('[Server] /sessions/purge error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/search', async (req, res) => {
    try {
        const { query, topK = 5 } = req.body;
        if (!query) return res.status(400).json({ error: 'query required' });
        if (!isRagEnabled()) {
            return res.json({ results: [], disabled: true, message: 'RAG is disabled in the current runtime mode.' });
        }
        const results = await ragSearch(query, topK);
        res.json({ results });
    } catch (error) {
        console.error('[Server] /search error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/query', async (req, res) => {
    const started = Date.now();
    let budgetInfo = null;
    let sessionId = DEFAULT_CONVERSATION_ID;
    try {
        const { prompt, topK = 5, temperature = 0.2, conversationId: requestedConversationId } = req.body;
        if (!prompt) return res.status(400).json({ error: 'prompt required' });
        const resolved = resolveConversationId(requestedConversationId);
        sessionId = resolved.sessionId;

        // Retrieve latest rolling summary (long-term memory)
        const latestSummary = await sqliteCacheManager.getLatestRollingSummary(sessionId);
        const rollingSummaryText = latestSummary ? latestSummary.summary : '';

        // RAG search
        const ragResults = await ragSearch(prompt, topK);

        // Build context with budgeting
        const { contextText: composedPrompt, info } = buildContextWithBudget({
            rollingSummaryText,
            ragResults,
            userPrompt: prompt,
            budgetTokens: CONTEXT_BUDGET_TOKENS
        });
        budgetInfo = info;

        // Capture context snapshot for UI
        const ragPreview = (ragResults || []).slice(0, 5).map(r => ({
            filePath: r.filePath,
            distance: r.distance,
            summaryText: (r.summaryText || '').slice(0, 500)
        }));
        metrics.lastContextText = (composedPrompt || '').slice(0, 2000);
        metrics.lastContextLength = composedPrompt ? composedPrompt.length : 0;
        metrics.lastContextTs = Date.now();
        metrics.lastRagResults = ragPreview;

        // Call main model
        const completion = await generateCompletion({
            prompt: composedPrompt,
            systemPrompt: 'You are a coding assistant. Use the provided context and summaries to answer.',
            temperature
        });
        const completionText = extractAssistantText(completion);

        // Update rolling summary with interaction
        const interactionText = `User: ${prompt}\nAssistant: ${completionText}`;
        const newRollingSummary = await updateRollingSummary(latestSummary, interactionText, sessionId);
        metrics.lastSummaryAction = {
            ts: Date.now(),
            sessionId,
            turnCount: newRollingSummary?.turnCount || 0,
            summaryText: (newRollingSummary?.summary || '').slice(0, 1200),
            summaryLength: newRollingSummary?.summary ? newRollingSummary.summary.length : 0
        };

        res.json({
            sessionId,
            completion,
            rag: ragResults,
            rollingSummary: newRollingSummary?.summary,
            summaryMeta: { turnCount: newRollingSummary?.turnCount || 0 },
            budget: budgetInfo
        });

        const duration = Date.now() - started;
        updateMetrics(duration, budgetInfo, true);
        recordRequest({
            ts: Date.now(),
            path: '/query',
            duration,
            ragHits: ragResults.length,
            budget: budgetInfo,
            status: 200,
            sessionId
        });
    } catch (error) {
        const duration = Date.now() - started;
        updateMetrics(duration, budgetInfo, false);
        recordRequest({
            ts: Date.now(),
            path: '/query',
            duration,
            ragHits: 0,
            budget: budgetInfo,
            status: 500,
            error: error.message,
            sessionId
        });
        console.error('[Server] /query error:', error);
        res.status(500).json({ error: error.message, sessionId });
    }
});

/**
 * Reindex endpoint: runs the middleware indexing flow.
 */
app.post('/reindex', async (req, res) => {
    if (!isRagEnabled()) {
        return res.status(400).json({ error: 'RAG is disabled in the current runtime mode.' });
    }
    try {
        const { modelVersion } = req.body || {};
        await stopActiveIndexer('manual reindex');
        await startIndexer({ modelVersion, reason: `manual-${modelVersion || 'default'}` });
        appendLog(`Reindex complete (modelVersion=${modelVersion || 'default'})`, 'info');
        res.json({ status: 'ok', message: 'Reindex complete' });
    } catch (error) {
        appendLog(`Reindex failed: ${error.message}`, 'error');
        console.error('[Server] /reindex error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * Reset everything: clear SQLite cache, FAISS index, in-memory metrics, and kick off reindex.
 */
app.post('/reset', async (_req, res) => {
    try {
        await stopActiveIndexer('reset request');
        await sqliteCacheManager.clearAll();
        await faissIndexManager.clear();
        resetInMemoryStats();
        appendLog('Reset requested: cache cleared, FAISS cleared, stats reset', 'info');
        if (isRagEnabled()) {
            appendLog('Reindex after reset scheduled', 'info');
            void startIndexer({ reason: 'reset', background: true });
        } else {
            appendLog('Reindex skipped: RAG disabled in current mode', 'info');
        }
        res.json({ status: 'ok', message: isRagEnabled() ? 'Reset done; reindex started' : 'Reset done; RAG disabled so no reindex' });
    } catch (error) {
        appendLog(`Reset failed: ${error.message}`, 'error');
        console.error('[Server] /reset error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * Restart LM Studio (best effort).
 */
app.post('/lmstudio/restart', async (_req, res) => {
    try {
        await initializeLMStudio();
        appendLog('LM Studio restart/init complete', 'info');
        res.json({ status: 'ok', message: 'LM Studio restart/init complete' });
    } catch (error) {
        appendLog(`LM Studio restart failed: ${error.message}`, 'error');
        res.status(500).json({ error: error.message });
    }
});

/**
 * OpenAI-compatible chat completions handler (shared by /v1/chat/completions and /chat/completions).
 */
async function handleChatCompletions(req, res, pathLabel = '/v1/chat/completions') {
    const started = Date.now();
    let budgetInfo = null;
    let ragResults = [];
    let sessionId = DEFAULT_CONVERSATION_ID;
        try {
        const { messages = [], temperature = 0.2, /* model ignored intentionally */ stream = false, topK = 5, conversationId: requestedConversationId, ...rest } = req.body || {};
        if (!Array.isArray(messages) || messages.length === 0) {
            return res.status(400).json({ error: 'messages array required' });
        }
        const resolved = resolveConversationId(requestedConversationId);
        sessionId = resolved.sessionId;

        // Extract latest user message for RAG
        const latestUser = [...messages].reverse().find(m => m?.role === 'user');
        if (!latestUser || !latestUser.content) {
            return res.status(400).json({ error: 'at least one user message required' });
        }
        const userPrompt = typeof latestUser.content === 'string'
            ? latestUser.content
            : Array.isArray(latestUser.content)
                ? latestUser.content.map(c => c.text || '').join('\n')
                : JSON.stringify(latestUser.content);
        
        // Retrieve latest rolling summary (long-term memory)
        let latestSummary = null;
        try {
                        latestSummary = await sqliteCacheManager.getLatestRollingSummary(sessionId);
        } catch (sumErr) {
            void logDebugEvent({
                location: 'server.js:handleChatCompletions summary error',
                message: 'latestSummary failed',
                data: { error: sumErr?.message || String(sumErr) },
                hypothesisId: 'H5'
            });
            throw sumErr;
        }
        const rollingSummaryText = latestSummary ? latestSummary.summary : '';
        
        // RAG search
        try {
                        ragResults = await ragSearch(userPrompt, topK);
        } catch (ragErr) {
                        throw ragErr;
        }
        
        // Build context with budgeting
        const { contextText: composedPrompt, info } = buildContextWithBudget({
            rollingSummaryText,
            ragResults,
            userPrompt,
            budgetTokens: CONTEXT_BUDGET_TOKENS
        });
        budgetInfo = info;
        
        // Capture context snapshot for UI
        const ragPreview = (ragResults || []).slice(0, 5).map(r => ({
            filePath: r.filePath,
            distance: r.distance,
            summaryText: (r.summaryText || '').slice(0, 500)
        }));
        metrics.lastContextText = (composedPrompt || '').slice(0, 2000);
        metrics.lastContextLength = composedPrompt ? composedPrompt.length : 0;
        metrics.lastContextTs = Date.now();
        metrics.lastRagResults = ragPreview;

        // Build messages with enhanced context
        const enhancedMessages = [];
        // Add system message with context
        enhancedMessages.push({
            role: 'system',
            content: 'You are a coding assistant. Use the provided context and summaries to answer.\n\n' + composedPrompt
        });
        // Add original user messages (but replace last user message with just the prompt since context is in system)
        for (let i = 0; i < messages.length - 1; i++) {
            enhancedMessages.push(messages[i]);
        }
        enhancedMessages.push({ role: 'user', content: userPrompt });

        // Call main model with enhanced context
        // Always use configured main model; ignore client-supplied model to avoid loading unintended models
        const mainModel = getModelConfig('main').identifier;
        
        if (stream) {
            const lmStarted = Date.now();
            
            // Prepare SSE headers before streaming
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            if (!res.writableEnded) {
                res.write(`data: ${JSON.stringify({ type: 'session', sessionId })}\n\n`);
            }

            let streamedContent = '';
            try {
                streamedContent = await proxyChatCompletion({
                    model: mainModel,
                    messages: enhancedMessages,
                    temperature,
                    stream: true,
                    ...rest,
                }, res);
            } catch (streamErr) {
                console.error('[Server] Streaming completion failed:', streamErr);
                if (!res.writableEnded) {
                    res.write(`data: ${JSON.stringify({
                        error: streamErr?.message || 'stream failed'
                    })}\n\n`);
                    res.write('data: [DONE]\n\n');
                    res.end();
                }
                metrics.totalErrors += 1;
                recordRequest({
                    ts: Date.now(),
                    path: pathLabel,
                    duration: Date.now() - started,
                    ragHits: ragResults.length,
                    budget: budgetInfo,
                    status: 500,
                    error: streamErr?.message || 'stream failed',
                    sessionId
                });
                return;
            }

            const lmDuration = Date.now() - lmStarted;
            const duration = Date.now() - started;
            console.log(`[RESP] ${pathLabel} STREAM 200 in ${duration}ms (LM ${lmDuration}ms) rag=${ragResults.length}`);
            
            // Update rolling summary asynchronously
            const interactionText = `User: ${userPrompt}\nAssistant: ${streamedContent}`;
            updateRollingSummary(latestSummary, interactionText, sessionId)
                .then(summary => {
                    metrics.lastSummaryAction = {
                        ts: Date.now(),
                        sessionId,
                        turnCount: summary?.turnCount || 0,
                        summaryText: (summary?.summary || '').slice(0, 1200),
                        summaryLength: summary?.summary ? summary.summary.length : 0
                    };
                })
                .catch(err => 
                    console.error('[Server] Failed to update rolling summary:', err)
                );
            
            updateMetrics(duration, budgetInfo, true);
            recordRequest({
                ts: Date.now(),
                path: pathLabel,
                duration,
                ragHits: ragResults.length,
                budget: budgetInfo,
                status: 200,
                sessionId
            });
            return;
        }

        
        // Non-streaming: get completion and return OpenAI format
        const completionResponse = await generateCompletion({
            prompt: composedPrompt,
            systemPrompt: 'You are a coding assistant. Use the provided context and summaries to answer.',
            temperature
        });
        
        // Extract content
        const content = extractAssistantText(completionResponse);

        // Update rolling summary
        const interactionText = `User: ${userPrompt}\nAssistant: ${content}`;
        const newRollingSummary = await updateRollingSummary(latestSummary, interactionText, sessionId);
        metrics.lastSummaryAction = {
            ts: Date.now(),
            sessionId,
            turnCount: newRollingSummary?.turnCount || 0,
            summaryText: (newRollingSummary?.summary || '').slice(0, 1200),
            summaryLength: newRollingSummary?.summary ? newRollingSummary.summary.length : 0
        };

        // Return OpenAI-compatible format
        res.json({
            id: `chatcmpl-${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: mainModel,
            choices: [{
                index: 0,
                message: {
                    role: 'assistant',
                    content: content
                },
                finish_reason: 'stop'
            }],
            usage: {
                prompt_tokens: budgetInfo?.usedTokens || 0,
                completion_tokens: Math.ceil(content.length / 4),
                total_tokens: (budgetInfo?.usedTokens || 0) + Math.ceil(content.length / 4)
            },
            session_id: sessionId
        });

        const duration = Date.now() - started;
        updateMetrics(duration, budgetInfo, true);
        console.log(
            `[RESP] ${pathLabel} 200 in ${duration}ms rag=${ragResults.length} used=${budgetInfo?.usedTokens ?? 0}/${budgetInfo?.budgetTokens ?? 'n/a'}`
        );
        recordRequest({
            ts: Date.now(),
            path: pathLabel,
            duration,
            ragHits: ragResults.length,
            budget: budgetInfo,
            status: 200,
            sessionId
        });
    } catch (error) {
        const duration = Date.now() - started;
        updateMetrics(duration, budgetInfo, false);
        recordRequest({
            ts: Date.now(),
            path: pathLabel,
            duration,
            ragHits: 0,
            budget: budgetInfo,
            status: 500,
            error: error.message,
            sessionId
        });
        if (error.response) {
            console.error(`[Server] ${pathLabel} error ${error.response.status}:`, error.message, 'payload:', error.response.data);
        } else {
            console.error(`[Server] ${pathLabel} error:`, error);
        }
                res.status(500).json({ error: error.message, sessionId });
    }
}

/**
 * OpenAI-compatible chat completions endpoints (alias)
 * - /v1/chat/completions (preferred)
 * - /chat/completions (compat alias)
 */
app.post('/v1/chat/completions', (req, res) => handleChatCompletions(req, res, '/v1/chat/completions'));
app.post('/chat/completions', (req, res) => handleChatCompletions(req, res, '/chat/completions'));

function teardownWebsocketServer() {
    if (dashboardBroadcastTimer) {
        clearInterval(dashboardBroadcastTimer);
        dashboardBroadcastTimer = null;
    }
    if (wsHeartbeatTimer) {
        clearInterval(wsHeartbeatTimer);
        wsHeartbeatTimer = null;
    }
    if (wss) {
        try {
            for (const client of wss.clients) {
                try {
                    client.terminate();
                } catch (_) {
                    /* noop */
                }
            }
            wss.close();
        } catch (err) {
            console.warn('[WS] Failed to close existing server:', err?.message || err);
        } finally {
            wss = null;
        }
    }
}

function setupWebsocketServer(httpServer) {
    teardownWebsocketServer();
    wss = new WebSocketServer({ server: httpServer, path: '/ws' });

    wss.on('connection', (socket, req) => {
        socket.isAlive = true;
        const clientInfo = `${req.socket.remoteAddress || 'unknown'}:${req.socket.remotePort || '0'}`;
        console.log(`[WS] Client connected (${clientInfo})`);
        void sendDashboardSnapshot(socket);

        socket.on('pong', () => {
            socket.isAlive = true;
        });

        socket.on('message', async (raw) => {
            try {
                const payload = JSON.parse(raw.toString('utf8'));
                if (payload?.type === 'snapshot-request') {
                    await sendDashboardSnapshot(socket);
                }
            } catch (err) {
                console.warn('[WS] Message handling failed:', err?.message || err);
            }
        });

        socket.on('close', () => {
            console.log('[WS] Client disconnected');
        });

        socket.on('error', (err) => {
            console.warn('[WS] Client error:', err?.message || err);
        });
    });

    if (dashboardBroadcastTimer) {
        clearInterval(dashboardBroadcastTimer);
    }
    dashboardBroadcastTimer = setInterval(() => {
        void broadcastDashboardSnapshot();
    }, DASHBOARD_PUSH_INTERVAL_MS);
    if (dashboardBroadcastTimer?.unref) {
        dashboardBroadcastTimer.unref();
    }

    if (wsHeartbeatTimer) {
        clearInterval(wsHeartbeatTimer);
    }
    wsHeartbeatTimer = setInterval(() => {
        if (!wss) return;
        for (const socket of wss.clients) {
            if (socket.isAlive === false) {
                socket.terminate();
                continue;
            }
            socket.isAlive = false;
            try {
                socket.ping();
            } catch (_) {
                socket.terminate();
            }
        }
    }, WS_HEARTBEAT_INTERVAL_MS);
    if (wsHeartbeatTimer?.unref) {
        wsHeartbeatTimer.unref();
    }

    httpServer.on('close', () => {
        teardownWebsocketServer();
    });
}

async function start() {
    try {
        await ensureReady();
        const config = getConfig();
        const port = (config.server && config.server.port) || 3001;
        const httpServer = http.createServer(app);
        setupWebsocketServer(httpServer);
        httpServer.listen(port, () => {
            console.log(`[Middleware Server] Listening on port ${port}`);
        });
    } catch (error) {
        console.error('[Server] Failed to start:', error);
        process.exit(1);
    }
}

// Start server if run directly
if (require.main === module) {
    start();
}

module.exports = { start };

