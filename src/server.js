#!/usr/bin/env node

/**
 * Middleware HTTP server bridging Cursor -> Middleware -> LM Studio.
 *
 * Exposes endpoints:
 *  - GET /health
 *  - POST /search { query, topK? }              -> RAG search results
 *  - POST /query  { prompt, topK?, temperature? } -> Executes RAG + rolling summary + main LLM
 *  - GET /lmstudio/models                       -> List loaded models
 *  - POST /lmstudio/models/unload {modelId}     -> Unload specific model
 *  - POST /lmstudio/models/unload-all           -> Unload all models
 *  - GET /lmstudio/server/status                -> Get LM Studio server status
 *  - GET /lmstudio/health                        -> Comprehensive health check
 *  - POST /lmstudio/server/start                 -> Start LM Studio server
 *  - POST /lmstudio/server/stop                  -> Stop LM Studio server
 *  - POST /lmstudio/context/refresh              -> Refresh context limits from loaded models
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const WebSocketLib = require('ws');
const { WebSocketServer } = WebSocketLib;
const { embedText, summarizeConversation, generateCompletion, proxyChatCompletion, warmModel, warmEmbeddingModel, waitForModelsLoaded, unloadModel, unloadAllModels, listLoadedModels, getServerStatus, startLMStudioServer, stopLMStudioServer, checkLMStudioHealth, ensureRequiredModelsLoaded, ensurePresetModelsLoaded, switchMainModel, initializeLMStudioWithModels } = require('./lmstudio_client.js');
const { SQLiteCacheManager } = require('./sqlite_cache.js');
const { FAISSIndexManager } = require('./faiss_storage.js');
const { initializeLMStudio, isLMStudioRunning } = require('./lmstudio_manager.js');
const { getProcessingConfig, getModelConfig, getConfig, getLMStudioConfig, getStorageConfig, getSessionConfig } = require('./config.js');
const { getRuntimeMode, isCloudMode, requireModeHealthCheck } = require('./runtime.js');
const { main: runIndexer } = require('./middleware.js'); // to trigger reindex
const { logDebugEvent, isTelemetryEnabled, setTelemetryOverride, getTelemetryOverride } = require('./debug_logger.js');
const { createRagService } = require('./services/rag_service.js');
const {
    getSummaryKeepRecentTurns,
    setSummaryKeepRecentTurns,
    refreshProcessingStateFromConfig,
    getContextModeDefault,
    setContextModeDefault,
    getRawContextMarginPct,
    setRawContextMarginPct,
} = require('./processing_state.js');
const {
    getEnginesSnapshot,
    isRagEnabled: isRagEngineEnabled,
    isSummaryEnabled,
    updateEngineEnabled,
    refreshEngineStateFromConfig,
    incrementRagBypass,
    resetRagBypassCount,
} = require('./engine_state.js');
const {
    getPresets,
    getPreset,
    getModelSpec,
    getAllModelSpecs,
    getLastActiveModel,
    setActiveModel,
    getSuggestedModels,
    approveModel,
    dismissSuggestedModel,
    discoverAndAnalyzeModels,
    reRankPresetModels,
    initializeModelDatabase,
    downloadModel: downloadModelFromDB,
    getModelAvailability,
    getActiveDownloads,
} = require('./model_db_service.js');
const { runBootstrap, getBootstrapStatus } = require('./model_bootstrap.js');

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

const sqliteCacheManager = new SQLiteCacheManager();
const faissIndexManager = new FAISSIndexManager();
const processingConfig = getProcessingConfig();
const ragSummarizationModel = getModelConfig('ragSummarization');
const rollingSummarizationModel = getModelConfig('rollingSummarization');
const serverConfig = (getConfig().server || {});
const embeddingModelCfg = getModelConfig('embedding');
const mainModelCfg = getModelConfig('main');
const runtimeMode = getRuntimeMode();
const cloudMode = isCloudMode();
const sessionConfig = getSessionConfig();
refreshProcessingStateFromConfig();
const SERVER_API_KEY = serverConfig.api_key;
// Get model's context length - first try from loaded LM Studio models, then config
async function getModelContextLength() {
    try {
        // Try to get context length from actually loaded models in LM Studio
        const loadedModels = await listLoadedModels();
        const mainModelId = mainModelCfg.identifier || mainModelCfg.model_name;

        // Find the loaded main model
        const loadedMainModel = loadedModels.find(model =>
            model.id && mainModelId &&
            (model.id.includes(mainModelId) || mainModelId.includes(model.id))
        );

        if (loadedMainModel && loadedMainModel.context_length) {
            console.log(`[Context] Using context length from loaded model: ${loadedMainModel.context_length} tokens`);
            return loadedMainModel.context_length;
        }
    } catch (error) {
        console.warn('[Context] Could not get context length from LM Studio:', error.message);
    }

    // Fallback to config
    const configContext = typeof mainModelCfg.context_length === 'number' && mainModelCfg.context_length > 0
        ? mainModelCfg.context_length
        : 40000;

    console.log(`[Context] Using context length from config: ${configContext} tokens`);
    return configContext;
}

// Initialize context length asynchronously
let MODEL_CONTEXT_LENGTH = 40000; // initial fallback
let CONTEXT_MAX_TOKENS = 40000;
let CONTEXT_BUDGET_TOKENS = Math.floor(40000 * 0.7);

// Update context values when we have the real model info
getModelContextLength().then(contextLength => {
    MODEL_CONTEXT_LENGTH = contextLength;
    CONTEXT_MAX_TOKENS = Math.min(processingConfig.max_context_tokens || MODEL_CONTEXT_LENGTH, MODEL_CONTEXT_LENGTH);
    const budgetRatio = processingConfig.context_budget_ratio || 0.7;
    CONTEXT_BUDGET_TOKENS = Math.floor(CONTEXT_MAX_TOKENS * budgetRatio);
    console.log(`[Context] Updated context budget: ${CONTEXT_BUDGET_TOKENS} tokens (${budgetRatio * 100}% of ${CONTEXT_MAX_TOKENS})`);
}).catch(error => {
    console.error('[Context] Failed to initialize model context length:', error);
});

// Function to refresh context values when models change
async function refreshModelContext() {
    try {
        const contextLength = await getModelContextLength();
        MODEL_CONTEXT_LENGTH = contextLength;
        CONTEXT_MAX_TOKENS = Math.min(processingConfig.max_context_tokens || MODEL_CONTEXT_LENGTH, MODEL_CONTEXT_LENGTH);
        const budgetRatio = processingConfig.context_budget_ratio || 0.7;
        CONTEXT_BUDGET_TOKENS = Math.floor(CONTEXT_MAX_TOKENS * budgetRatio);
        console.log(`[Context] Refreshed context budget: ${CONTEXT_BUDGET_TOKENS} tokens (${budgetRatio * 100}% of ${CONTEXT_MAX_TOKENS})`);
    } catch (error) {
        console.warn('[Context] Failed to refresh model context:', error);
    }
}
const REQUEST_BUFFER_LIMIT = 100;
const LOG_BUFFER_LIMIT = 200;
const DASHBOARD_PUSH_INTERVAL_MS = Number(process.env.DASHBOARD_PUSH_INTERVAL_MS || 4000);
const WS_HEARTBEAT_INTERVAL_MS = 30000;
const DASHBOARD_HISTORY_LIMIT = 20;
const DASHBOARD_LOG_LIMIT = 50;
const DEFAULT_CONVERSATION_ID = 'global';
const SESSION_METADATA_LIMIT = sessionConfig.list_limit || 100;
const BASE_SYSTEM_PROMPT = 'You are a coding assistant. Use the provided context and summaries to answer.';
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

function sanitizeUserText(text = '') {
    if (typeof text !== 'string') {
        return '';
    }
    return text;
}

function sanitizeAssistantText(text = '') {
    if (typeof text !== 'string') {
        return '';
    }
    // Remove unwanted structured tags (e.g., <AskQuestion>, <plan>)
    text = text.replace(/<\/?AskQuestion[^>]*>/gi, '');
    text = text.replace(/<\/?plan[^>]*>/gi, '');
    // Remove any remaining XML-like tags if present
    text = text.replace(/<[^>]+>/g, '');
    return text.trim();
}

function sanitizeSummaryText(text = '') {
    if (typeof text !== 'string') {
        return '';
    }
    return text;
}

function isRagFeatureEnabled() {
    return !cloudMode && isRagEngineEnabled();
}

function isSummaryFeatureEnabled() {
    return isSummaryEnabled();
}

const ragService = createRagService({
    sqliteCacheManager,
    faissIndexManager,
    embedText,
    isRagEnabled: isRagFeatureEnabled,
    isIndexing: () => indexingInProgress,
    onRagBypass: () => incrementRagBypass(),
});

const { ragSearch, buildContextWithBudget, extractAssistantText, estimateTokens } = ragService;

function generateSessionId() {
    if (crypto.randomUUID) {
        return crypto.randomUUID();
    }
    return crypto.randomBytes(16).toString('hex');
}

function resolveConversationId(requestedId, { headerId = null, fallbackId = null } = {}) {
    if (typeof requestedId === 'string') {
        const trimmed = requestedId.trim();
        if (trimmed) {
            return { sessionId: trimmed, generated: false };
        }
    }
    if (typeof headerId === 'string') {
        const trimmedHeader = headerId.trim();
        if (trimmedHeader) {
            return { sessionId: trimmedHeader, generated: false };
        }
    }
    if (typeof fallbackId === 'string') {
        const trimmedFallback = fallbackId.trim();
        if (trimmedFallback) {
            return { sessionId: trimmedFallback, generated: false };
        }
    }
    return { sessionId: generateSessionId(), generated: true };
}

function extractConversationIdFromHeaders(req) {
    const headerKeys = ['x-conversation-id', 'x-session-id', 'x-cursor-session'];
    for (const key of headerKeys) {
        const raw = req.headers?.[key];
        if (typeof raw === 'string' && raw.trim()) {
            return raw.trim();
        }
        if (Array.isArray(raw)) {
            const found = raw.find((entry) => typeof entry === 'string' && entry.trim());
            if (found) {
                return found.trim();
            }
        }
    }
    return null;
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

function normalizeContextModeValue(mode) {
    if (typeof mode !== 'string') {
        return null;
    }
    const lowered = mode.trim().toLowerCase();
    if (!lowered) {
        return null;
    }
    const allowed = ['raw', 'compressed', 'raw-fallback'];
    return allowed.includes(lowered) ? lowered : null;
}

function normalizePolicyModeValue(mode) {
    const normalized = normalizeContextModeValue(mode);
    if (!normalized) {
        return null;
    }
    return normalized === 'raw-fallback' ? null : normalized;
}

function getRawFallbackThresholdTokens() {
    const baseLimit = MODEL_CONTEXT_LENGTH; // Use the dynamically determined context length
    const marginPct = getRawContextMarginPct();
    const clampedMargin = Math.min(Math.max(Number.isFinite(marginPct) ? marginPct : 0.1, 0.01), 0.5);
    return Math.max(1, Math.floor(baseLimit * (1 - clampedMargin)));
}

async function resolveSessionContextMode(sessionId) {
    try {
        const override = await sqliteCacheManager.getSessionContextMode(sessionId);
        const normalized = normalizePolicyModeValue(override);
        return normalized || getContextModeDefault();
    } catch (err) {
        console.warn('[SessionMode] Failed to load override:', err?.message || err);
        return getContextModeDefault();
    }
}

function decorateSessionMetaRows(rows = []) {
    const defaultMode = getContextModeDefault();
    return rows.map((row) => {
        const override = normalizePolicyModeValue(row?.context_mode_override);
        const lastMode = normalizeContextModeValue(row?.last_context_mode);
        const policyMode = override || defaultMode;
        const activeMode = lastMode || policyMode;
        return {
            conversation_id: row?.conversation_id,
            last_activity: row?.last_activity,
            turn_count: row?.turn_count || 0,
            updates: row?.updates || 0,
            context_mode_override: override,
            context_mode: policyMode,
            active_mode: activeMode,
        };
    });
}

function buildFallbackSessionMeta(conversationId) {
    const policyMode = getContextModeDefault();
    return {
        conversation_id: conversationId,
        last_activity: new Date().toISOString(),
        turn_count: 0,
        updates: 0,
        context_mode_override: null,
        context_mode: policyMode,
        active_mode: policyMode,
    };
}

async function getSessionList({ limit = SESSION_METADATA_LIMIT, contextMode = null } = {}) {
    const normalizedFilter = normalizeContextModeValue(contextMode);
    const fetchLimit = normalizedFilter ? Math.max(limit * 2, SESSION_METADATA_LIMIT) : limit;
    const rows = await sqliteCacheManager.getSessionSummaries(fetchLimit);
    const decorated = decorateSessionMetaRows(rows);
    const filtered = normalizedFilter
        ? decorated.filter((entry) => entry.active_mode === normalizedFilter)
        : decorated;
    return filtered.slice(0, limit);
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
    resetRagBypassCount();
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
    // await initializeLMStudio();
    await sqliteCacheManager.initialize();
    await faissIndexManager.initialize();

    // Warm models once via chat to avoid repeated open calls
    // try {
    //     const embeddingCfg = getModelConfig('embedding');
    //     const summarizationCfg = getModelConfig('summarization');
    //     const mainCfg = getModelConfig('main');
    //     const lmTargets = [
    //         summarizationCfg.identifier,
    //         cloudMode ? null : mainCfg.identifier,
    //         embeddingCfg.engine === 'local' ? null : embeddingCfg.identifier,
    //     ].filter(Boolean);

    //     const warmers = [
    //         // Only warm LM Studio embedding model if not using local engine
    //     ];

    //     if (embeddingCfg.engine !== 'local') {
    //         warmers.push(warmEmbeddingModel(embeddingCfg));
    //     }

    //     if (isSummaryFeatureEnabled()) {
    //         warmers.push(warmModel(summarizationCfg));
    //     }
    //     if (!cloudMode) {
    //         warmers.push(warmModel(mainCfg));
    //     }
    //     await Promise.allSettled(warmers);

    //     if (lmTargets.length) {
    //         await waitForModelsLoaded(lmTargets, 30000, 5000);
    //     }

    //     console.log('[LM Studio Warm] All required models are loaded.');
    // } catch (err) {
    //     console.error('[LM Studio Warm] Warm-up failed:', err?.message || err);
    //     // Continue startup; LM Studio may already be loaded even if warm failed.
    // }

    // if (cloudMode && requireModeHealthCheck()) {
    //     try {
    //         await generateCompletion({
    //             prompt: 'Ping',
    //             systemPrompt: 'You are a health check. Respond with OK.',
    //             temperature: 0
    //         });
    //         console.log('[Cloud] Main model health check succeeded.');
    //     } catch (err) {
    //         console.error('[Cloud] Main model health check failed:', err?.message || err);
    //     }
    // }

    if (isRagFeatureEnabled()) {
        console.log('[Server] Skipping automatic file scan and RAG indexing in background...');
        // void startIndexer({ reason: 'startup', background: true });
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

function formatRagSnippets(ragResults = []) {
    return ragResults.map(r => `- [${r.filePath}] (${r.distance.toFixed(4)}): ${r.summaryText}`).join('\n');
}

function formatRecentTurns(turns = []) {
    return turns.map((turn, idx) => ({
        label: `Recent turn ${turn?.turnIndex ?? idx + 1}`,
        text: (() => {
            const userText = sanitizeUserText(turn?.userPrompt || '');
            const assistantText = sanitizeAssistantText(turn?.assistantResponse || '');
            return [userText ? `User: ${userText}` : '', assistantText ? `Assistant: ${assistantText}` : '']
                .filter(Boolean)
                .join('\n')
                .trim();
        })()
    }));
}

async function getFormattedRecentTurns(conversationId, keepRecentTurns) {
    if (!conversationId || !keepRecentTurns) {
        return [];
    }
    try {
        const turns = await sqliteCacheManager.getRecentTurns(conversationId, keepRecentTurns);
        return formatRecentTurns(turns);
    } catch (err) {
        console.warn('[Server] Failed to load recent turns:', err?.message || err);
        return [];
    }
}

function buildRawContext({ rollingSummaryText, recentTurns = [], ragResults = [], userPrompt }) {
    const parts = [];
    if (rollingSummaryText) {
        parts.push(`Rolling summary:\n${rollingSummaryText}`);
    }
    if (recentTurns.length) {
        parts.push(`Recent turns:\n${recentTurns.map(rt => `${rt.label}\n${rt.text}`).join('\n\n')}`);
    }
    if (ragResults.length) {
        parts.push(`RAG context:\n${formatRagSnippets(ragResults)}`);
    }
    if (userPrompt) {
        parts.push(`User prompt:\n${userPrompt}`);
    }
    return parts.join('\n\n');
}

function buildContextPayload({
    sessionMode,
    summaryEnabled,
    rollingSummaryText,
    recentTurns,
    ragResults,
    userPrompt,
    fallbackThresholdTokens,
    excludeUserPrompt = false,
}) {
    const effectiveUserPrompt = excludeUserPrompt ? null : userPrompt;
    const rawContextText = buildRawContext({ rollingSummaryText, recentTurns, ragResults, userPrompt: effectiveUserPrompt });
    const rawTokens = estimateTokens(rawContextText);

    if (sessionMode === 'compressed') {
        const { contextText, info } = buildContextWithBudget({
            rollingSummaryText,
            recentTurns,
            ragResults,
            userPrompt: effectiveUserPrompt,
            budgetTokens: CONTEXT_BUDGET_TOKENS
        });
        return {
            contextText,
            rawContextText,
            budgetInfo: { ...info, mode: 'compressed' },
            appliedMode: 'compressed'
        };
    }

    const rawBudget = {
        budgetTokens: fallbackThresholdTokens || null,
        usedTokens: rawTokens,
        rawTokens,
        savedTokens: 0,
        compressionPct: 0,
        trimmed: false,
        mode: 'raw'
    };

    if (fallbackThresholdTokens && rawTokens > fallbackThresholdTokens) {
        const { contextText, info } = buildContextWithBudget({
            rollingSummaryText,
            recentTurns,
            ragResults,
            userPrompt: effectiveUserPrompt,
            budgetTokens: CONTEXT_BUDGET_TOKENS
        });
        return {
            contextText,
            rawContextText,
            budgetInfo: { ...info, mode: 'raw-fallback', fallbackReason: 'token-threshold' },
            appliedMode: 'raw-fallback'
        };
    }

    return {
        contextText: rawContextText,
        rawContextText,
        budgetInfo: rawBudget,
        appliedMode: 'raw'
    };
}

async function persistConversationTurn({
    sessionId,
    userPrompt,
    assistantResponse,
    rawContextText,
    composedContextText,
    budgetInfo,
    ragResults,
    llmPayloadKind = null,
    llmPayload = null,
}) {
    try {
        const turnId = await sqliteCacheManager.saveConversationTurn({
            conversationId: sessionId,
            userPrompt,
            assistantResponse,
            rawContext: rawContextText,
            composedContext: composedContextText,
            budgetInfo,
            ragChunks: ragResults,
            compressionMode: budgetInfo?.mode || null,
            llmPayloadKind,
            llmPayload,
        });
        if (!turnId) {
            return null;
        }
        return await sqliteCacheManager.getConversationTurnById(turnId);
    } catch (err) {
        console.error('[Server] Failed to persist conversation turn:', err?.message || err);
        return null;
    }
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
    if (!isRagFeatureEnabled()) {
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
        sessionMeta = await getSessionList({ limit: SESSION_METADATA_LIMIT });
    } catch (err) {
        console.warn('[Status] Failed to load session metadata:', err?.message || err);
    }
    return {
        lmstudio: { url: cfg.lmstudio.url, healthy: lmOk },
        server: { port: (cfg.server && cfg.server.port) || 3001 },
        config: getRedactedConfig(),
        runtime: {
            mode: runtimeMode,
            rag_enabled: isRagFeatureEnabled(),
            summary_enabled: isSummaryFeatureEnabled(),
            cloud: cloudMode,
        },
        engines: getEnginesSnapshot(),
        processing: {
            max_chunk_size: processingConfig.max_chunk_size,
            concurrency_limit: processingConfig.concurrency_limit,
            context_budget_tokens: CONTEXT_BUDGET_TOKENS,
            max_context_tokens: CONTEXT_MAX_TOKENS,
            summary_keep_recent_turns: getSummaryKeepRecentTurns(),
            context_mode_default: getContextModeDefault(),
            raw_context_margin_pct: getRawContextMarginPct(),
        },
        models: {
            embedding: modelSummary(embeddingModelCfg, { embedding_dimension: storageCfg.embedding_dimension }),
            ragSummarization: modelSummary(ragSummarizationModel),
            rollingSummarization: modelSummary(rollingSummarizationModel),
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
        engines: getEnginesSnapshot(),
        models: {
            embedding: modelSummary(embeddingModelCfg, { embedding_dimension: storageCfg.embedding_dimension }),
            ragSummarization: modelSummary(ragSummarizationModel),
            rollingSummarization: modelSummary(rollingSummarizationModel),
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
            summary_keep_recent_turns: getSummaryKeepRecentTurns(),
            context_mode_default: getContextModeDefault(),
            raw_context_margin_pct: getRawContextMarginPct(),
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
    broadcastWsMessage({ type: 'dashboard', payload: snapshot });
}

function broadcastWsMessage(message) {
    if (!wss || wss.clients.size === 0) return;
    let serialized;
    try {
        serialized = JSON.stringify(message);
    } catch (err) {
        console.warn('[WS] Failed to serialize message:', err?.message || err);
        return;
    }
    for (const client of wss.clients) {
        if (client.readyState === WebSocketLib.OPEN) {
            try {
                client.send(serialized);
            } catch (err) {
                console.warn('[WS] Failed to send payload:', err?.message || err);
            }
        }
    }
}

async function pushSessionUpdate({ sessionId, turn }) {
    if (!sessionId || !wss || wss.clients.size === 0) {
        return;
    }
    try {
        const summary = await sqliteCacheManager.getSessionSummary(sessionId);
        const sessionMeta = summary
            ? decorateSessionMetaRows([summary])[0]
            : buildFallbackSessionMeta(sessionId);
        const payload = {
            session: sessionMeta,
            turn: turn || null,
        };
        broadcastWsMessage({ type: 'session-update', payload });
    } catch (err) {
        console.warn('[WS] Failed to push session update:', err?.message || err);
    }
}
async function recomputeRollingSummary(conversationId, keepRecentTurns) {
    if (!isSummaryFeatureEnabled()) {
        return null;
    }
    try {
        const { eligibleTurns, totalTurns } = await sqliteCacheManager.getTurnsForSummary(conversationId, keepRecentTurns);
        if (!eligibleTurns.length) {
            await sqliteCacheManager.saveRollingSummary(
                '',
                rollingSummarizationModel.identifier,
                conversationId,
                0
            );
            return { summary: '', turnCount: 0, totalTurns };
        }
        const transcriptSections = eligibleTurns
            .map((turn) => {
                const user = sanitizeUserText(turn.userPrompt || '');
                const assistant = sanitizeAssistantText(turn.assistantResponse || '');
                const lines = [];
                if (user) lines.push(`User: ${user}`);
                if (assistant) lines.push(`Assistant: ${assistant}`);
                return lines.join('\n').trim();
            })
            .filter(Boolean);

        const transcript = transcriptSections.join('\n\n');

        if (!transcript) {
            await sqliteCacheManager.saveRollingSummary(
                '',
                rollingSummarizationModel.identifier,
                conversationId,
                eligibleTurns.length
            );
            return { summary: '', turnCount: eligibleTurns.length, totalTurns };
        }

        const newSummaryRaw = await summarizeConversation(transcript);
        const cleanedSummary = sanitizeSummaryText(newSummaryRaw);
        await sqliteCacheManager.saveRollingSummary(
            cleanedSummary,
            rollingSummarizationModel.identifier,
            conversationId,
            eligibleTurns.length
        );
        return { summary: cleanedSummary, turnCount: eligibleTurns.length, totalTurns };
    } catch (err) {
        console.error('[Server] Failed to recompute rolling summary:', err?.message || err);
        throw err;
    }
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

app.get('/api/config', async (_req, res) => {
    res.json(getRedactedConfig());
});

app.patch('/api/config', async (req, res) => {
    try {
        const cfgPath = path.join(__dirname, '../config.json');
        const current = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        const updates = req.body || {};
        // Do not allow setting api_key in plain response
        const merged = { ...current, ...updates };
        fs.writeFileSync(cfgPath, JSON.stringify(merged, null, 2));
        refreshEngineStateFromConfig();
        refreshProcessingStateFromConfig();
        res.json({ status: 'ok', note: 'Restart server to apply new config' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.patch('/engines/:engine', async (req, res) => {
    const { engine } = req.params;
    const supported = ['rag', 'summary'];
    if (!supported.includes(engine)) {
        return res.status(404).json({ error: `Unknown engine: ${engine}` });
    }
    const { enabled, clearOnDisable = false } = req.body || {};
    if (typeof enabled !== 'boolean') {
        return res.status(400).json({ error: 'enabled boolean required' });
    }

    try {
        if (engine === 'rag') {
            if (!enabled) {
                await stopActiveIndexer('rag disabled');
                if (clearOnDisable) {
                    await sqliteCacheManager.clearAll();
                    await faissIndexManager.clear();
                    resetInMemoryStats();
                    appendLog('RAG disabled: cache + FAISS cleared', 'warn');
                } else {
                    appendLog('RAG disabled: cache preserved', 'warn');
                }
            }
            updateEngineEnabled('rag', enabled, { persist: true });
            appendLog(`RAG engine ${enabled ? 'enabled' : 'disabled'}`, enabled ? 'info' : 'warn');
        } else if (engine === 'summary') {
            if (!enabled) {
                await sqliteCacheManager.clearRollingSummaries();
                appendLog('Summary disabled: rolling summaries cleared', 'warn');
            }
            updateEngineEnabled('summary', enabled, { persist: true });
            appendLog(`Summary engine ${enabled ? 'enabled' : 'disabled'}`, enabled ? 'info' : 'warn');
        }

        refreshEngineStateFromConfig();
        res.json({ status: 'ok', engines: getEnginesSnapshot() });
        void broadcastDashboardSnapshot();
    } catch (error) {
        appendLog(`Engine toggle failed (${engine}): ${error.message}`, 'error');
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

// LM Studio Model Management Endpoints
app.get('/lmstudio/models', async (req, res) => {
    try {
        const models = await listLoadedModels();
        res.json({ status: 'ok', models });
    } catch (error) {
        console.error('[API] Failed to list models:', error.message);
        res.status(500).json({ error: 'Failed to list loaded models', details: error.message });
    }
});

app.post('/lmstudio/models/unload', async (req, res) => {
    try {
        const { modelId } = req.body || {};
        if (!modelId) {
            return res.status(400).json({ error: 'modelId is required' });
        }

        const result = await unloadModel(modelId);
        appendLog(`Model unloaded: ${modelId}`, 'info');

        // Refresh context in case the unloaded model was the main model
        await refreshModelContext();

        res.json({ status: 'ok', ...result });
    } catch (error) {
        console.error('[API] Failed to unload model:', error.message);
        res.status(500).json({ error: 'Failed to unload model', details: error.message });
    }
});

app.post('/lmstudio/models/unload-all', async (req, res) => {
    try {
        const result = await unloadAllModels();
        appendLog('All models unloaded', 'info');

        // Refresh context since all models are unloaded
        await refreshModelContext();

        res.json({ status: 'ok', ...result });
    } catch (error) {
        console.error('[API] Failed to unload all models:', error.message);
        res.status(500).json({ error: 'Failed to unload all models', details: error.message });
    }
});

app.get('/lmstudio/server/status', async (req, res) => {
    try {
        const status = await getServerStatus();
        res.json({ status: 'ok', server: status });
    } catch (error) {
        console.error('[API] Failed to get server status:', error.message);
        res.status(500).json({ error: 'Failed to get server status', details: error.message });
    }
});

app.post('/lmstudio/context/refresh', async (req, res) => {
    try {
        await refreshModelContext();
        res.json({
            status: 'ok',
            context: {
                model_context_length: MODEL_CONTEXT_LENGTH,
                max_context_tokens: CONTEXT_MAX_TOKENS,
                context_budget_tokens: CONTEXT_BUDGET_TOKENS
            }
        });
    } catch (error) {
        console.error('[API] Failed to refresh context:', error.message);
        res.status(500).json({ error: 'Failed to refresh context', details: error.message });
    }
});

// LM Studio Server Management Endpoints
app.get('/lmstudio/health', async (req, res) => {
    try {
        const health = await checkLMStudioHealth();
        res.json({ status: 'ok', ...health });
    } catch (error) {
        console.error('[API] Health check failed:', error.message);
        res.status(503).json({ error: 'LM Studio health check failed', details: error.message });
    }
});

app.post('/lmstudio/server/start', async (req, res) => {
    try {
        const result = await startLMStudioServer();
        appendLog('LM Studio server started via API', 'info');
        res.json({ status: 'ok', ...result });
    } catch (error) {
        console.error('[API] Failed to start LM Studio server:', error.message);
        res.status(500).json({ error: 'Failed to start LM Studio server', details: error.message });
    }
});

app.post('/lmstudio/server/stop', async (req, res) => {
    try {
        const result = await stopLMStudioServer();
        appendLog('LM Studio server stopped via API', 'info');
        res.json({ status: 'ok', ...result });
    } catch (error) {
        console.error('[API] Failed to stop LM Studio server:', error.message);
        res.status(500).json({ error: 'Failed to stop LM Studio server', details: error.message });
    }
});

app.post('/lmstudio/models/load-required', async (req, res) => {
    try {
        const result = await ensureRequiredModelsLoaded();
        appendLog('Required models loaded via API', 'info');
        res.json({ status: 'ok', message: 'Required models loaded successfully' });
    } catch (error) {
        console.error('[API] Failed to load required models:', error.message);
        res.status(500).json({ error: 'Failed to load required models', details: error.message });
    }
});

app.post('/lmstudio/models/load-preset/:preset', async (req, res) => {
    try {
        const { preset } = req.params;
        if (!preset || !['high', 'medium', 'low'].includes(preset)) {
            return res.status(400).json({ error: 'Invalid preset. Must be one of: high, medium, low' });
        }

        const result = await ensurePresetModelsLoaded(preset);
        appendLog(`Preset '${preset}' models loaded via API: loaded=${result.loaded.length}, kept=${result.kept.length}, unloaded=${result.unloaded.length}`, 'info');
        
        res.json({ 
            status: 'ok', 
            message: `Preset '${preset}' models loaded successfully`,
            loaded: result.loaded,
            kept: result.kept,
            unloaded: result.unloaded,
            failed: result.failed,
            needsDownload: result.needsDownload
        });
    } catch (error) {
        console.error(`[API] Failed to load preset '${req.params.preset}' models:`, error.message);
        res.status(500).json({ error: 'Failed to load preset models', details: error.message });
    }
});

// =============================================================================
// Model Database API Endpoints
// =============================================================================

/**
 * GET /models/presets - Get all quality presets with their model options
 */
app.get('/models/presets', async (req, res) => {
    try {
        const presets = getPresets();
        const lastActive = getLastActiveModel();
        res.json({ presets, lastActiveModel: lastActive });
    } catch (error) {
        console.error('[API] Failed to get presets:', error.message);
        res.status(500).json({ error: 'Failed to get presets', details: error.message });
    }
});

/**
 * GET /models/specs/:id - Get detailed spec for a specific model
 */
app.get('/models/specs/:id', async (req, res) => {
    try {
        const modelId = decodeURIComponent(req.params.id);
        const spec = getModelSpec(modelId);
        if (!spec) {
            return res.status(404).json({ error: 'Model not found', modelId });
        }
        res.json(spec);
    } catch (error) {
        console.error('[API] Failed to get model spec:', error.message);
        res.status(500).json({ error: 'Failed to get model spec', details: error.message });
    }
});

/**
 * GET /models/suggested - Get models pending approval
 */
app.get('/models/suggested', async (req, res) => {
    try {
        const suggested = getSuggestedModels();
        res.json({ suggested });
    } catch (error) {
        console.error('[API] Failed to get suggested models:', error.message);
        res.status(500).json({ error: 'Failed to get suggested models', details: error.message });
    }
});

/**
 * POST /models/active - Set the currently active main model and load it in LM Studio
 * Uses smart switching: unloads previous main model, loads new one
 */
app.post('/models/active', async (req, res) => {
    try {
        const { modelId } = req.body || {};
        if (!modelId) {
            return res.status(400).json({ error: 'modelId required' });
        }

        // Get the previous active model before setting new one
        const previousModel = getLastActiveModel();
        
        // Save to database (store the original modelId for display purposes)
        const result = setActiveModel(modelId);
        appendLog(`Active model set to: ${modelId}`, 'info');

        // Ensure LM Studio is running
        const lmHealth = await checkLMStudioHealth();
        if (!lmHealth.ready) {
            console.log('[API] LM Studio not ready, starting server...');
            const cfg = getLMStudioConfig();
            if (await isLMStudioRunning(cfg.url)) {
                console.log('[LM Studio] Server already running.');
            } else {
                const cliPath = getLMStudioCLIPath();
                const args = ['server', 'start', '--port', (cfg.server_port || 1234).toString()];
                try {
                    const { spawn } = require('child_process');
                    const proc = spawn(cliPath, args, { stdio: 'inherit', shell: true });
                    await new Promise(resolve => setTimeout(resolve, 3000));
                } catch (startError) {
                    console.warn('[API] Failed to start LM Studio server:', startError.message);
                }
            }
            const healthAfter = await checkLMStudioHealth();
            if (!healthAfter.ready) {
                return res.status(503).json({ 
                    error: 'LM Studio server could not be started',
                    details: 'Please start LM Studio manually'
                });
            }
        }

        // Use switchMainModel to intelligently unload old and load new
        console.log(`[API] Switching main model from: ${previousModel || 'none'} to: ${modelId}`);
        
        const switchResult = await switchMainModel(modelId, previousModel);
        
        if (!switchResult.success) {
            if (switchResult.error?.includes('not found')) {
                return res.json({ 
                    status: 'ok', 
                    lastActiveModel: result,
                    warning: 'Model set but not found in LM Studio. It may need to be downloaded first.'
                });
            }
            return res.json({ 
                status: 'ok', 
                lastActiveModel: result,
                warning: switchResult.error || 'Model set but failed to load'
            });
        }

        appendLog(`Model switched: ${switchResult.unloaded ? `unloaded ${switchResult.unloaded}, ` : ''}loaded ${switchResult.loaded}`, 'info');
        
        res.json({ 
            status: 'ok', 
            lastActiveModel: result, 
            loadedModel: switchResult.loaded,
            unloadedModel: switchResult.unloaded || null,
            message: switchResult.message
        });
    } catch (error) {
        console.error('[API] Failed to set active model:', error.message);
        res.status(500).json({ error: 'Failed to set active model', details: error.message });
    }
});

/**
 * POST /models/discover - Trigger LLM discovery for new models
 */
app.post('/models/discover', async (req, res) => {
    try {
        appendLog('Starting model discovery...', 'info');
        const newModels = await discoverAndAnalyzeModels(generateCompletion);
        appendLog(`Model discovery complete. Found ${newModels.length} new models.`, 'info');
        res.json({ status: 'ok', discovered: newModels.length, models: newModels });
    } catch (error) {
        console.error('[API] Model discovery failed:', error.message);
        res.status(500).json({ error: 'Model discovery failed', details: error.message });
    }
});

/**
 * POST /models/approve/:id - Approve a suggested model into a preset tier
 */
app.post('/models/approve/:id', async (req, res) => {
    try {
        const modelId = decodeURIComponent(req.params.id);
        const { quality } = req.body || {};
        if (!quality || !['high', 'medium', 'low'].includes(quality)) {
            return res.status(400).json({ error: 'quality must be "high", "medium", or "low"' });
        }
        const updatedPreset = approveModel(modelId, quality);
        appendLog(`Model approved: ${modelId} for ${quality} tier`, 'info');
        res.json({ status: 'ok', preset: updatedPreset });
    } catch (error) {
        console.error('[API] Failed to approve model:', error.message);
        res.status(500).json({ error: 'Failed to approve model', details: error.message });
    }
});

/**
 * POST /models/dismiss/:id - Dismiss a suggested model
 */
app.post('/models/dismiss/:id', async (req, res) => {
    try {
        const modelId = decodeURIComponent(req.params.id);
        const remaining = dismissSuggestedModel(modelId);
        appendLog(`Suggested model dismissed: ${modelId}`, 'info');
        res.json({ status: 'ok', remaining: remaining.length });
    } catch (error) {
        console.error('[API] Failed to dismiss model:', error.message);
        res.status(500).json({ error: 'Failed to dismiss model', details: error.message });
    }
});

/**
 * POST /models/evaluate - Trigger LLM to evaluate and re-rank models
 */
app.post('/models/evaluate', async (req, res) => {
    try {
        const { quality, performanceData } = req.body || {};
        if (!quality || !['high', 'medium', 'low'].includes(quality)) {
            return res.status(400).json({ error: 'quality must be "high", "medium", or "low"' });
        }
        const reRanked = reRankPresetModels(quality, performanceData || {});
        appendLog(`Models re-ranked for ${quality} tier`, 'info');
        res.json({ status: 'ok', mainOptions: reRanked });
    } catch (error) {
        console.error('[API] Failed to evaluate models:', error.message);
        res.status(500).json({ error: 'Failed to evaluate models', details: error.message });
    }
});

/**
 * POST /models/download/:id - Download a model via LM Studio CLI
 * Returns immediately - download runs in background
 */
app.post('/models/download/:id', async (req, res) => {
    try {
        const modelId = decodeURIComponent(req.params.id);
        appendLog(`Starting model download: ${modelId}`, 'info');

        // Start download (runs in background, returns immediately)
        const result = await downloadModelFromDB(modelId);

        if (result.success) {
            appendLog(`Model download started: ${modelId}`, 'info');
            res.json({ 
                status: 'ok', 
                message: result.message,
                downloadStatus: result.status || 'downloading',
                modelId 
            });
        } else {
            // Check if already downloading
            if (result.status === 'downloading') {
                res.json({ 
                    status: 'ok', 
                    message: 'Download already in progress',
                    downloadStatus: 'downloading',
                    modelId 
                });
            } else {
                appendLog(`Model download failed: ${modelId} - ${result.message}`, 'warn');
                res.status(500).json({ error: 'Download failed', details: result.message });
            }
        }
    } catch (error) {
        console.error('[API] Failed to download model:', error.message);
        res.status(500).json({ error: 'Failed to download model', details: error.message });
    }
});

/**
 * GET /models/status - Get availability status for all preset models
 */
app.get('/models/status', async (req, res) => {
    try {
        const availability = getModelAvailability();
        const downloads = getActiveDownloads();
        
        // Get currently loaded models from LM Studio
        let loadedModels = [];
        try {
            const lmModels = await listLoadedModels();
            loadedModels = lmModels.map(model => model.id || model.identifier).filter(Boolean);
        } catch (error) {
            console.warn('[API] Failed to get loaded models from LM Studio:', error.message);
        }
        
        res.json({ status: 'ok', availability, activeDownloads: downloads, loadedModels });
    } catch (error) {
        console.error('[API] Failed to get model status:', error.message);
        res.status(500).json({ error: 'Failed to get model status', details: error.message });
    }
});

/**
 * POST /models/validate - Re-validate all presets against downloaded models
 */
app.post('/models/validate', async (req, res) => {
    try {
        const { initializeModelDatabase: initDB } = require('./model_db_service.js');
        const result = await initDB();
        appendLog(`Model validation complete: ${result.available.length} available, ${result.missing.length} missing`, 'info');
        res.json({ status: 'ok', ...result });
    } catch (error) {
        console.error('[API] Failed to validate models:', error.message);
        res.status(500).json({ error: 'Failed to validate models', details: error.message });
    }
});

/**
 * GET /models/bootstrap-status - Get current bootstrap status
 */
app.get('/models/bootstrap-status', (req, res) => {
    try {
        const status = getBootstrapStatus();
        res.json({ status: 'ok', ...status });
    } catch (error) {
        console.error('[API] Failed to get bootstrap status:', error.message);
        res.status(500).json({ error: 'Failed to get bootstrap status', details: error.message });
    }
});

/**
 * POST /models/bootstrap - Trigger model bootstrap process
 */
app.post('/models/bootstrap', async (req, res) => {
    try {
        const modelDbService = require('./model_db_service.js');
        appendLog('Starting model bootstrap...', 'info');
        
        // Run bootstrap in background, return immediately
        runBootstrap(modelDbService).then(result => {
            if (result.success) {
                appendLog(`Bootstrap complete: ${result.message}`, 'info');
            } else {
                appendLog(`Bootstrap failed: ${result.message}`, 'warn');
            }
        }).catch(error => {
            appendLog(`Bootstrap error: ${error.message}`, 'error');
        });
        
        res.json({ status: 'ok', message: 'Bootstrap started' });
    } catch (error) {
        console.error('[API] Failed to start bootstrap:', error.message);
        res.status(500).json({ error: 'Failed to start bootstrap', details: error.message });
    }
});

app.patch('/processing/summary-keep', (req, res) => {
    const { keepRecentTurns } = req.body || {};
    const parsed = Number(keepRecentTurns);
    if (!Number.isFinite(parsed) || parsed < 0) {
        return res.status(400).json({ error: 'keepRecentTurns must be a non-negative number' });
    }
    const updated = setSummaryKeepRecentTurns(parsed, { persist: true });
    appendLog(`Summary keep-recent set to ${updated}`, 'info');
    res.json({ status: 'ok', keepRecentTurns: updated });
});

app.patch('/processing/context-mode', (req, res) => {
    const { defaultMode = null, rawMarginPct = null } = req.body || {};
    if (defaultMode === null && rawMarginPct === null) {
        return res.status(400).json({ error: 'Provide defaultMode and/or rawMarginPct' });
    }
    let updatedMode = getContextModeDefault();
    let updatedMargin = getRawContextMarginPct();

    if (defaultMode !== null) {
        const normalized = normalizePolicyModeValue(defaultMode);
        if (!normalized) {
            return res.status(400).json({ error: 'defaultMode must be "raw" or "compressed"' });
        }
        updatedMode = setContextModeDefault(normalized, { persist: true });
        appendLog(`Global context mode set to ${updatedMode}`, 'info');
    }

    if (rawMarginPct !== null) {
        const parsed = Number(rawMarginPct);
        if (!Number.isFinite(parsed)) {
            return res.status(400).json({ error: 'rawMarginPct must be numeric' });
        }
        updatedMargin = setRawContextMarginPct(parsed, { persist: true });
        appendLog(`Raw context margin set to ${updatedMargin}`, 'info');
    }

    res.json({ status: 'ok', defaultMode: updatedMode, rawMarginPct: updatedMargin });
});

app.post('/summary/reprocess', async (req, res) => {
    try {
        const { conversationId = null } = req.body || {};
        const keepRecentTurns = getSummaryKeepRecentTurns();
        const targets = conversationId ? [conversationId] : await sqliteCacheManager.getAllConversationIds();
        const processed = [];
        for (const targetId of targets) {
            if (!targetId) continue;
            try {
                const summary = await recomputeRollingSummary(targetId, keepRecentTurns);
                processed.push({
                    conversationId: targetId,
                    turnCount: summary?.turnCount || 0,
                    summaryLength: summary?.summary ? summary.summary.length : 0,
                });
            } catch (err) {
                appendLog(`Summary reprocess failed for ${targetId}: ${err?.message || err}`, 'error');
            }
        }
        res.json({ status: 'ok', processed: processed.length, keepRecentTurns, details: processed });
    } catch (error) {
        console.error('[Server] /summary/reprocess error:', error);
        res.status(500).json({ error: error.message });
    }
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

app.patch('/sessions/:conversationId/context-mode', async (req, res) => {
    const { conversationId } = req.params;
    if (!conversationId) {
        return res.status(400).json({ error: 'conversationId required' });
    }
    const { mode = null } = req.body || {};
    const normalized = mode === null ? null : normalizePolicyModeValue(mode);
    if (mode !== null && !normalized) {
        return res.status(400).json({ error: 'mode must be "raw" or "compressed" (or null to reset)' });
    }
    try {
        if (normalized) {
            await sqliteCacheManager.setSessionContextMode(conversationId, normalized);
        } else {
            await sqliteCacheManager.clearSessionContextMode(conversationId);
        }
        const summary = await sqliteCacheManager.getSessionSummary(conversationId);
        const decorated = summary ? decorateSessionMetaRows([summary])[0] : buildFallbackSessionMeta(conversationId);
        void pushSessionUpdate({ sessionId: conversationId, turn: null });
        res.json({ status: 'ok', session: decorated });
    } catch (error) {
        console.error('[Server] /sessions/:id/context-mode error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/sessions', async (req, res) => {
    const limitParam = parseInt(req.query.limit || `${SESSION_METADATA_LIMIT}`, 10);
    const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 500) : SESSION_METADATA_LIMIT;
    const requestedMode = req.query.contextMode || null;
    try {
        const sessions = await getSessionList({ limit, contextMode: requestedMode });
        res.json({ sessions, limit, contextMode: normalizeContextModeValue(requestedMode) });
    } catch (error) {
        console.error('[Server] /sessions error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/sessions/:conversationId/turns', async (req, res) => {
    const { conversationId } = req.params;
    if (!conversationId) {
        return res.status(400).json({ error: 'conversationId required' });
    }
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
    const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);
    try {
        const turns = await sqliteCacheManager.getConversationTurns(conversationId, { limit, offset });
        res.json({
            sessionId: conversationId,
            turns,
            pagination: { limit, offset },
        });
    } catch (error) {
        console.error('[Server] /sessions/:id/turns error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/search', async (req, res) => {
    try {
        const { query, topK = 5 } = req.body;
        if (!query) return res.status(400).json({ error: 'query required' });
        if (!isRagFeatureEnabled()) {
            return res.json({ results: [], disabled: true, message: 'RAG is disabled in the current runtime mode.' });
        }
        console.log(`[Search] Starting RAG search for query: ${query}`);
        const results = await ragSearch(query, topK);
        console.log(`[Search] RAG search returned ${results.length} results`);
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
        const headerConversationId = extractConversationIdFromHeaders(req);
        const resolved = resolveConversationId(requestedConversationId, {
            headerId: headerConversationId,
            fallbackId: DEFAULT_CONVERSATION_ID,
        });
        sessionId = resolved.sessionId;
        const summaryActive = isSummaryFeatureEnabled();
        const summaryKeepRecentTurns = summaryActive ? getSummaryKeepRecentTurns() : 0;

        // Retrieve latest rolling summary (long-term memory)
        let latestSummary = null;
        let rollingSummaryText = '';
        let formattedRecentTurns = [];
        if (summaryActive) {
            latestSummary = await sqliteCacheManager.getLatestRollingSummary(sessionId);
            rollingSummaryText = latestSummary ? sanitizeSummaryText(latestSummary.summary) : '';
            formattedRecentTurns = await getFormattedRecentTurns(sessionId, summaryKeepRecentTurns);
        }

        // RAG search
        const ragResults = await ragSearch(prompt, topK);

        const sessionMode = await resolveSessionContextMode(sessionId);
        const fallbackThresholdTokens = getRawFallbackThresholdTokens();

        // Build context (compressed, raw, or fallback)
        const {
            contextText: composedPrompt,
            rawContextText,
            budgetInfo: composedBudget,
            appliedMode: appliedContextMode
        } = buildContextPayload({
            sessionMode,
            summaryEnabled: summaryActive,
            rollingSummaryText,
            recentTurns: formattedRecentTurns,
            ragResults,
            userPrompt: null,
            fallbackThresholdTokens,
            excludeUserPrompt: true,
        });
        budgetInfo = composedBudget;

        // Append user prompt to avoid duplication
        const fullPrompt = composedPrompt + '\n\nUser: ' + prompt;

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
        const completionRequest = {
            prompt: fullPrompt,
            systemPrompt: BASE_SYSTEM_PROMPT,
            temperature,
        };
        const completion = await generateCompletion(completionRequest);
        const llmPayloadKind = 'completion';
        const llmPayload = {
            ...completionRequest,
            model: mainModelCfg.identifier,
        };
        const completionText = sanitizeAssistantText(extractAssistantText(completion));

        let newRollingSummary = null;

        const persistedTurn = await persistConversationTurn({
            sessionId,
            userPrompt: prompt,
            assistantResponse: completionText,
            rawContextText,
            composedContextText: composedPrompt,
            budgetInfo,
            ragResults,
            llmPayloadKind,
            llmPayload,
        });

        void pushSessionUpdate({ sessionId, turn: persistedTurn });

        if (summaryActive) {
            newRollingSummary = await recomputeRollingSummary(sessionId, summaryKeepRecentTurns);
            if (newRollingSummary) {
                metrics.lastSummaryAction = {
                    ts: Date.now(),
                    sessionId,
                    turnCount: newRollingSummary?.turnCount || 0,
                    summaryText: (newRollingSummary?.summary || '').slice(0, 1200),
                    summaryLength: newRollingSummary?.summary ? newRollingSummary.summary.length : 0
                };
            }
        }

        res.json({
            sessionId,
            completion,
            rag: ragResults,
            rollingSummary: summaryActive ? newRollingSummary?.summary : null,
            summaryMeta: summaryActive ? { turnCount: newRollingSummary?.turnCount || 0 } : null,
            budget: budgetInfo,
            contextMode: appliedContextMode || sessionMode
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
            sessionId,
            contextMode: appliedContextMode || sessionMode
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
            sessionId,
            contextMode: budgetInfo?.mode || null
        });
        console.error('[Server] /query error:', error);
        res.status(500).json({ error: error.message, sessionId });
    }
});

/**
 * Reindex endpoint: runs the middleware indexing flow.
 */
app.post('/reindex', async (req, res) => {
    if (!isRagFeatureEnabled()) {
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
        if (isRagFeatureEnabled()) {
            appendLog('Reindex after reset scheduled', 'info');
            void startIndexer({ reason: 'reset', background: true });
        } else {
            appendLog('Reindex skipped: RAG disabled in current mode', 'info');
        }
        res.json({ status: 'ok', message: isRagFeatureEnabled() ? 'Reset done; reindex started' : 'Reset done; RAG disabled so no reindex' });
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
        const { messages = [], temperature = 0.2, model: requestedModel, stream = false, topK = 5, conversationId: requestedConversationId, ...rest } = req.body || {};
        if (!Array.isArray(messages) || messages.length === 0) {
            return res.status(400).json({ error: 'messages array required' });
        }
        const headerConversationId = extractConversationIdFromHeaders(req);
        const resolved = resolveConversationId(requestedConversationId, {
            headerId: headerConversationId,
            fallbackId: DEFAULT_CONVERSATION_ID,
        });
        sessionId = resolved.sessionId;
        const summaryActive = isSummaryFeatureEnabled();
        const summaryKeepRecentTurns = summaryActive ? getSummaryKeepRecentTurns() : 0;

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
        let rollingSummaryText = '';
        let formattedRecentTurns = [];
        if (summaryActive) {
            try {
                latestSummary = await sqliteCacheManager.getLatestRollingSummary(sessionId);
                rollingSummaryText = latestSummary ? sanitizeSummaryText(latestSummary.summary) : '';
                formattedRecentTurns = await getFormattedRecentTurns(sessionId, summaryKeepRecentTurns);
            } catch (sumErr) {
                void logDebugEvent({
                    location: 'server.js:handleChatCompletions summary error',
                    message: 'latestSummary failed',
                    data: { error: sumErr?.message || String(sumErr) },
                    hypothesisId: 'H5'
                });
                throw sumErr;
            }
        }
        
        // RAG search
        try {
                        ragResults = await ragSearch(userPrompt, topK);
        } catch (ragErr) {
                        throw ragErr;
        }
        
        const sessionMode = await resolveSessionContextMode(sessionId);
        const fallbackThresholdTokens = getRawFallbackThresholdTokens();

        // Build context (compressed, raw, or fallback)
        const {
            contextText: composedPrompt,
            rawContextText,
            budgetInfo: composedBudget,
            appliedMode: appliedContextMode
        } = buildContextPayload({
            sessionMode,
            summaryEnabled: summaryActive,
            rollingSummaryText,
            recentTurns: formattedRecentTurns,
            ragResults,
            userPrompt: null,
            fallbackThresholdTokens,
            excludeUserPrompt: true,
        });
        budgetInfo = composedBudget;
        
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
        const mainModel = getModelConfig('main').identifier;
        const forceModel = getConfig().models?.force_model ?? false;
        const modelToUse = forceModel ? mainModel : (requestedModel || mainModel);
        
        if (stream) {
            const lmStarted = Date.now();
            const chatRequestPayload = {
                model: modelToUse,
                messages: enhancedMessages,
                temperature,
                stream: true,
                ...rest,
            };
            
            // Prepare SSE headers before streaming
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            if (!res.writableEnded) {
                res.write(`data: ${JSON.stringify({ type: 'session', sessionId })}\n\n`);
            }

            let streamedContent = '';
            try {
                streamedContent = await proxyChatCompletion(chatRequestPayload, res);
                streamedContent = sanitizeAssistantText(streamedContent);
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
                    sessionId,
                    contextMode: budgetInfo?.mode || null
                });
                return;
            }

            const lmDuration = Date.now() - lmStarted;
            const duration = Date.now() - started;
            console.log(`[RESP] ${pathLabel} STREAM 200 in ${duration}ms (LM ${lmDuration}ms) rag=${ragResults.length}`);

            const persistedTurn = await persistConversationTurn({
                sessionId,
                userPrompt,
                assistantResponse: streamedContent,
                rawContextText,
                composedContextText: composedPrompt,
                budgetInfo,
                ragResults,
                llmPayloadKind: 'chat',
                llmPayload: chatRequestPayload,
            });
            void pushSessionUpdate({ sessionId, turn: persistedTurn });
            
            // Update rolling summary asynchronously
            if (summaryActive) {
                recomputeRollingSummary(sessionId, summaryKeepRecentTurns)
                    .then(summary => {
                        if (summary) {
                            metrics.lastSummaryAction = {
                                ts: Date.now(),
                                sessionId,
                                turnCount: summary?.turnCount || 0,
                                summaryText: (summary?.summary || '').slice(0, 1200),
                                summaryLength: summary?.summary ? summary.summary.length : 0
                            };
                        }
                    })
                    .catch(err => 
                        console.error('[Server] Failed to update rolling summary:', err)
                    );
            }
            
            updateMetrics(duration, budgetInfo, true);
            recordRequest({
                ts: Date.now(),
                path: pathLabel,
                duration,
                ragHits: ragResults.length,
                budget: budgetInfo,
                status: 200,
                sessionId,
                contextMode: appliedContextMode || sessionMode
            });
            return;
        }

        
        // Non-streaming: get completion and return OpenAI format
        const chatCompletionRequest = {
            prompt: composedPrompt,
            systemPrompt: BASE_SYSTEM_PROMPT,
            temperature,
        };
        const completionResponse = await generateCompletion(chatCompletionRequest);
        const nonStreamPayload = {
            ...chatCompletionRequest,
            model: modelToUse,
        };
        
        // Extract content
        const content = sanitizeAssistantText(extractAssistantText(completionResponse));

        const persistedTurn = await persistConversationTurn({
            sessionId,
            userPrompt,
            assistantResponse: content,
            rawContextText,
            composedContextText: composedPrompt,
            budgetInfo,
            ragResults,
            llmPayloadKind: 'completion',
            llmPayload: nonStreamPayload,
        });
        void pushSessionUpdate({ sessionId, turn: persistedTurn });

        // Update rolling summary
        if (summaryActive) {
            const newRollingSummary = await recomputeRollingSummary(sessionId, summaryKeepRecentTurns);
            if (newRollingSummary) {
                metrics.lastSummaryAction = {
                    ts: Date.now(),
                    sessionId,
                    turnCount: newRollingSummary?.turnCount || 0,
                    summaryText: (newRollingSummary?.summary || '').slice(0, 1200),
                    summaryLength: newRollingSummary?.summary ? newRollingSummary.summary.length : 0
                };
            }
        }

        // Return OpenAI-compatible format
        res.json({
            id: `chatcmpl-${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: modelToUse,
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
            session_id: sessionId,
            context_mode: appliedContextMode || sessionMode
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
            sessionId,
            contextMode: appliedContextMode || sessionMode
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
            sessionId,
            contextMode: budgetInfo?.mode || null
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

        // Initialize LM Studio and load required models
        console.log('[Server] Initializing LM Studio...');
        try {
            // await initializeLMStudioWithModels();
            console.log('[Server] LM Studio initialization skipped');
            console.log('[Server] LM Studio initialization successful');
        } catch (error) {
            console.warn('[Server] LM Studio initialization failed, continuing without models:', error.message);
            console.warn('[Server] You may need to start LM Studio manually and load models');
        }

        // Initialize model database (validate presets, check availability)
        console.log('[Server] Initializing model database...');
        try {
            const { available, missing, discovered } = await initializeModelDatabase();
            console.log(`[Server] Model database initialized: ${available.length} available, ${missing.length} missing, ${discovered} discovered`);
            if (missing.length > 0) {
                console.log('[Server] Missing models:', missing.slice(0, 5).join(', ') + (missing.length > 5 ? '...' : ''));
            }
        } catch (error) {
            console.warn('[Server] Model database initialization failed:', error.message);
        }

        // Run model bootstrap (analyzes models and populates presets)
        console.log('[Server] Running model bootstrap...');
        try {
            const modelDbService = require('./model_db_service.js');
            const bootstrapResult = await runBootstrap(modelDbService);
            if (bootstrapResult.success) {
                console.log(`[Server] Bootstrap complete: ${bootstrapResult.message}`);
            } else {
                console.warn(`[Server] Bootstrap incomplete: ${bootstrapResult.message}`);
            }
        } catch (error) {
            console.warn('[Server] Model bootstrap failed:', error.message);
        }

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

