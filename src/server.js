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
const rateLimit = require('express-rate-limit');
const Joi = require('joi');
const { WebSocketServer } = WebSocketLib;
const { embedText, summarizeConversation, generateCompletion, proxyChatCompletion, warmModel, warmEmbeddingModel, waitForModelsLoaded, unloadModel, unloadAllModels, listLoadedModels, getServerStatus, startLMStudioServer, stopLMStudioServer, checkLMStudioHealth, ensureRequiredModelsLoaded, ensurePresetModelsLoaded, switchMainModel, initializeLMStudioWithModels } = require('./lmstudio_client.js');
const { SQLiteCacheManager } = require('./sqlite_cache.js');
const { FAISSIndexManager } = require('./faiss_storage.js');
const { initializeLMStudio, isLMStudioRunning } = require('./lmstudio_manager.js');
const { getProcessingConfig, getModelConfig, getConfig, getLMStudioConfig, getStorageConfig, getSessionConfig, updateConfigFile, refreshConfig, getToolCallingConfig, updateToolCallingConfig } = require('./config.js');
const { getRuntimeMode, isCloudMode, requireModeHealthCheck } = require('./runtime.js');
const { main: runIndexer } = require('./middleware.js'); // to trigger reindex
const { getIndexingStatus, initializeIndexingStatusFromDatabase } = require('./indexer/indexer.js');
const { logDebugEvent, isTelemetryEnabled, setTelemetryOverride, getTelemetryOverride } = require('./debug_logger.js');
const { createRagService } = require('./services/rag_service.js');
const { logger, requestLogger, createChildLogger } = require('./logger.js');
const os = require('os');
const {
    getSummaryKeepRecentTurns,
    setSummaryKeepRecentTurns,
    refreshProcessingStateFromConfig,
    getContextModeDefault,
    setContextModeDefault,
    getRawContextMarginPct,
    setRawContextMarginPct,
    getMainModelMaxContext,
} = require('./processing_state.js');
const { countTokensPerMessage } = require('./tokenizer.js');
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
const { runBootstrap, getBootstrapStatus, setStatusBroadcastCallback } = require('./model_bootstrap.js');

// Global error logging to avoid silent crashes (opt-in via debug logger)
process.on('unhandledRejection', (err) => {
    logger.error('Unhandled rejection:', { error: err?.message || String(err), stack: err?.stack });
    void logDebugEvent({
        location: 'server.js:unhandledRejection',
        message: 'unhandled rejection',
        data: { error: err?.message || String(err), stack: err?.stack },
        hypothesisId: 'HX'
    });
});

// Graceful shutdown handlers
let serverShutdown = false;
let httpServer = null;

function gracefulShutdown(signal) {
    if (serverShutdown) return;
    serverShutdown = true;

    logger.info(`Received ${signal}, initiating graceful shutdown...`);

    // Stop accepting new connections
    if (httpServer) {
        httpServer.close(() => {
            logger.info('HTTP server closed');
        });
    }

    // Close WebSocket server
    teardownWebsocketServer();

    // Close database connections
    if (sqliteCacheManager) {
        sqliteCacheManager.close().catch(err => {
            logger.error('Error closing SQLite connection:', err);
        });
    }

    // Stop any active indexing
    stopActiveIndexer('shutdown').then(() => {
        logger.info('Active indexer stopped');
    }).catch(err => {
        logger.error('Error stopping indexer:', err);
    });

    // Unload all models
    unloadAllModels().then(() => {
        logger.info('All models unloaded');
    }).catch(err => {
        logger.error('Error unloading models:', err);
    });

    // Give everything 5 seconds to cleanup, then force exit
    setTimeout(() => {
        logger.error('Forced shutdown after timeout');
        process.exit(1);
    }, 5000);

    // Normal exit after cleanup
    setTimeout(() => {
        logger.info('Graceful shutdown completed');
        process.exit(0);
    }, 1000);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception:', { error: err.message, stack: err.stack });
    gracefulShutdown('uncaughtException');
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

// =============================================================================
// CONFIG VALIDATION - Run at startup to catch misconfigurations early
// =============================================================================

async function validateConfigConsistency() {
    const issues = [];
    const warnings = [];

    try {
        const config = getConfig();
        const { getRagPipelineConfig, RAG_PIPELINE_TIERS } = require('./rag_pipeline_config.js');
        const modelsJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/models.json'), 'utf-8'));

        // 1. Check if activePreset is valid
        const activePreset = config.models?.activePreset;
        if (activePreset && !['high', 'medium', 'low', 'custom'].includes(activePreset)) {
            issues.push(`Invalid activePreset: "${activePreset}". Must be high/medium/low/custom.`);
        }

        // 2. Check if RAG tier is valid
        const ragTier = config.ragPipeline?.tier;
        if (ragTier && !['high', 'medium', 'low'].includes(ragTier)) {
            issues.push(`Invalid ragPipeline.tier: "${ragTier}". Must be high/medium/low.`);
        }

        // 3. Check if saved model selections exist in preset options
        const presets = modelsJson.presets || {};
        for (const tier of ['high', 'medium', 'low']) {
            const savedMain = config.models?.perQualityMainModels?.[tier];
            const savedRolling = config.models?.perQualityRollingSummarizers?.[tier];
            const presetOptions = presets[tier]?.mainOptions || [];
            const rollingSummarizerOptions = presets[tier]?.rollingSummarizerOptions || [];

            if (savedMain && presetOptions.length > 0 && !presetOptions.includes(savedMain)) {
                warnings.push(`Saved main model for ${tier} ("${savedMain}") not in preset options. Will use first available.`);
                // Auto-fix: set to first option
                if (!config.models.perQualityMainModels) config.models.perQualityMainModels = {};
                config.models.perQualityMainModels[tier] = presetOptions[0];
            }

            if (savedRolling && rollingSummarizerOptions.length > 0 && !rollingSummarizerOptions.includes(savedRolling)) {
                warnings.push(`Saved rolling summarizer for ${tier} ("${savedRolling}") not in preset options. Will use first available.`);
                // Auto-fix: set to first option
                if (!config.models.perQualityRollingSummarizers) config.models.perQualityRollingSummarizers = {};
                config.models.perQualityRollingSummarizers[tier] = rollingSummarizerOptions[0];
            }
        }

        // 4. Check models.json presets have required rollingSummarizerOptions
        for (const tier of ['high', 'medium', 'low']) {
            if (!presets[tier]?.rollingSummarizerOptions || presets[tier].rollingSummarizerOptions.length === 0) {
                warnings.push(`Preset "${tier}" missing rollingSummarizerOptions. Users won't be able to select rolling summarizers.`);
            }
        }

        // 5. Check RAG pipeline models match between rag_pipeline_config.js and models.json
        for (const tier of ['high', 'medium', 'low']) {
            const pipelineConfig = getRagPipelineConfig(tier);
            const presetRagSum = presets[tier]?.ragSummarizer;
            
            if (pipelineConfig.ragSummarizer?.identifier && presetRagSum && 
                pipelineConfig.ragSummarizer.identifier !== presetRagSum) {
                warnings.push(`RAG summarizer mismatch for ${tier}: rag_pipeline_config.js says "${pipelineConfig.ragSummarizer.identifier}" but models.json says "${presetRagSum}".`);
            }
        }

        // 6. Check for blacklisted models in config
        const { isModelBlacklisted, MODEL_BLACKLIST } = require('./model_bootstrap.js');
        
        // Check default rolling summarizer
        const defaultRollingSummarizer = config.models?.rollingSummarization?.identifier;
        if (defaultRollingSummarizer) {
            const check = isModelBlacklisted(defaultRollingSummarizer);
            if (check.blacklisted) {
                warnings.push(`Default rolling summarizer "${defaultRollingSummarizer}" is blacklisted: ${check.reason}. Will be replaced with safe fallback.`);
            }
        }
        
        // Check per-tier summarizers
        for (const tier of ['high', 'medium', 'low']) {
            const tierSummarizer = config.models?.perQualityRollingSummarizers?.[tier];
            if (tierSummarizer) {
                const check = isModelBlacklisted(tierSummarizer);
                if (check.blacklisted) {
                    warnings.push(`Rolling summarizer for ${tier} ("${tierSummarizer}") is blacklisted: ${check.reason}`);
                    // Auto-fix: Find a non-blacklisted alternative
                    const alternatives = presets[tier]?.rollingSummarizerOptions || [];
                    const safeAlt = alternatives.find(m => !isModelBlacklisted(m).blacklisted);
                    if (safeAlt) {
                        if (!config.models.perQualityRollingSummarizers) config.models.perQualityRollingSummarizers = {};
                        config.models.perQualityRollingSummarizers[tier] = safeAlt;
                        warnings.push(`Auto-fixed ${tier} summarizer to: ${safeAlt}`);
                    }
                }
            }
        }

        // Log results
        if (issues.length > 0) {
            logger.error('❌ Config validation ERRORS (may cause issues):');
            issues.forEach(issue => logger.error(`   - ${issue}`));
        }

        if (warnings.length > 0) {
            logger.warn('⚠️  Config validation WARNINGS:');
            warnings.forEach(warning => logger.warn(`   - ${warning}`));
        }

        if (issues.length === 0 && warnings.length === 0) {
            logger.info('✅ Config validation passed - all configurations are consistent');
        }

        // Save auto-fixed config if warnings were found
        if (warnings.length > 0) {
            try {
                updateConfigFile(cfg => {
                    if (config.models?.perQualityMainModels) {
                        cfg.models.perQualityMainModels = config.models.perQualityMainModels;
                    }
                    if (config.models?.perQualityRollingSummarizers) {
                        cfg.models.perQualityRollingSummarizers = config.models.perQualityRollingSummarizers;
                    }
                    return cfg;
                });
                logger.info('✅ Auto-fixed config saved');
            } catch (e) {
                logger.warn('Could not save auto-fixed config:', e.message);
            }
        }

        return { issues, warnings };
    } catch (error) {
        logger.error('Config validation failed:', error.message);
        return { issues: [`Validation error: ${error.message}`], warnings: [] };
    }
}

const app = express();
app.use(express.json({ limit: '2mb' }));

// Add request logging middleware
app.use(requestLogger);

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
    message: 'Too many requests from this IP, please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
});

// Stricter rate limiting for sensitive endpoints
const strictLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10, // limit each IP to 10 requests per windowMs
    message: 'Too many sensitive requests, please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
});

// Apply general rate limiting
app.use('/api/', limiter);

// Apply strict rate limiting to sensitive endpoints
app.use('/presets', strictLimiter);
app.use('/models/download', strictLimiter);
app.use('/lmstudio/models', strictLimiter);

// Input validation middleware
function validateInput(schema) {
    return (req, res, next) => {
        const { error } = schema.validate(req.body, { abortEarly: false });
        if (error) {
            logger.warn('Input validation failed:', {
                path: req.path,
                method: req.method,
                errors: error.details.map(d => d.message)
            });
            return res.status(400).json({
                error: 'Validation failed',
                details: error.details.map(d => ({
                    field: d.path.join('.'),
                    message: d.message
                }))
            });
        }
        next();
    };
}

// Validation schemas
const presetModelSchema = Joi.object({
    quality: Joi.string().valid('high', 'medium', 'low').required(),
    modelId: Joi.string().min(1).max(200).required()
});

const presetSummarizerSchema = Joi.object({
    quality: Joi.string().valid('high', 'medium', 'low').required(),
    summarizerId: Joi.string().min(1).max(200).required()
});

const customPresetSchema = Joi.object({
    main: Joi.string().min(1).max(200).allow(null),
    rollingSummarizer: Joi.string().min(1).max(200).allow(null)
});

const modelLockSchema = Joi.object({
    modelId: Joi.string().min(1).max(200).required(),
    lockType: Joi.string().valid('loaded', 'preset').optional()
});

const downloadSchema = Joi.object({
    modelId: Joi.string().min(1).max(200).required(),
    quantization: Joi.string().valid('q4_k_m', 'q5_k_m', 'q8_0', 'q3_k_m', 'q2_k').optional()
});

const searchQuerySchema = Joi.object({
    query: Joi.string().min(1).max(100).required(),
    limit: Joi.number().integer().min(1).max(50).optional()
});

const chatCompletionSchema = Joi.object({
    messages: Joi.array().items(
        Joi.object({
            role: Joi.string().valid('system', 'user', 'assistant').required(),
            content: Joi.string().min(1).max(10000).required()
        })
    ).min(1).required(),
    model: Joi.string().optional(),
    temperature: Joi.number().min(0).max(2).optional(),
    max_tokens: Joi.number().integer().min(1).max(32768).optional(),
    stream: Joi.boolean().optional()
});

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
    await initializeLMStudio();
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

/**
 * Broadcast bootstrap status to all WebSocket clients
 * This is called by model_bootstrap.js when status changes
 */
function broadcastBootstrapStatus(status) {
    broadcastWsMessage({ 
        type: 'bootstrap-status', 
        status: status 
    });
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

/**
 * Run the summarization model on a list of messages.
 * @param {Array<{role: string, content: string}>} messages - Messages to summarize
 * @returns {Promise<string>} - Summary text
 */
async function runSummarizationModel(messages) {
    if (!messages || messages.length === 0) {
        return '';
    }
    
    // Format messages into a transcript
    const transcript = messages
        .map(msg => {
            const role = msg.role === 'user' ? 'User' : msg.role === 'assistant' ? 'Assistant' : msg.role;
            return `${role}: ${msg.content || ''}`;
        })
        .filter(Boolean)
        .join('\n\n');
    
    if (!transcript.trim()) {
        return '';
    }
    
    try {
        const summaryRaw = await summarizeConversation(transcript);
        return sanitizeSummaryText(summaryRaw);
    } catch (err) {
        console.error('[Summary] Failed to run summarization model:', err?.message || err);
        throw err;
    }
}

/**
 * Emergency truncation - ensures messages fit within token limit.
 * Keeps system message, truncates oldest conversation messages, keeps latest user message.
 * This is a fallback when summarization fails - prevents context overflow errors.
 * @param {Array<{role: string, content: string}>} messages - Chat messages
 * @param {number} maxTokens - Maximum allowed tokens
 * @returns {Promise<Array<{role: string, content: string}>>} - Truncated messages that fit
 */
async function truncateMessagesToFit(messages, maxTokens) {
    const { truncateToTokenLimit } = require('./tokenizer.js');
    
    if (!messages || messages.length === 0) return messages;
    
    // Reserve 10% margin for safety
    const targetTokens = Math.floor(maxTokens * 0.9);
    
    // Always keep: system message (first) and last user message
    const systemMsg = messages[0];
    const lastUserIdx = messages.map((m, i) => ({ m, i })).filter(x => x.m.role === 'user').pop()?.i;
    const lastUserMsg = lastUserIdx !== undefined ? messages[lastUserIdx] : null;
    
    // Count system message tokens
    const systemTokens = await countTokensPerMessage([systemMsg]);
    let usedTokens = systemTokens[0] || 0;
    
    // Reserve space for last user message
    let userMsgTokens = 0;
    if (lastUserMsg) {
        const userTokenCounts = await countTokensPerMessage([lastUserMsg]);
        userMsgTokens = userTokenCounts[0] || 0;
    }
    
    const budgetForMiddle = targetTokens - usedTokens - userMsgTokens;
    
    if (budgetForMiddle <= 0) {
        // Extreme case: even system + user don't fit, truncate system content
        console.warn('[Summary] Emergency: truncating system message content');
        const truncatedSystemContent = await truncateToTokenLimit(
            systemMsg.content, 
            Math.floor(targetTokens * 0.5)
        );
        return [
            { role: 'system', content: truncatedSystemContent + '\n\n[Context truncated due to length limits]' },
            lastUserMsg || messages[messages.length - 1]
        ];
    }
    
    // Work backwards from last message (excluding user if we have it), keep what fits
    const result = [systemMsg];
    const middleMessages = messages.slice(1, lastUserIdx !== undefined ? lastUserIdx : messages.length);
    let remainingBudget = budgetForMiddle;
    const keptMiddle = [];
    
    // Start from newest (closest to current) and work backwards
    for (let i = middleMessages.length - 1; i >= 0; i--) {
        const msg = middleMessages[i];
        const [msgTokens] = await countTokensPerMessage([msg]);
        
        if (msgTokens <= remainingBudget) {
            keptMiddle.unshift(msg);
            remainingBudget -= msgTokens;
        } else {
            // Can't fit more, stop
            break;
        }
    }
    
    result.push(...keptMiddle);
    if (lastUserMsg) {
        result.push(lastUserMsg);
    }
    
    const droppedCount = middleMessages.length - keptMiddle.length;
    if (droppedCount > 0) {
        console.log(`[Summary] Truncation: dropped ${droppedCount} older messages to fit ${maxTokens} token limit`);
    }
    
    return result;
}

/**
 * MODE 1: Turn-based summarization (engine ON)
 * Summarizes oldest turns when conversation exceeds keep_recent_turns threshold.
 * @param {Array<{role: string, content: string}>} messages - Chat messages
 * @returns {Promise<Array<{role: string, content: string}>>} - Processed messages
 */
async function handleTurnBasedSummary(messages) {
    const keepRecent = getSummaryKeepRecentTurns();
    
    // Count conversation messages (exclude system message at index 0)
    const systemMsg = messages[0];
    const conversationMsgs = messages.slice(1);
    
    // Calculate turns (user + assistant = 1 turn typically, but we count messages)
    if (conversationMsgs.length <= keepRecent * 2) {
        return messages; // Not enough turns yet
    }
    
    // Calculate how many messages to keep (keepRecent turns = keepRecent * 2 messages)
    const msgsToKeep = keepRecent * 2;
    const cutIndex = conversationMsgs.length - msgsToKeep;
    
    if (cutIndex <= 0) {
        return messages; // Nothing to summarize
    }
    
    const toSummarize = conversationMsgs.slice(0, cutIndex);
    const toKeep = conversationMsgs.slice(cutIndex);
    
    console.log(`[Summary] Turn-based: summarizing ${toSummarize.length} messages, keeping ${toKeep.length}`);
    
    try {
        const summary = await runSummarizationModel(toSummarize);
        
        if (!summary) {
            console.warn('[Summary] Turn-based summarization returned empty, applying truncation fallback');
            return truncateMessagesToFit(messages, getMainModelMaxContext());
        }
        
        return [
            systemMsg,
            { role: 'system', content: `Previous conversation summary:\n${summary}` },
            ...toKeep
        ];
    } catch (err) {
        console.error('[Summary] Turn-based summarization failed:', err?.message || err);
        // CRITICAL: Never return oversized messages - truncate as fallback
        console.log('[Summary] Applying emergency truncation');
        return truncateMessagesToFit(messages, getMainModelMaxContext());
    }
}

/**
 * MODE 2: Context-based summarization (engine OFF)
 * Summarizes oldest messages when context exceeds model's max context size.
 * Goal: Maximize context while staying within model limits.
 * @param {Array<{role: string, content: string}>} messages - Chat messages
 * @returns {Promise<Array<{role: string, content: string}>>} - Processed messages
 */
async function handleContextBasedSummary(messages) {
    const maxTokens = getMainModelMaxContext();
    
    // Count tokens for each message
    const tokenCounts = await countTokensPerMessage(messages);
    const totalTokens = tokenCounts.reduce((sum, count) => sum + count, 0);
    
    if (totalTokens <= maxTokens) {
        return messages; // Already fits
    }
    
    console.log(`[Summary] Context overflow: ${totalTokens} > ${maxTokens} tokens`);
    
    // Reserve tokens for summary message overhead (~50 tokens for "Previous conversation summary:" prefix)
    const summaryOverhead = 50;
    const systemTokens = tokenCounts[0] || 0;
    let budget = maxTokens - systemTokens - summaryOverhead;
    
    if (budget <= 0) {
        console.warn('[Summary] System message too large, cannot fit context');
        // Fallback: truncate system message and keep last user message
        return truncateMessagesToFit(messages, maxTokens);
    }
    
    // Find cut point: work backwards from newest, keep as many recent messages as fit
    let cutIndex = messages.length;
    for (let i = messages.length - 1; i >= 1; i--) {
        if (budget >= tokenCounts[i]) {
            budget -= tokenCounts[i];
            cutIndex = i;
        } else {
            break;
        }
    }
    
    const toSummarize = messages.slice(1, cutIndex);
    const toKeep = messages.slice(cutIndex);
    
    if (toSummarize.length === 0) {
        console.log('[Summary] No messages to summarize, truncating to fit');
        return truncateMessagesToFit(messages, maxTokens);
    }
    
    console.log(`[Summary] Context-based: summarizing ${toSummarize.length} oldest messages, keeping ${toKeep.length} recent`);
    
    try {
        const summary = await runSummarizationModel(toSummarize);
        
        if (!summary) {
            console.warn('[Summary] Summarization returned empty, truncating to fit');
            return truncateMessagesToFit(messages, maxTokens);
        }
        
        return [
            messages[0], // System message
            { role: 'system', content: `Previous conversation summary:\n${summary}` },
            ...toKeep
        ];
    } catch (err) {
        console.error('[Summary] Context-based summarization failed:', err?.message || err);
        // CRITICAL: Never return oversized messages - truncate as fallback
        console.log('[Summary] Applying emergency truncation');
        return truncateMessagesToFit(messages, maxTokens);
    }
}

/**
 * Ensure messages fit within the model's context window.
 * Uses different strategies based on whether summary engine is enabled:
 * - Engine ON: Summarize after X turns (proactive, for smaller context models)
 * - Engine OFF: Summarize only when context exceeds max (reactive, maximize context)
 * @param {Array<{role: string, content: string}>} messages - Chat messages
 * @returns {Promise<Array<{role: string, content: string}>>} - Processed messages
 */
async function ensureContextFitsModel(messages) {
    if (!messages || messages.length === 0) {
        return messages;
    }
    
    if (isSummaryFeatureEnabled()) {
        // MODE 1: Turn-based trigger (engine ON)
        // Summarize after X turns for faster inference with larger models
        return await handleTurnBasedSummary(messages);
    } else {
        // MODE 2: Context-based trigger (engine OFF)
        // Summarize only when exceeding max context to maximize context usage
        return await handleContextBasedSummary(messages);
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
        
        // Deep merge helper to preserve nested objects like models.embedding
        function deepMerge(target, source) {
            const result = { ...target };
            for (const key of Object.keys(source)) {
                if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
                    // Recursively merge objects
                    result[key] = deepMerge(target[key] || {}, source[key]);
                } else {
                    // Replace primitives and arrays
                    result[key] = source[key];
                }
            }
            return result;
        }
        
        const merged = deepMerge(current, updates);
        fs.writeFileSync(cfgPath, JSON.stringify(merged, null, 2));
        refreshEngineStateFromConfig();
        refreshProcessingStateFromConfig();
        res.json({ status: 'ok', note: 'Restart server to apply new config' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// =============================================================================
// SYSTEM SETTINGS API
// =============================================================================

/**
 * GET /api/system-settings - Get system settings (context limits, VRAM, etc.)
 */
app.get('/api/system-settings', async (_req, res) => {
    try {
        const { getSystemSettings } = require('./config.js');
        const settings = getSystemSettings();
        res.json({ status: 'ok', settings });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * PATCH /api/system-settings - Update system settings
 */
app.patch('/api/system-settings', async (req, res) => {
    try {
        const { updateSystemSettings, getSystemSettings } = require('./config.js');
        const updates = req.body || {};
        
        // Validate numeric fields
        const numericFields = ['minMainContextTokens', 'summarizerContextTokens', 'maxContextCap', 'vramHeadroomGB', 'autoLoadDelayMs'];
        for (const field of numericFields) {
            if (updates[field] !== undefined) {
                const val = Number(updates[field]);
                if (!Number.isFinite(val) || val < 0) {
                    return res.status(400).json({ error: `Invalid ${field}: must be a positive number` });
                }
                updates[field] = val;
            }
        }
        
        // Validate boolean fields
        const boolFields = ['dynamicContextScaling', 'filterBelowMinContext', 'autoBootstrapOnStartup', 'autoLoadModels'];
        for (const field of boolFields) {
            if (updates[field] !== undefined && typeof updates[field] !== 'boolean') {
                return res.status(400).json({ error: `Invalid ${field}: must be boolean` });
            }
        }
        
        // Validate context limits
        if (updates.minMainContextTokens !== undefined && updates.minMainContextTokens < 4096) {
            return res.status(400).json({ error: 'minMainContextTokens must be at least 4096' });
        }
        if (updates.summarizerContextTokens !== undefined && updates.summarizerContextTokens < 1024) {
            return res.status(400).json({ error: 'summarizerContextTokens must be at least 1024' });
        }
        
        const newSettings = updateSystemSettings(updates);
        
        // Invalidate model sync cache so new filters apply
        const { invalidateSyncCache } = require('./lmstudio/model_sync.js');
        invalidateSyncCache();
        
        res.json({ 
            status: 'ok', 
            settings: newSettings,
            note: 'Settings updated. Reload preset to apply context changes.'
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// =============================================================================
// TOOL CALLING API
// =============================================================================

/**
 * GET /api/tools/config - Get tool calling configuration
 */
app.get('/api/tools/config', async (_req, res) => {
    try {
        const config = getToolCallingConfig();
        res.json({ 
            status: 'ok', 
            config,
            modes: ['auto', 'full', 'core-only', 'disabled'],
            modeDescriptions: {
                'auto': 'Core + Standard tools (probe model, exclude write tools unless enabled)',
                'full': 'All tools including write/execute tools',
                'core-only': 'Only safe read-only tools (rag_search, file_read, file_list)',
                'disabled': 'No tool injection'
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * PATCH /api/tools/config - Update tool calling configuration
 */
app.patch('/api/tools/config', async (req, res) => {
    try {
        const updates = req.body || {};
        
        // Validate mode
        if (updates.mode !== undefined) {
            const validModes = ['auto', 'full', 'core-only', 'disabled'];
            if (!validModes.includes(updates.mode)) {
                return res.status(400).json({ error: `Invalid mode. Must be one of: ${validModes.join(', ')}` });
            }
        }
        
        // Validate boolean fields
        const boolFields = ['enabled', 'coreToolsAlways', 'writeToolsEnabled'];
        for (const field of boolFields) {
            if (updates[field] !== undefined && typeof updates[field] !== 'boolean') {
                return res.status(400).json({ error: `Invalid ${field}: must be boolean` });
            }
        }
        
        const newConfig = updateToolCallingConfig(updates);
        res.json({ 
            status: 'ok', 
            config: newConfig.toolCalling || newConfig
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/tools/categories - Get all tool categories with metadata
 */
app.get('/api/tools/categories', async (_req, res) => {
    try {
        const categories = getAllToolCategories();
        const formatted = categories.map(cat => ({
            names: cat.names,
            color: cat.color,
            description: cat.description,
            alwaysParse: cat.alwaysParse,
            tools: cat.tools.map(t => ({
                name: t.function?.name,
                description: t.function?.description
            }))
        }));
        
        res.json({ 
            status: 'ok', 
            categories: formatted,
            allTools: Object.keys(MIDDLEWARE_TOOLS)
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/tools/probe - Probe current main model for tool calling capabilities
 * Tests if the model supports structured tool calling vs text-based tool calling
 */
app.post('/api/tools/probe', async (req, res) => {
    try {
        const { modelId } = req.body || {};
        
        // Get the model to test (default to current main model)
        const config = getConfig();
        const targetModel = modelId || config.models?.main?.identifier;
        
        if (!targetModel) {
            return res.status(400).json({ error: 'No model specified and no main model configured' });
        }
        
        console.log(`[Tools] Probing model for tool support: ${targetModel}`);
        
        // Create a simple test tool
        const testTool = {
            type: 'function',
            function: {
                name: 'test_tool',
                description: 'A test tool that returns a greeting. Use this to say hello.',
                parameters: {
                    type: 'object',
                    properties: {
                        name: {
                            type: 'string',
                            description: 'Name to greet'
                        }
                    },
                    required: ['name']
                }
            }
        };
        
        const testMessages = [
            { role: 'system', content: 'You have access to tools. Use the test_tool to greet the user.' },
            { role: 'user', content: 'Please greet John using the test_tool.' }
        ];
        
        // Make a non-streaming request to LM Studio with the test tool
        const lmConfig = getLMStudioConfig();
        const response = await fetch(`${lmConfig.url}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: targetModel,
                messages: testMessages,
                tools: [testTool],
                tool_choice: 'auto',
                max_tokens: 500,
                temperature: 0.1
            })
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            return res.status(500).json({ 
                error: 'LM Studio request failed', 
                details: errorText,
                modelId: targetModel
            });
        }
        
        const result = await response.json();
        const choice = result.choices?.[0];
        const message = choice?.message;
        const content = message?.content || '';
        
        // Analyze the response
        let toolCallFormat = 'none';
        let preferredNaming = 'snake_case';
        let parsedToolCall = null;
        
        // Check for structured tool_calls (OpenAI format)
        if (message?.tool_calls && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
            toolCallFormat = 'structured';
            const tc = message.tool_calls[0];
            parsedToolCall = {
                name: tc.function?.name,
                arguments: tc.function?.arguments
            };
            console.log('[Tools] Probe result: structured tool_calls supported');
        }
        // Check for text-based tool calls (various formats)
        else if (content) {
            // Check for <tool_call> format
            const toolCallMatch = content.match(/<tool_call>\s*({[\s\S]*?})\s*<\/tool_call>/);
            if (toolCallMatch) {
                toolCallFormat = 'text_xml';
                try {
                    parsedToolCall = JSON.parse(toolCallMatch[1]);
                } catch (e) {
                    parsedToolCall = { raw: toolCallMatch[1] };
                }
                console.log('[Tools] Probe result: text-based <tool_call> format');
            }
            // Check for ```json format
            else if (content.includes('```json') && content.includes('"name"')) {
                toolCallFormat = 'text_json';
                const jsonMatch = content.match(/```json\s*([\s\S]*?)```/);
                if (jsonMatch) {
                    try {
                        parsedToolCall = JSON.parse(jsonMatch[1]);
                    } catch (e) {
                        parsedToolCall = { raw: jsonMatch[1] };
                    }
                }
                console.log('[Tools] Probe result: text-based ```json format');
            }
            // Check for function call syntax in text
            else if (content.includes('test_tool(') || content.includes('test_tool {')) {
                toolCallFormat = 'text_func';
                console.log('[Tools] Probe result: text-based function syntax');
            }
            else {
                console.log('[Tools] Probe result: no tool call detected in response');
            }
        }
        
        // Determine naming preference from the parsed call
        if (parsedToolCall?.name) {
            if (parsedToolCall.name.includes('_')) {
                preferredNaming = 'snake_case';
            } else if (parsedToolCall.name.includes('.')) {
                preferredNaming = 'dot_notation';
            } else if (/[A-Z]/.test(parsedToolCall.name)) {
                preferredNaming = 'camelCase';
            }
        }
        
        // Build capability report
        const capabilities = {
            modelId: targetModel,
            toolCallFormat,
            preferredNaming,
            supportsStructuredCalls: toolCallFormat === 'structured',
            supportsTextCalls: toolCallFormat.startsWith('text_'),
            parsedToolCall,
            rawResponse: content?.slice(0, 500),
            testedAt: new Date().toISOString()
        };
        
        // Store probe result in model database if available
        try {
            const { setModelToolCapability } = require('./model_db_service.js');
            if (typeof setModelToolCapability === 'function') {
                await setModelToolCapability(targetModel, capabilities);
            }
        } catch (e) {
            // Model DB storage not available, that's ok
        }
        
        res.json({
            status: 'ok',
            capabilities,
            recommendation: toolCallFormat === 'structured' 
                ? 'Model supports structured tool calling - all tools available'
                : toolCallFormat.startsWith('text_')
                    ? 'Model uses text-based tool calling - core tools will be parsed from text'
                    : 'Model may not support tool calling - consider using core-only mode'
        });
        
    } catch (error) {
        console.error('[Tools] Probe error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/tools/list - List all middleware tools with their categories
 */
app.get('/api/tools/list', async (_req, res) => {
    try {
        const tools = Object.entries(MIDDLEWARE_TOOLS).map(([name, tool]) => {
            const category = getToolCategory(name);
            return {
                name,
                description: tool.function?.description,
                category: category?.category || 'unknown',
                color: category?.color || 'gray',
                parameters: tool.function?.parameters
            };
        });
        
        res.json({ 
            status: 'ok', 
            tools,
            count: tools.length
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// =============================================================================
// ENGINE CONTROLS
// =============================================================================

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
        logger.error('LM Studio health check failed:', error);
        res.status(503).json({ error: 'LM Studio health check failed', details: error.message });
    }
});

/**
 * GET /health - Basic health check
 */
app.get('/health', (req, res) => {
    const health = {
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        version: process.version,
        memory: {
            used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
            total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
            external: Math.round(process.memoryUsage().external / 1024 / 1024)
        },
        system: {
            platform: os.platform(),
            arch: os.arch(),
            cpus: os.cpus().length,
            totalMemory: Math.round(os.totalmem() / 1024 / 1024 / 1024),
            freeMemory: Math.round(os.freemem() / 1024 / 1024 / 1024)
        }
    };
    res.json(health);
});

/**
 * GET /health/detailed - Comprehensive health check with all components
 */
app.get('/health/detailed', async (req, res) => {
    try {
        const health = {
            status: 'ok',
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            version: process.version,

            // System metrics
            system: {
                platform: os.platform(),
                arch: os.arch(),
                cpus: os.cpus().length,
                loadAverage: os.loadavg(),
                totalMemory: Math.round(os.totalmem() / 1024 / 1024 / 1024),
                freeMemory: Math.round(os.freemem() / 1024 / 1024 / 1024),
                uptime: os.uptime()
            },

            // Process metrics
            process: {
                pid: process.pid,
                memory: {
                    rss: Math.round(process.memoryUsage().rss / 1024 / 1024),
                    heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
                    heapTotal: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
                    external: Math.round(process.memoryUsage().external / 1024 / 1024)
                },
                cpuUsage: process.cpuUsage()
            },

            // Application components
            components: {}
        };

        // Check LM Studio
        try {
            const lmHealth = await checkLMStudioHealth();
            health.components.lmstudio = {
                status: lmHealth.ready ? 'ok' : 'error',
                message: lmHealth.ready ? 'Server running' : 'Server not responding',
                modelsLoaded: lmHealth.models?.length || 0
            };
        } catch (e) {
            health.components.lmstudio = {
                status: 'error',
                message: e.message
            };
        }

        // Check SQLite database
        try {
            const dbStats = await sqliteCacheManager.getStats();
            health.components.sqlite = {
                status: dbStats.chunkCount >= 0 ? 'ok' : 'error',
                message: 'Database accessible',
                chunkCount: dbStats.chunkCount,
                fileCount: dbStats.fileCount
            };
        } catch (e) {
            health.components.sqlite = {
                status: 'error',
                message: e.message
            };
        }

        // Check FAISS index
        try {
            const faissStats = {
                entries: faissIndexManager.idMap?.length || 0,
                dim: faissIndexManager.dim || 0
            };
            health.components.faiss = {
                status: faissStats.entries >= 0 ? 'ok' : 'error',
                message: faissStats.entries > 0 ? 'Index loaded' : 'Index empty',
                entries: faissStats.entries,
                dimension: faissStats.dim
            };
        } catch (e) {
            health.components.faiss = {
                status: 'error',
                message: e.message
            };
        }

        // Check WebSocket connections
        health.components.websocket = {
            status: wss ? 'ok' : 'error',
            message: wss ? 'Server running' : 'Server not initialized',
            connections: wss?.clients?.size || 0
        };

        // Overall status
        const componentStatuses = Object.values(health.components).map(c => c.status);
        if (componentStatuses.includes('error')) {
            health.status = 'degraded';
        }

        res.json(health);
    } catch (error) {
        logger.error('Detailed health check failed:', error);
        res.status(500).json({
            status: 'error',
            timestamp: new Date().toISOString(),
            error: error.message
        });
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
        if (!preset || !['high', 'medium', 'low', 'custom'].includes(preset)) {
            return res.status(400).json({ error: 'Invalid preset. Must be one of: high, medium, low, custom' });
        }

        let result;

        if (preset === 'custom') {
            // Load models from custom preset config
            const config = getConfig();
            const customConfig = config.customPreset || {};
            
            if (!customConfig.main) {
                return res.status(400).json({ error: 'Custom preset has no main model configured' });
            }
            
            // Build model list to load
            const { ensureModelLoaded, unloadModel, listLoadedModels } = require('./lmstudio/model_manager.js');
            const { findLMStudioModelId } = require('./model_db_service.js');
            
            result = { loaded: [], kept: [], unloaded: [], failed: [] };
            
            // Get currently loaded models
            let currentlyLoaded = [];
            try {
                currentlyLoaded = (await listLoadedModels()).map(m => m.id);
            } catch (e) {}
            
            // Determine what to load
            // Note: Only main and rollingSummarizer are user-configurable in custom preset.
            // Embedder and RAG summarizer are fixed per RAG pipeline tier.
            const modelsToLoad = [
                { role: 'main', id: customConfig.main },
                { role: 'summarizer', id: customConfig.rollingSummarizer }
            ].filter(m => m.id);
            
            const neededIds = new Set();
            for (const m of modelsToLoad) {
                const actualId = await findLMStudioModelId(m.id);
                if (actualId) neededIds.add(actualId);
            }
            
            // Unload models not needed
            for (const loadedId of currentlyLoaded) {
                if (![...neededIds].some(n => n === loadedId || loadedId.includes(n) || n.includes(loadedId))) {
                    try {
                        await unloadModel(loadedId);
                        result.unloaded.push(loadedId);
                    } catch (e) {}
                } else {
                    result.kept.push(loadedId);
                }
            }
            
            // Load new models
            for (const m of modelsToLoad) {
                const actualId = await findLMStudioModelId(m.id);
                if (!actualId) {
                    result.failed.push(m.id);
                    continue;
                }
                
                // Skip if already loaded
                if (result.kept.some(k => k === actualId || k.includes(actualId) || actualId.includes(k))) {
                    continue;
                }
                
                try {
                    await ensureModelLoaded({ identifier: actualId }, { role: m.role });
                    result.loaded.push(actualId);
                } catch (e) {
                    result.failed.push(m.id);
                }
            }
            
            appendLog(`Custom preset models loaded via API: loaded=${result.loaded.length}, kept=${result.kept.length}, unloaded=${result.unloaded.length}`, 'info');
        } else {
            result = await ensurePresetModelsLoaded(preset);
            appendLog(`Preset '${preset}' models loaded via API: loaded=${result.loaded.length}, kept=${result.kept.length}, unloaded=${result.unloaded.length}`, 'info');
        }

        // Update the active preset in config to persist the selection
        try {
            updateConfigFile(config => {
                if (!config.models) config.models = {};
                config.models.activePreset = preset;
                return config;
            });
            // Force refresh config cache to ensure all subsequent calls get the updated preset
            refreshConfig();
            console.log(`[API] Config cache refreshed after preset change to '${preset}'`);
        } catch (configError) {
            appendLog(`Failed to update active preset: ${configError.message}`, 'error');
            // Don't fail the request for config update issues
        }

        // Sync lastActiveModel to match the new preset's main model
        // This ensures consistency between preset selection and active model tracking
        try {
            const config = getConfig();
            let newMainModel = null;
            
            if (preset === 'custom') {
                newMainModel = config.customPreset?.main;
            } else {
                newMainModel = config.models?.perQualityMainModels?.[preset];
            }
            
            if (newMainModel) {
                setActiveModel(newMainModel);
                appendLog(`Synced lastActiveModel to preset main: ${newMainModel}`, 'info');
            }
        } catch (syncError) {
            console.warn(`[API] Failed to sync lastActiveModel: ${syncError.message}`);
        }

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
        const quantization = req.body?.quantization || req.query?.quant || 'q4_k_m';
        appendLog(`Starting model download: ${modelId} (quant: ${quantization})`, 'info');

        // Start download (runs in background, returns immediately)
        const result = await downloadModelFromDB(modelId, quantization);

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
 * GET /models/quant-options - Get available quantization options
 */
app.get('/models/quant-options', (req, res) => {
    const { getQuantOptions } = require('./model_db_service.js');
    res.json({ options: getQuantOptions(), default: 'q4_k_m' });
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
 * GET /models/available - Get all downloaded/synced models for dropdowns
 */
app.get('/models/available', async (req, res) => {
    console.log('[API] /models/available called');
    try {
        const { syncModels } = require('./lmstudio/model_sync.js');
        const { models } = await syncModels();
        console.log('[API] /models/available returning', models.length, 'models');
        
        // Format for frontend consumption with full capability info
        const formatted = models.map(m => ({
            id: m.modelKey,
            modelKey: m.modelKey,
            name: m.displayName || m.modelKey,
            sizeGB: m.sizeGB,
            paramsString: m.paramsString,
            paramSize: m.paramSize,
            
            // Capability info
            trainedForToolUse: m.trainedForToolUse || false,
            maxContextLength: m.maxContextLength,
            capabilities: m.capabilities,
            
            // Agentic info
            agenticScore: m.agenticScore,
            roleBadge: m.roleBadge, // 'agentic', 'toolUse', 'chat', 'summarizer', 'embedder'
            agenticViable: m.agenticViable,
            agenticViableReason: m.agenticViableReason,
            
            // Quantization info
            quantQuality: m.quantQuality,
            quantLabel: m.quantLabel,
            quantBits: m.quantBits,
            reliableForTools: m.reliableForTools,
            
            // Classification
            type: m.function, // 'main', 'summarizer', 'embedder'
            tiers: m.tiers,
            architecture: m.architecture,
            vision: m.vision || false
        }));
        
        res.json({ status: 'ok', models: formatted, count: formatted.length });
    } catch (error) {
        console.error('[API] Failed to get available models:', error.message);
        res.status(500).json({ error: 'Failed to get available models', details: error.message });
    }
});

/**
 * GET /models/capabilities/:id - Get detailed capabilities for a specific model
 */
app.get('/models/capabilities/:id(*)', async (req, res) => {
    try {
        const modelId = decodeURIComponent(req.params.id);
        const { syncModels, getModelByKey, QUANT_QUALITY } = require('./lmstudio/model_sync.js');
        
        // Ensure models are synced
        await syncModels();
        const model = await getModelByKey(modelId);
        
        if (!model) {
            return res.status(404).json({ error: 'Model not found', modelId });
        }
        
        // Badge definitions for frontend
        const BADGE_DEFINITIONS = {
            agentic: { icon: '🤖', label: 'Agentic', color: 'green', description: 'Full tool calling support with reliable execution' },
            toolUse: { icon: '🔧', label: 'Tool Use', color: 'blue', description: 'Has tool calling but may have limitations' },
            chat: { icon: '💬', label: 'Chat', color: 'gray', description: 'Good for chat but no tool support' },
            summarizer: { icon: '📊', label: 'Summarizer', color: 'purple', description: 'Optimized for summarization tasks' },
            embedder: { icon: '🧮', label: 'Embedder', color: 'orange', description: 'Embedding model only' },
            vision: { icon: '👁️', label: 'Vision', color: 'cyan', description: 'Can process images' },
            longContext: { icon: '📜', label: 'Long Context', color: 'teal', description: '32K+ context window' },
            fast: { icon: '⚡', label: 'Fast', color: 'yellow', description: 'Small and fast model' }
        };
        
        res.json({
            status: 'ok',
            modelId: model.modelKey,
            displayName: model.displayName,
            
            // Size info
            sizeGB: model.sizeGB,
            paramsString: model.paramsString,
            paramSize: model.paramSize,
            
            // Primary badge
            roleBadge: model.roleBadge,
            roleBadgeInfo: BADGE_DEFINITIONS[model.roleBadge],
            
            // Agentic assessment
            agenticScore: model.agenticScore,
            agenticViable: model.agenticViable,
            agenticViableReason: model.agenticViableReason,
            
            // Quantization
            quantization: {
                bits: model.quantBits,
                label: model.quantLabel,
                quality: model.quantQuality,
                reliableForTools: model.reliableForTools,
                allTiers: QUANT_QUALITY
            },
            
            // Capabilities
            capabilities: model.capabilities,
            trainedForToolUse: model.trainedForToolUse,
            vision: model.vision,
            maxContextLength: model.maxContextLength,
            
            // Classification
            function: model.function,
            tiers: model.tiers,
            
            // Badge definitions for frontend to render
            badgeDefinitions: BADGE_DEFINITIONS,
            
            // Tool availability
            toolsAvailable: 9, // Current middleware tools count
            toolsSupported: model.agenticViable
        });
    } catch (error) {
        console.error('[API] Failed to get model capabilities:', error.message);
        res.status(500).json({ error: 'Failed to get model capabilities', details: error.message });
    }
});

/**
 * GET /models/agentic - Get only agentic-viable models (for main model selection)
 */
app.get('/models/agentic', async (req, res) => {
    try {
        const { syncModels } = require('./lmstudio/model_sync.js');
        const { models } = await syncModels();
        
        // Filter to only agentic-viable models
        const agenticModels = models.filter(m => m.agenticViable);
        
        // Sort by agentic score descending
        agenticModels.sort((a, b) => (b.agenticScore || 0) - (a.agenticScore || 0));
        
        const formatted = agenticModels.map(m => ({
            id: m.modelKey,
            modelKey: m.modelKey,
            name: m.displayName || m.modelKey,
            sizeGB: m.sizeGB,
            paramsString: m.paramsString,
            agenticScore: m.agenticScore,
            roleBadge: m.roleBadge,
            quantLabel: m.quantLabel,
            quantBits: m.quantBits,
            maxContextLength: m.maxContextLength,
            trainedForToolUse: m.trainedForToolUse,
            vision: m.vision
        }));
        
        res.json({ 
            status: 'ok', 
            models: formatted, 
            count: formatted.length,
            totalModels: models.length,
            description: 'Models suitable for agentic/tool-calling tasks (Q4+ with tool support)'
        });
    } catch (error) {
        console.error('[API] Failed to get agentic models:', error.message);
        res.status(500).json({ error: 'Failed to get agentic models', details: error.message });
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

// =========================
// Hardware Detection Endpoint
// =========================

const { detectHardware, checkModelsWillFit } = require('./hardware_detector.js');
const { optimizeForHardware, getOptimizationStatus } = require('./model_optimizer.js');

/**
 * GET /hardware - Detect system hardware (GPU, RAM)
 */
app.get('/hardware', async (req, res) => {
    try {
        const forceRefresh = req.query.refresh === 'true';
        const hardware = await detectHardware(forceRefresh);
        res.json({ status: 'ok', hardware });
    } catch (error) {
        console.error('[API] Failed to detect hardware:', error.message);
        res.status(500).json({ error: 'Failed to detect hardware', details: error.message });
    }
});

/**
 * POST /hardware/check-fit - Check if models will fit in available VRAM
 * Body: { models: [{ sizeGB: number }] }
 */
app.post('/hardware/check-fit', async (req, res) => {
    try {
        const { models = [] } = req.body || {};
        const result = await checkModelsWillFit(models);
        res.json({ status: 'ok', ...result });
    } catch (error) {
        console.error('[API] Failed to check fit:', error.message);
        res.status(500).json({ error: 'Failed to check fit', details: error.message });
    }
});

/**
 * GET /hardware/realtime - Get real-time CPU, RAM, VRAM usage
 */
app.get('/hardware/realtime', async (req, res) => {
    try {
        const { getRealtimeResources } = require('./hardware_detector.js');
        const resources = await getRealtimeResources();
        res.json({ status: 'ok', ...resources });
    } catch (error) {
        console.error('[API] Failed to get realtime resources:', error.message);
        res.status(500).json({ error: 'Failed to get resources', details: error.message });
    }
});

/**
 * POST /hardware/calculate-context - Calculate optimal context for a model
 * Body: { modelSizeGB: number, modelMaxContext: number, role: string }
 */
app.post('/hardware/calculate-context', async (req, res) => {
    try {
        const { calculateOptimalContext } = require('./hardware_detector.js');
        const { modelSizeGB, modelMaxContext, role } = req.body || {};
        
        if (!modelSizeGB || !role) {
            return res.status(400).json({ error: 'modelSizeGB and role are required' });
        }
        
        const result = await calculateOptimalContext({ modelSizeGB, modelMaxContext, role });
        res.json({ status: 'ok', ...result });
    } catch (error) {
        console.error('[API] Failed to calculate context:', error.message);
        res.status(500).json({ error: 'Failed to calculate context', details: error.message });
    }
});

// =========================
// GPU Optimization Endpoints
// =========================

/**
 * GET /gpu/status - Get current GPU optimization status
 */
app.get('/gpu/status', async (req, res) => {
    try {
        const { getOptimizationStatus } = require('./gpu_optimizer.js');
        const { getGPUInfo, getVRAMUsage } = require('./gpu_monitor.js');
        
        const status = getOptimizationStatus();
        const gpuInfo = await getGPUInfo();
        const vramUsage = await getVRAMUsage();
        
        res.json({
            status: 'ok',
            optimization: status,
            gpu: gpuInfo,
            vram: vramUsage
        });
    } catch (error) {
        console.error('[API] Failed to get GPU status:', error.message);
        res.status(500).json({ error: 'Failed to get GPU status', details: error.message });
    }
});

/**
 * GET /gpu/settings - Get cached GPU settings for current model combination
 */
app.get('/gpu/settings', async (req, res) => {
    try {
        const { getCachedSettings, generateCombinationHash } = require('./gpu_optimizer.js');
        const { listLoadedModels } = require('./lmstudio/model_manager.js');
        
        const loadedModels = await listLoadedModels();
        const modelIds = loadedModels.map(m => m.id);
        const combinationHash = generateCombinationHash(modelIds);
        
        const cached = await getCachedSettings(modelIds);
        
        res.json({
            status: 'ok',
            combinationHash,
            modelIds,
            cached: cached || null,
            hasCached: !!cached
        });
    } catch (error) {
        console.error('[API] Failed to get GPU settings:', error.message);
        res.status(500).json({ error: 'Failed to get GPU settings', details: error.message });
    }
});

/**
 * GET /gpu/settings/all - Get all cached GPU optimization entries
 */
app.get('/gpu/settings/all', async (req, res) => {
    try {
        const { getAllCached } = require('./gpu_optimizer.js');
        const cached = await getAllCached();
        
        res.json({
            status: 'ok',
            entries: cached,
            count: cached.length
        });
    } catch (error) {
        console.error('[API] Failed to get all GPU settings:', error.message);
        res.status(500).json({ error: 'Failed to get all GPU settings', details: error.message });
    }
});

/**
 * POST /gpu/optimize - Trigger GPU optimization for currently loaded models
 */
app.post('/gpu/optimize', async (req, res) => {
    try {
        const { optimizeCombination, getOptimizationStatus, setStatusCallback } = require('./gpu_optimizer.js');
        const { getModelSizeEstimate } = require('./hardware_detector.js');
        const { listLoadedModels } = require('./lmstudio/model_manager.js');
        
        // Check if optimization is already running
        const currentStatus = getOptimizationStatus();
        if (currentStatus.isOptimizing) {
            return res.status(409).json({
                error: 'Optimization already in progress',
                status: currentStatus
            });
        }
        
        // Set up WebSocket broadcasting for status updates
        setStatusCallback((data) => {
            broadcastWsMessage(data);
        });
        
        // Get currently loaded models with size estimates
        const loadedModels = await listLoadedModels();
        if (loadedModels.length === 0) {
            return res.status(400).json({ error: 'No models loaded to optimize' });
        }
        
        const models = loadedModels.map(m => ({
            id: m.id,
            role: m.role || (m.id.toLowerCase().includes('summar') ? 'summarizer' : 'main'),
            sizeGB: getModelSizeEstimate(m.id)
        }));
        
        logger.info(`[API] Starting GPU optimization for ${models.length} models`);
        
        // Start optimization (non-blocking, returns immediately)
        res.json({
            status: 'started',
            message: `Optimization started for ${models.length} models`,
            models: models.map(m => ({ id: m.id, role: m.role, sizeGB: m.sizeGB }))
        });
        
        // Run optimization in background
        try {
            const result = await optimizeCombination(models);
            logger.info(`[API] GPU optimization complete: ${JSON.stringify(result.settings)}`);
            
            // Broadcast completion
            broadcastWsMessage({
                type: 'gpu-optimization-complete',
                payload: result
            });
        } catch (optError) {
            logger.error('[API] GPU optimization failed:', optError.message);
            broadcastWsMessage({
                type: 'gpu-optimization-error',
                payload: { error: optError.message }
            });
        }
    } catch (error) {
        console.error('[API] Failed to start GPU optimization:', error.message);
        res.status(500).json({ error: 'Failed to start GPU optimization', details: error.message });
    }
});

/**
 * DELETE /gpu/settings/:hash - Clear cached settings for a combination
 */
app.delete('/gpu/settings/:hash', async (req, res) => {
    try {
        const { clearCachedSettings } = require('./gpu_optimizer.js');
        const { hash } = req.params;
        
        await clearCachedSettings(hash);
        
        res.json({
            status: 'ok',
            message: `Cleared cached settings for ${hash}`
        });
    } catch (error) {
        console.error('[API] Failed to clear GPU settings:', error.message);
        res.status(500).json({ error: 'Failed to clear GPU settings', details: error.message });
    }
});

/**
 * PATCH /gpu/settings/:modelId - Manual override GPU setting for a specific model
 * Body: { gpu: number (0.0 - 1.0), role: string }
 */
app.patch('/gpu/settings/:modelId', async (req, res) => {
    try {
        const { setManualGPU } = require('./gpu_optimizer.js');
        const { modelId } = req.params;
        const { gpu, role = 'main' } = req.body || {};
        
        if (typeof gpu !== 'number' || gpu < 0 || gpu > 1) {
            return res.status(400).json({ error: 'Invalid GPU value. Must be a number between 0.0 and 1.0' });
        }
        
        await setManualGPU(decodeURIComponent(modelId), gpu, role);
        
        res.json({
            status: 'ok',
            modelId: decodeURIComponent(modelId),
            gpu,
            role,
            message: `GPU offload set to ${gpu} for ${modelId}`
        });
    } catch (error) {
        console.error('[API] Failed to set manual GPU:', error.message);
        res.status(500).json({ error: 'Failed to set manual GPU', details: error.message });
    }
});

/**
 * POST /gpu/apply-cached - Apply cached settings to currently loaded models
 */
app.post('/gpu/apply-cached', async (req, res) => {
    try {
        const { getCachedSettings, applyCachedSettings, generateCombinationHash } = require('./gpu_optimizer.js');
        const { listLoadedModels } = require('./lmstudio/model_manager.js');
        
        const loadedModels = await listLoadedModels();
        const modelIds = loadedModels.map(m => m.id);
        
        const cached = await getCachedSettings(modelIds);
        if (!cached) {
            return res.status(404).json({
                error: 'No cached settings found for current model combination',
                combinationHash: generateCombinationHash(modelIds)
            });
        }
        
        const result = await applyCachedSettings(cached);
        
        res.json({
            status: 'ok',
            message: 'Applied cached GPU settings',
            combinationHash: cached.combinationHash,
            calibratedAt: cached.calibratedAt,
            results: result
        });
    } catch (error) {
        console.error('[API] Failed to apply cached settings:', error.message);
        res.status(500).json({ error: 'Failed to apply cached settings', details: error.message });
    }
});

// =========================
// Custom Preset & Optimization Endpoints
// =========================

// In-memory custom preset config (persisted in config.json)
let customPresetConfig = {
    main: null,
    summarizer: null,
    embedder: null
};

/**
 * GET /presets/custom - Get custom preset configuration
 */
app.get('/presets/custom', (req, res) => {
    try {
        // Try to load from config
        const config = getConfig();
        const customConfig = config.customPreset || customPresetConfig;
        res.json({ status: 'ok', config: customConfig });
    } catch (error) {
        console.error('[API] Failed to get custom preset:', error.message);
        res.status(500).json({ error: 'Failed to get custom preset', details: error.message });
    }
});

/**
 * POST /presets/custom - Save custom preset configuration
 *
 * NOTE: Only main and rollingSummarizer are user-selectable.
 * Embedder and RAG summarizer are part of the CLOSED RAG pipeline.
 */
app.post('/presets/custom', validateInput(customPresetSchema), async (req, res) => {
    try {
        const { main, rollingSummarizer } = req.body || {};
        
        // Only user-selectable models (NOT embedder or ragSummarizer - those are closed)
        customPresetConfig = {
            main: main || null,
            rollingSummarizer: rollingSummarizer || null,
            // embedder and ragSummarizer are LOCKED to RAG pipeline tier
        };
        
        // Persist to config.json
        updateConfigFile(config => {
            config.customPreset = customPresetConfig;
            return config;
        });
        
        appendLog(`Custom preset updated: main=${main}, rollingSummarizer=${rollingSummarizer}`, 'info');
        res.json({ status: 'ok', config: customPresetConfig });
    } catch (error) {
        console.error('[API] Failed to save custom preset:', error.message);
        res.status(500).json({ error: 'Failed to save custom preset', details: error.message });
    }
});

/**
 * POST /presets/quality-model - Save selected model for a quality preset and load it
 */
app.post('/presets/quality-model', validateInput(presetModelSchema), async (req, res) => {
    console.log('[API] /presets/quality-model called with:', req.body);
    try {
        const { quality, modelId } = req.body || {};

        if (!quality || !modelId) {
            return res.status(400).json({ error: 'Missing quality or modelId' });
        }

        if (!['high', 'medium', 'low'].includes(quality)) {
            return res.status(400).json({ error: 'Invalid quality tier' });
        }

        // Update the perQualityMainModels in config
        updateConfigFile(config => {
            if (!config.models.perQualityMainModels) {
                config.models.perQualityMainModels = {};
            }
            config.models.perQualityMainModels[quality] = modelId;
            return config;
        });

        // Now load the preset to ensure the selected model is actually loaded
        console.log(`[API] Loading ${quality} preset with new main model: ${modelId}`);
        const { ensurePresetModelsLoaded } = require('./lmstudio/model_manager.js');

        const loadResult = await ensurePresetModelsLoaded(quality);

        appendLog(`Quality preset updated and loaded: ${quality}=${modelId} (${loadResult.loaded.length} loaded, ${loadResult.kept.length} kept)`, 'info');

        res.json({
            status: 'ok',
            quality,
            modelId,
            loaded: loadResult.loaded,
            kept: loadResult.kept,
            unloaded: loadResult.unloaded,
            failed: loadResult.failed
        });
    } catch (error) {
        console.error('[API] Failed to save and load quality preset model:', error.message);
        res.status(500).json({ error: 'Failed to save and load quality preset model', details: error.message });
    }
});

/**
 * POST /presets/quality-summarizer - Save selected summarizer model for a quality preset and load it
 */
app.post('/presets/quality-summarizer', validateInput(presetSummarizerSchema), async (req, res) => {
    console.log('[API] /presets/quality-summarizer called with:', req.body);
    try {
        const { quality, summarizerId } = req.body || {};

        if (!quality || !summarizerId) {
            return res.status(400).json({ error: 'Missing quality or summarizerId' });
        }

        if (!['high', 'medium', 'low'].includes(quality)) {
            return res.status(400).json({ error: 'Invalid quality tier' });
        }

        // Update the perQualityRollingSummarizers in config
        updateConfigFile(config => {
            if (!config.models.perQualityRollingSummarizers) {
                config.models.perQualityRollingSummarizers = {};
            }
            config.models.perQualityRollingSummarizers[quality] = summarizerId;
            return config;
        });

        // Now load the preset to ensure the selected summarizer is actually loaded
        console.log(`[API] Loading ${quality} preset with new rolling summarizer: ${summarizerId}`);
        const { ensurePresetModelsLoaded } = require('./lmstudio/model_manager.js');

        const loadResult = await ensurePresetModelsLoaded(quality);

        appendLog(`Quality preset summarizer updated and loaded: ${quality}=${summarizerId} (${loadResult.loaded.length} loaded, ${loadResult.kept.length} kept)`, 'info');

        res.json({
            status: 'ok',
            quality,
            summarizerId,
            loaded: loadResult.loaded,
            kept: loadResult.kept,
            unloaded: loadResult.unloaded,
            failed: loadResult.failed
        });
    } catch (error) {
        console.error('[API] Failed to save and load quality preset summarizer:', error.message);
        res.status(500).json({ error: 'Failed to save and load quality preset summarizer', details: error.message });
    }
});

// =========================
// RAG Pipeline Tier Management (Closed System)
// =========================

/**
 * GET /rag/tier - Get current RAG pipeline tier
 */
app.get('/rag/tier', (req, res) => {
    try {
        const { getRagPipelineTier } = require('./config.js');
        const { getRagPipelineConfig, getAllTiers } = require('./rag_pipeline_config.js');
        
        const currentTier = getRagPipelineTier();
        const tierConfig = getRagPipelineConfig(currentTier);
        const allTiers = getAllTiers();
        
        res.json({
            status: 'ok',
            currentTier,
            config: {
                embedder: tierConfig.embedder,
                ragSummarizer: tierConfig.ragSummarizer,
                indexingSpeed: tierConfig.indexingSpeed,
                summaryQuality: tierConfig.summaryQuality
            },
            // Include FULL config for each tier so frontend doesn't need hardcoded fallback
            availableTiers: Object.keys(allTiers).map(key => {
                const cfg = allTiers[key];
                return {
                    id: key,
                    name: cfg.name,
                    description: cfg.description,
                    targetGPU: cfg.targetGPU,
                    embedder: cfg.embedder,
                    ragSummarizer: cfg.ragSummarizer
                };
            }),
            locked: true,
            note: 'RAG pipeline is a closed system. Changing tier requires re-indexing.'
        });
    } catch (error) {
        console.error('[API] Failed to get RAG tier:', error.message);
        res.status(500).json({ error: 'Failed to get RAG tier', details: error.message });
    }
});

/**
 * POST /rag/tier - Change RAG pipeline tier (triggers re-index)
 */
app.post('/rag/tier', async (req, res) => {
    console.log(`[RAG TIER API] Called with tier: ${req.body?.tier}`);
    try {
        const { tier } = req.body || {};
        const validTiers = ['low', 'medium', 'high'];

        if (!tier || !validTiers.includes(tier)) {
            return res.status(400).json({
                error: `Invalid tier. Must be one of: ${validTiers.join(', ')}`
            });
        }
        
        const { getRagPipelineTier, setRagPipelineTier } = require('./config.js');
        const { requiresReindex, getRagPipelineConfig } = require('./rag_pipeline_config.js');
        
        const previousTier = getRagPipelineTier();
        const needsReindex = requiresReindex(previousTier, tier);
        
        if (previousTier === tier) {
            return res.json({ 
                status: 'ok', 
                message: 'Already on this tier',
                tier,
                reindexTriggered: false
            });
        }
        
        // Update the tier
        setRagPipelineTier(tier);
        const newConfig = getRagPipelineConfig(tier);

        appendLog(`RAG pipeline tier changed: ${previousTier} -> ${tier}`, 'info');
        console.log(`[RAG Tier Change] About to start model management: ${previousTier} -> ${tier}`);

        // Manage RAG models FIRST (before re-indexing)
        console.log(`[RAG Tier Change] STARTING model management: ${previousTier} -> ${tier}`);
        try {
            console.log(`[RAG Tier Change] Inside try block`);
            appendLog('Managing RAG models for tier change...', 'info');
            const { openModel, unloadModel, listLoadedModels } = require('./lmstudio/model_manager.js');

            // Get currently loaded models
            const loadedModels = await listLoadedModels();
            const loadedModelIds = loadedModels.map(m => m.id || m.identifier);
            console.log(`[RAG Tier Change] Currently loaded: ${loadedModelIds.join(', ')}`);

            // Unload old RAG summarizer if different
            if (previousTier && previousTier !== tier) {
                const prevConfig = getRagPipelineConfig(previousTier);
                if (prevConfig) {
                    const prevSummarizerId = prevConfig.ragSummarizer.identifier;
                    console.log(`[RAG Tier Change] Previous RAG summarizer: ${prevSummarizerId}`);
                    if (loadedModelIds.includes(prevSummarizerId)) {
                        try {
                            console.log(`[RAG Tier Change] Unloading old RAG summarizer: ${prevSummarizerId}`);
                            await unloadModel(prevSummarizerId);
                            appendLog(`Unloaded old RAG summarizer: ${prevSummarizerId}`, 'info');
                        } catch (error) {
                            appendLog(`Failed to unload old RAG summarizer ${prevSummarizerId}: ${error.message}`, 'warn');
                        }
                    } else {
                        console.log(`[RAG Tier Change] Old RAG summarizer ${prevSummarizerId} not loaded`);
                    }
                }
            }

            // Load new RAG summarizer if not already loaded
            const newSummarizerId = newConfig.ragSummarizer.identifier;
            console.log(`[RAG Tier Change] New RAG summarizer: ${newSummarizerId}`);
            if (!loadedModelIds.includes(newSummarizerId)) {
                try {
                    console.log(`[RAG Tier Change] Loading new RAG summarizer: ${newSummarizerId}`);
                    await openModel(newSummarizerId);
                    appendLog(`Loaded new RAG summarizer: ${newSummarizerId}`, 'info');
                } catch (error) {
                    appendLog(`Failed to load new RAG summarizer ${newSummarizerId}: ${error.message}`, 'warn');
                }
            } else {
                console.log(`[RAG Tier Change] New RAG summarizer ${newSummarizerId} already loaded`);
            }
        } catch (error) {
            console.error(`[RAG Tier Change] Failed to manage RAG models: ${error.message}`);
            appendLog(`Failed to manage RAG models during tier change: ${error.message}`, 'error');
        }

        // Trigger re-index if needed (after model management)
        if (needsReindex && isRagFeatureEnabled()) {
            appendLog('Re-indexing triggered due to tier change...', 'info');

            // Clear existing index first (dimension may change)
            await faissIndexManager.clear();
            await sqliteCacheManager.clearChunks();

            // Start re-index in background
            try {
                void startIndexer({ reason: `tier-change-${tier}`, background: true });
            } catch (error) {
                appendLog(`Re-indexing failed to start: ${error.message}`, 'warn');
            }
        }
        
        res.json({
            status: 'ok',
            message: needsReindex ? 'Tier changed, re-indexing started' : 'Tier changed',
            previousTier,
            newTier: tier,
            config: {
                embedder: newConfig.embedder,
                ragSummarizer: newConfig.ragSummarizer
            },
            reindexTriggered: needsReindex
        });
    } catch (error) {
        console.error('[API] Failed to change RAG tier:', error.message);
        res.status(500).json({ error: 'Failed to change RAG tier', details: error.message });
    }
});

/**
 * GET /rag/check-reindex - Check if changing tiers requires reindexing
 */
app.get('/rag/check-reindex', (req, res) => {
    try {
        const { from, to } = req.query;
        if (!from || !to) {
            return res.status(400).json({ error: 'Missing from or to parameters' });
        }

        const { requiresReindex } = require('./rag_pipeline_config.js');
        const needsReindex = requiresReindex(from, to);
        res.json({ needsReindex });
    } catch (error) {
        console.error('[API] Failed to check reindex requirement:', error.message);
        res.status(500).json({ error: 'Failed to check reindex requirement', details: error.message });
    }
});

/**
 * POST /rag/ensure-models - Ensure required models are loaded for a tier
 */
app.post('/rag/ensure-models', async (req, res) => {
    try {
        const { tier, previousTier } = req.body;
        console.log(`[RAG] 🔄 ensure-models called: tier=${tier}, previousTier=${previousTier}`);
        if (!tier) {
            return res.status(400).json({ error: 'Missing tier parameter' });
        }

        const { getRagPipelineConfig, getAllTiers } = require('./rag_pipeline_config.js');
        const pipelineConfig = getRagPipelineConfig(tier);
        if (!pipelineConfig) {
            return res.status(400).json({ error: 'Invalid tier' });
        }

        const { openModel, unloadModel, listLoadedModels } = require('./lmstudio/model_manager.js');

        // Get currently loaded models to avoid unnecessary operations
        const loadedModels = await listLoadedModels();
        const loadedModelIds = loadedModels.map(m => m.id || m.identifier);
        console.log(`[RAG] Currently loaded models:`, loadedModelIds);

        // If we have a previous tier, unload its RAG summarizer (only if loaded)
        if (previousTier && previousTier !== tier) {
            console.log(`[RAG] Unloading previous tier RAG summarizer: ${previousTier} -> ${tier}`);
            const prevConfig = getRagPipelineConfig(previousTier);
            if (prevConfig) {
                const prevSummarizerId = prevConfig.ragSummarizer.identifier;
                console.log(`[RAG] Previous config: summarizer=${prevSummarizerId}`);

                if (loadedModelIds.includes(prevSummarizerId)) {
                    try {
                        await unloadModel(prevSummarizerId);
                        console.log(`[RAG] ✅ Unloaded RAG summarizer: ${prevSummarizerId}`);
                    } catch (error) {
                        console.warn(`[RAG] ❌ Failed to unload RAG summarizer ${prevSummarizerId}:`, error.message);
                    }
                } else {
                    console.log(`[RAG] Previous RAG summarizer ${prevSummarizerId} was not loaded, skipping unload`);
                }
            } else {
                console.log(`[RAG] No previous config found for tier: ${previousTier}`);
            }
        } else {
            console.log(`[RAG] No previous tier or same tier: previous=${previousTier}, current=${tier}`);
        }

        // Note: Embedders are local @xenova/transformers models, not LM Studio models
        console.log(`[RAG] Embedder is local model: ${pipelineConfig.embedder.identifier} (no LM Studio loading needed)`);

        // Load new RAG summarizer (only if not already loaded)
        const summarizerId = pipelineConfig.ragSummarizer.identifier;
        if (!loadedModelIds.includes(summarizerId)) {
            console.log(`[RAG] Loading RAG summarizer: ${summarizerId}`);
            try {
                await openModel(summarizerId);
                console.log(`[RAG] ✅ RAG summarizer ${summarizerId} is ready`);
            } catch (error) {
                console.warn(`[RAG] ❌ Failed to load RAG summarizer ${summarizerId}:`, error.message);
            }
        } else {
            console.log(`[RAG] RAG summarizer ${summarizerId} already loaded, skipping`);
        }

        res.json({ status: 'ok', message: 'Models managed successfully' });
    } catch (error) {
        console.error('[API] Failed to ensure models:', error.message);
        res.status(500).json({ error: 'Failed to ensure models', details: error.message });
    }
});

/**
 * POST /rag/reset - Clear all RAG indexed data (FAISS + DB chunks) without reindexing
 */
app.post('/rag/reset', async (req, res) => {
    try {
        if (!isRagFeatureEnabled()) {
            return res.status(400).json({ error: 'RAG is disabled in the current runtime mode.' });
        }

        // Get counts before clearing
        const faissCountBefore = faissIndexManager.idMap?.length || 0;
        const dbStatsBefore = await sqliteCacheManager.getStats();
        const chunkCountBefore = dbStatsBefore?.chunkCount || 0;

        // Stop any active indexing
        await stopActiveIndexer('rag-reset');

        // Clear FAISS index
        console.log('[RAG Reset] Clearing FAISS index...');
        await faissIndexManager.clear();

        // Clear SQLite chunks (keeps rolling summaries)
        console.log('[RAG Reset] Clearing SQLite chunks...');
        await sqliteCacheManager.clearChunks();

        // Get counts after clearing
        const faissCountAfter = faissIndexManager.idMap?.length || 0;
        const dbStatsAfter = await sqliteCacheManager.getStats();
        const chunkCountAfter = dbStatsAfter?.chunkCount || 0;

        appendLog(`RAG reset complete: cleared ${faissCountBefore} FAISS entries, ${chunkCountBefore} DB chunks`, 'info');

        res.json({
            status: 'ok',
            message: 'RAG data cleared successfully',
            cleared: {
                faissEntries: faissCountBefore - faissCountAfter,
                dbChunks: chunkCountBefore - chunkCountAfter
            },
            current: {
                faissEntries: faissCountAfter,
                dbChunks: chunkCountAfter
            }
        });
    } catch (error) {
        appendLog(`RAG reset failed: ${error.message}`, 'error');
        console.error('[API] Failed to reset RAG:', error.message);
        res.status(500).json({ error: 'Failed to reset RAG', details: error.message });
    }
});

/**
 * POST /rag/reindex - Trigger RAG reindexing (clears and rebuilds index)
 */
app.post('/rag/reindex', async (req, res) => {
    try {
        if (!isRagFeatureEnabled()) {
            return res.status(400).json({ error: 'RAG is disabled in the current runtime mode.' });
        }

        const { reason = 'rag-reindex' } = req.body || {};

        // Clear existing index first (dimension may change)
        console.log('Clearing FAISS index...');
        await faissIndexManager.clear();

        console.log('Clearing SQLite cache...');
        await sqliteCacheManager.clearChunks();

        // Start re-index in background
        console.log('Starting RAG reindexing...');
        void startIndexer({ reason, background: true });

        appendLog(`RAG reindex triggered: ${reason}`, 'info');
        res.json({ status: 'ok', message: 'RAG reindexing started in background' });
    } catch (error) {
        appendLog(`RAG reindex failed: ${error.message}`, 'error');
        console.error('[API] Failed to start RAG reindex:', error.message);
        res.status(500).json({ error: 'Failed to start reindexing', details: error.message });
    }
});

/**
 * GET /rag/indexing-status - Get current RAG indexing status and progress
 */
app.get('/rag/indexing-status', async (req, res) => {
    try {
        if (!isRagFeatureEnabled()) {
            return res.json({
                isIndexing: false,
                status: 'disabled',
                filesProcessed: 0,
                totalFiles: 0,
                chunksProcessed: 0,
                totalChunks: 0
            });
        }

        // Get indexer status from middleware
        const indexerStatus = await getIndexingStatus();

        // Get database stats
        const dbStats = await sqliteCacheManager.getStats();
        const faissStats = {
            entries: faissIndexManager.idMap?.length || 0,
            dim: faissIndexManager.dim || 0
        };

        // When not actively indexing, show actual indexed counts from database
        // When actively indexing, show current progress counters
        const filesProcessed = indexerStatus.isActive ? indexerStatus.filesProcessed : dbStats.fileCount || 0;
        const totalFiles = indexerStatus.isActive ? indexerStatus.totalFiles : dbStats.fileCount || 0;

        res.json({
            isIndexing: indexerStatus.isActive,
            currentFile: indexerStatus.currentFile,
            filesProcessed,
            totalFiles,
            chunksProcessed: dbStats.chunkCount || 0,
            totalChunks: dbStats.chunkCount || 0,
            startTime: indexerStatus.startTime,
            estimatedTimeRemaining: indexerStatus.estimatedTimeRemaining,
            status: indexerStatus.status,
            error: indexerStatus.error,
            dbStats,
            faissStats
        });
    } catch (error) {
        console.error('[API] Failed to get indexing status:', error.message);
        res.status(500).json({
            error: 'Failed to get indexing status',
            details: error.message,
            isIndexing: false,
            status: 'error',
            filesProcessed: 0,
            totalFiles: 0,
            chunksProcessed: 0,
            totalChunks: 0
        });
    }
});

/**
 * POST /presets/optimize - Run LLM-powered optimization
 */
app.post('/presets/optimize', async (req, res) => {
    try {
        appendLog('Starting model optimization...', 'info');
        const result = await optimizeForHardware();
        
        if (result.success) {
            appendLog(`Optimization complete: ${result.recommendation.main}`, 'info');
            res.json({ status: 'ok', recommendation: result.recommendation, hardware: result.hardware });
        } else {
            appendLog(`Optimization failed: ${result.error}`, 'warn');
            res.status(400).json({ error: result.error });
        }
    } catch (error) {
        console.error('[API] Optimization failed:', error.message);
        res.status(500).json({ error: 'Optimization failed', details: error.message });
    }
});

/**
 * GET /presets/optimize/status - Get optimization status
 */
app.get('/presets/optimize/status', (req, res) => {
    try {
        const status = getOptimizationStatus();
        res.json({ status: 'ok', ...status });
    } catch (error) {
        res.status(500).json({ error: 'Failed to get optimization status' });
    }
});

// =========================
// Hugging Face Integration Endpoints
// =========================

const hfService = require('./huggingface_service.js');
const lmRegistryService = require('./lmstudio_registry_service.js');

/**
 * GET /models/lmstudio/discover - Discover models from LM Studio registry
 * Query params: q (search query), limit
 */
app.get('/models/lmstudio/discover', async (req, res) => {
    console.log('[API] /models/lmstudio/discover called with query:', req.query);
    try {
        const { q: query, limit = 20 } = req.query;
        const models = await lmRegistryService.discoverModels({
            query: query || '',
            limit: parseInt(limit, 10)
        });
        console.log('[API] LM Studio discovery returned', models.length, 'models');

        res.json({
            status: 'ok',
            models,
            source: 'lm-studio-registry'
        });
    } catch (error) {
        console.error('[API] LM Studio discovery failed:', error.message);
        res.status(500).json({
            error: 'Failed to discover LM Studio models',
            details: error.message
        });
    }
});

/**
 * POST /models/lmstudio/download - Download from LM Studio registry
 */
app.post('/models/lmstudio/download', async (req, res) => {
    try {
        const { modelKey } = req.body;

        if (!modelKey) {
            return res.status(400).json({ error: 'modelKey is required' });
        }

        const result = await lmRegistryService.downloadModel(modelKey);

        if (result.success) {
            appendLog(`Downloaded from LM Studio registry: ${modelKey}`, 'info');
            res.json(result);
        } else {
            res.status(500).json(result);
        }
    } catch (error) {
        console.error('[API] LM Studio download failed:', error.message);
        res.status(500).json({
            error: 'Failed to download from LM Studio registry',
            details: error.message
        });
    }
});

/**
 * GET /models/search - Search Hugging Face for models
 * Query params: q (search query), limit, role (main|summarizer|embedder)
 */
app.get('/models/search', async (req, res) => {
    try {
        const { q, limit = 20, role } = req.query;
        
        if (!q && !role) {
            return res.status(400).json({ error: 'Provide q (query) or role parameter' });
        }
        
        let results;
        if (role) {
            results = await hfService.searchModelsForRole(role, { limit: parseInt(limit) });
        } else {
            results = await hfService.searchModels(q, { limit: parseInt(limit) });
        }
        
        res.json({ status: 'ok', results, count: results.length });
    } catch (error) {
        console.error('[API] Model search failed:', error.message);
        res.status(500).json({ error: 'Search failed', details: error.message });
    }
});

/**
 * GET /models/search/:modelId/quants - Get available quantizations for a model
 */
app.get('/models/search/:modelId(*)/quants', async (req, res) => {
    try {
        const modelId = req.params.modelId;
        const quantizations = await hfService.getModelQuantizations(modelId);
        res.json({ status: 'ok', modelId, quantizations });
    } catch (error) {
        console.error('[API] Failed to get quantizations:', error.message);
        res.status(500).json({ error: 'Failed to get quantizations', details: error.message });
    }
});

/**
 * POST /models/download-hf - Download a model from Hugging Face
 * Body: { modelId: string, quantization?: string }
 */
app.post('/models/download-hf', async (req, res) => {
    try {
        const { modelId, quantization } = req.body || {};
        
        if (!modelId) {
            return res.status(400).json({ error: 'modelId is required' });
        }
        
        appendLog(`Downloading from HuggingFace: ${modelId}${quantization ? `@${quantization}` : ''}`, 'info');
        
        const result = await hfService.downloadModel(modelId, quantization);
        
        if (result.success) {
            appendLog(`Downloaded successfully: ${result.modelKey}`, 'info');
            res.json({ status: 'ok', ...result });
        } else {
            appendLog(`Download failed: ${result.error}`, 'warn');
            res.status(400).json({ error: result.error });
        }
    } catch (error) {
        console.error('[API] HF download failed:', error.message);
        res.status(500).json({ error: 'Download failed', details: error.message });
    }
});

/**
 * GET /models/downloads - Get active downloads status
 */
app.get('/models/downloads', (req, res) => {
    try {
        const downloads = hfService.getActiveDownloads();
        res.json({ status: 'ok', downloads });
    } catch (error) {
        res.status(500).json({ error: 'Failed to get downloads status' });
    }
});

/**
 * GET /models/check-hf/:modelId - Check if a HF model is already downloaded
 */
app.get('/models/check-hf/:modelId(*)', async (req, res) => {
    try {
        const modelId = req.params.modelId;
        const downloaded = await hfService.isModelDownloaded(modelId);
        res.json({ status: 'ok', modelId, downloaded });
    } catch (error) {
        res.status(500).json({ error: 'Failed to check model status' });
    }
});

// =========================
// Model Lock API Endpoints
// =========================

const lockService = require('./model_lock_service.js');

/**
 * GET /models/locks - Get all locked models
 */
app.get('/models/locks', (req, res) => {
    try {
        const locks = lockService.getAllLocks();
        res.json({ status: 'ok', locks });
    } catch (error) {
        console.error('[API] Failed to get locks:', error.message);
        res.status(500).json({ error: 'Failed to get locks', details: error.message });
    }
});

/**
 * GET /models/lock/:id - Get lock state for a specific model
 */
app.get('/models/lock/:id(*)', (req, res) => {
    try {
        const modelId = req.params.id;
        const lock = lockService.getModelLock(modelId);
        res.json({ status: 'ok', modelId, lock });
    } catch (error) {
        console.error('[API] Failed to get lock:', error.message);
        res.status(500).json({ error: 'Failed to get lock', details: error.message });
    }
});

/**
 * POST /models/lock/:id - Lock a model
 * Body: { loaded?: boolean, preset?: boolean }
 */
app.post('/models/lock/:id(*)', (req, res) => {
    try {
        const modelId = req.params.id;
        const { loaded = true, preset = true } = req.body || {};
        
        const lock = lockService.lockModel(modelId, { loaded, preset });
        appendLog(`Locked model: ${modelId} (loaded=${loaded}, preset=${preset})`, 'info');
        
        res.json({ status: 'ok', modelId, lock });
    } catch (error) {
        console.error('[API] Failed to lock model:', error.message);
        res.status(500).json({ error: 'Failed to lock model', details: error.message });
    }
});

/**
 * DELETE /models/lock/:id - Unlock a model
 * Body: { loaded?: boolean, preset?: boolean }
 */
app.delete('/models/lock/:id(*)', (req, res) => {
    try {
        const modelId = req.params.id;
        const { loaded = true, preset = true } = req.body || {};
        
        const lock = lockService.unlockModel(modelId, { loaded, preset });
        appendLog(`Unlocked model: ${modelId} (loaded=${loaded}, preset=${preset})`, 'info');
        
        res.json({ status: 'ok', modelId, lock });
    } catch (error) {
        console.error('[API] Failed to unlock model:', error.message);
        res.status(500).json({ error: 'Failed to unlock model', details: error.message });
    }
});

/**
 * POST /models/lock/:id/toggle - Toggle lock for a model
 * Body: { lockType?: 'loaded' | 'preset' | 'both' }
 */
app.post('/models/lock/:id(*)/toggle', (req, res) => {
    try {
        const modelId = req.params.id;
        const { lockType = 'both' } = req.body || {};
        
        const lock = lockService.toggleLock(modelId, lockType);
        appendLog(`Toggled lock for model: ${modelId} (type=${lockType})`, 'info');
        
        res.json({ status: 'ok', modelId, lock });
    } catch (error) {
        console.error('[API] Failed to toggle lock:', error.message);
        res.status(500).json({ error: 'Failed to toggle lock', details: error.message });
    }
});

// =========================
// Processing Config Endpoints
// =========================

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

// Track last known RAG summarizer model for change detection
let lastKnownRagSummarizer = null;

/**
 * GET /summary/status - Check if summaries are current or need regeneration
 */
app.get('/summary/status', async (req, res) => {
    try {
        const currentModel = ragSummarizationModel?.identifier || 'unknown';
        
        // Initialize tracking on first call
        if (lastKnownRagSummarizer === null) {
            lastKnownRagSummarizer = currentModel;
        }
        
        const modelChanged = lastKnownRagSummarizer !== currentModel;
        const rollingSummaryCount = await sqliteCacheManager.getAllConversationIds();
        
        res.json({
            status: 'ok',
            currentModel,
            previousModel: modelChanged ? lastKnownRagSummarizer : null,
            modelChanged,
            regenerationNeeded: modelChanged,
            summaryCount: rollingSummaryCount?.length || 0,
            message: modelChanged 
                ? `RAG summarizer changed from ${lastKnownRagSummarizer} to ${currentModel}. Summaries may be inconsistent.`
                : 'Summaries are current.'
        });
    } catch (error) {
        console.error('[Server] /summary/status error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /summary/acknowledge-change - Acknowledge that the model changed, reset tracking
 */
app.post('/summary/acknowledge-change', async (req, res) => {
    try {
        const currentModel = ragSummarizationModel?.identifier || 'unknown';
        const previousModel = lastKnownRagSummarizer;
        lastKnownRagSummarizer = currentModel;
        
        appendLog(`RAG summarizer change acknowledged: ${previousModel} -> ${currentModel}`, 'info');
        
        res.json({
            status: 'ok',
            message: 'Model change acknowledged. Existing summaries may use the old model.',
            previousModel,
            currentModel
        });
    } catch (error) {
        console.error('[Server] /summary/acknowledge-change error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /summary/regenerate - Trigger full summary regeneration with current model
 */
app.post('/summary/regenerate', async (req, res) => {
    try {
        const currentModel = ragSummarizationModel?.identifier || 'unknown';
        const keepRecentTurns = getSummaryKeepRecentTurns();
        const conversationIds = await sqliteCacheManager.getAllConversationIds();
        
        appendLog(`Starting summary regeneration with model: ${currentModel}`, 'info');
        
        // Reset tracking to current model
        lastKnownRagSummarizer = currentModel;
        
        // Reprocess all summaries
        const results = [];
        for (const convId of conversationIds) {
            if (!convId) continue;
            try {
                const summary = await recomputeRollingSummary(convId, keepRecentTurns);
                results.push({
                    conversationId: convId,
                    success: true,
                    turnCount: summary?.turnCount || 0
                });
            } catch (err) {
                results.push({
                    conversationId: convId,
                    success: false,
                    error: err?.message
                });
            }
        }
        
        const successCount = results.filter(r => r.success).length;
        appendLog(`Summary regeneration complete: ${successCount}/${results.length} sessions`, 'info');
        
        res.json({
            status: 'ok',
            model: currentModel,
            totalSessions: results.length,
            successCount,
            results
        });
    } catch (error) {
        console.error('[Server] /summary/regenerate error:', error);
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

// =========================
// Custom Middleware Tools
// =========================

/**
 * Definition of custom middleware tools that can be exposed to LLMs
 */
const MIDDLEWARE_TOOLS = {
    rag_search: {
        type: 'function',
        function: {
            name: 'rag_search',
            description: 'Search the indexed codebase for relevant code snippets and documentation. Use this to find code related to a query.',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'The search query to find relevant code'
                    },
                    topK: {
                        type: 'number',
                        description: 'Number of results to return (default: 5)'
                    }
                },
                required: ['query']
            }
        }
    },
    file_read: {
        type: 'function',
        function: {
            name: 'file_read',
            description: 'Read the contents of a file from the workspace. Returns the file content as text.',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'The file path relative to workspace root'
                    }
                },
                required: ['path']
            }
        }
    },
    get_file_summary: {
        type: 'function',
        function: {
            name: 'get_file_summary',
            description: 'Get the RAG summary for a file. Returns AI-generated summary of the file contents.',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'The file path relative to workspace root'
                    }
                },
                required: ['path']
            }
        }
    },
    web_search: {
        type: 'function',
        function: {
            name: 'web_search',
            description: 'Search the web for programming information, documentation, Stack Overflow answers, or general knowledge. Returns relevant search results with titles, snippets, and URLs.',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'The search query'
                    },
                    num_results: {
                        type: 'number',
                        description: 'Number of results to return (default: 5, max: 10)'
                    }
                },
                required: ['query']
            }
        }
    },
    fetch_url: {
        type: 'function',
        function: {
            name: 'fetch_url',
            description: 'Fetch and read content from a URL. Great for reading documentation, API docs, GitHub files, or any web page. Returns the text content of the page.',
            parameters: {
                type: 'object',
                properties: {
                    url: {
                        type: 'string',
                        description: 'The URL to fetch'
                    },
                    selector: {
                        type: 'string',
                        description: 'Optional CSS selector to extract specific content (e.g., "article", ".main-content", "#readme")'
                    },
                    max_length: {
                        type: 'number',
                        description: 'Maximum characters to return (default: 10000)'
                    }
                },
                required: ['url']
            }
        }
    },
    npm_info: {
        type: 'function',
        function: {
            name: 'npm_info',
            description: 'Get information about an npm package including latest version, description, dependencies, and readme excerpt.',
            parameters: {
                type: 'object',
                properties: {
                    package_name: {
                        type: 'string',
                        description: 'The npm package name (e.g., "express", "lodash", "@types/node")'
                    }
                },
                required: ['package_name']
            }
        }
    },
    file_list: {
        type: 'function',
        function: {
            name: 'file_list',
            description: 'List files and directories in a given path. Returns file names, types (file/directory), and sizes.',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'Directory path relative to workspace root (default: "." for root)'
                    },
                    recursive: {
                        type: 'boolean',
                        description: 'Whether to list recursively (default: false, max depth: 3)'
                    },
                    pattern: {
                        type: 'string',
                        description: 'Optional glob pattern to filter files (e.g., "*.js", "**/*.ts")'
                    }
                },
                required: []
            }
        }
    },
    file_search: {
        type: 'function',
        function: {
            name: 'file_search',
            description: 'Search for files by name pattern or content. Returns matching file paths.',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'Search query - can be a filename pattern (e.g., "*.config.js") or text to search in files'
                    },
                    search_content: {
                        type: 'boolean',
                        description: 'If true, search inside file contents. If false (default), search filenames only.'
                    },
                    file_pattern: {
                        type: 'string',
                        description: 'Glob pattern to limit which files to search (e.g., "**/*.ts")'
                    },
                    max_results: {
                        type: 'number',
                        description: 'Maximum results to return (default: 20)'
                    }
                },
                required: ['query']
            }
        }
    },
    file_write: {
        type: 'function',
        function: {
            name: 'file_write',
            description: 'Write or create a file in the workspace. Use with caution - will overwrite existing files. Only works within workspace directory.',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'File path relative to workspace root'
                    },
                    content: {
                        type: 'string',
                        description: 'Content to write to the file'
                    },
                    create_dirs: {
                        type: 'boolean',
                        description: 'Create parent directories if they don\'t exist (default: true)'
                    }
                },
                required: ['path', 'content']
            }
        }
    },
    file_patch: {
        type: 'function',
        function: {
            name: 'file_patch',
            description: 'Apply a patch/diff to an existing file. Safer than file_write for making targeted changes.',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'File path relative to workspace root'
                    },
                    search: {
                        type: 'string',
                        description: 'The exact text to find in the file'
                    },
                    replace: {
                        type: 'string',
                        description: 'The text to replace it with'
                    },
                    all: {
                        type: 'boolean',
                        description: 'Replace all occurrences (default: false, only first)'
                    }
                },
                required: ['path', 'search', 'replace']
            }
        }
    },
    run_command: {
        type: 'function',
        function: {
            name: 'run_command',
            description: 'Execute a shell command in the workspace. Returns stdout and stderr. Use with caution - only safe commands are allowed.',
            parameters: {
                type: 'object',
                properties: {
                    command: {
                        type: 'string',
                        description: 'The command to execute (e.g., "npm test", "git status", "ls -la")'
                    },
                    cwd: {
                        type: 'string',
                        description: 'Working directory relative to workspace (default: workspace root)'
                    },
                    timeout: {
                        type: 'number',
                        description: 'Command timeout in milliseconds (default: 30000, max: 60000)'
                    }
                },
                required: ['command']
            }
        }
    },
    grep: {
        type: 'function',
        function: {
            name: 'grep',
            description: 'Search for a pattern in files using regex. Returns matching lines with context.',
            parameters: {
                type: 'object',
                properties: {
                    pattern: {
                        type: 'string',
                        description: 'Regex pattern to search for'
                    },
                    path: {
                        type: 'string',
                        description: 'File or directory path to search in (default: ".")'
                    },
                    file_pattern: {
                        type: 'string',
                        description: 'Glob pattern to filter files (e.g., "*.js", "*.ts")'
                    },
                    context_lines: {
                        type: 'number',
                        description: 'Number of lines before/after match to include (default: 2)'
                    },
                    max_results: {
                        type: 'number',
                        description: 'Maximum matches to return (default: 20)'
                    },
                    case_insensitive: {
                        type: 'boolean',
                        description: 'Case insensitive search (default: false)'
                    }
                },
                required: ['pattern']
            }
        }
    },
    memory_store: {
        type: 'function',
        function: {
            name: 'memory_store',
            description: 'Store a value in agent memory. Use to remember important information across conversation turns.',
            parameters: {
                type: 'object',
                properties: {
                    key: {
                        type: 'string',
                        description: 'A unique key to identify this memory (e.g., "project_structure", "user_preferences")'
                    },
                    value: {
                        type: 'string',
                        description: 'The value to store (any text)'
                    },
                    scope: {
                        type: 'string',
                        enum: ['session', 'permanent'],
                        description: 'Memory scope - "session" (cleared on restart) or "permanent" (persisted to database)'
                    },
                    category: {
                        type: 'string',
                        description: 'Optional category for organizing memories (e.g., "code", "preferences", "context")'
                    }
                },
                required: ['key', 'value']
            }
        }
    },
    memory_retrieve: {
        type: 'function',
        function: {
            name: 'memory_retrieve',
            description: 'Retrieve a value from agent memory by key.',
            parameters: {
                type: 'object',
                properties: {
                    key: {
                        type: 'string',
                        description: 'The key to look up'
                    },
                    scope: {
                        type: 'string',
                        enum: ['session', 'permanent', 'all'],
                        description: 'Where to look - "session", "permanent", or "all" (default)'
                    }
                },
                required: ['key']
            }
        }
    },
    memory_list: {
        type: 'function',
        function: {
            name: 'memory_list',
            description: 'List all stored memories, optionally filtered by category.',
            parameters: {
                type: 'object',
                properties: {
                    category: {
                        type: 'string',
                        description: 'Filter by category (optional)'
                    },
                    scope: {
                        type: 'string',
                        enum: ['session', 'permanent', 'all'],
                        description: 'Filter by scope (default: "all")'
                    }
                },
                required: []
            }
        }
    },
    repo_map: {
        type: 'function',
        function: {
            name: 'repo_map',
            description: 'Get a structural map of the codebase showing files, classes, functions, and their relationships.',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'Directory to analyze (default: workspace root)'
                    },
                    depth: {
                        type: 'number',
                        description: 'Max depth to traverse (default: 3)'
                    },
                    include_symbols: {
                        type: 'boolean',
                        description: 'Include function/class names (default: true)'
                    },
                    file_pattern: {
                        type: 'string',
                        description: 'Glob pattern to filter files (e.g., "**/*.ts")'
                    }
                },
                required: []
            }
        }
    },
    browser_automation: {
        type: 'function',
        function: {
            name: 'browser_automation',
            description: 'Control a browser to navigate, interact with pages, or extract data. Powered by Playwright.',
            parameters: {
                type: 'object',
                properties: {
                    action: {
                        type: 'string',
                        enum: ['navigate', 'click', 'type', 'screenshot', 'evaluate', 'extract', 'scroll'],
                        description: 'The action to perform'
                    },
                    url: {
                        type: 'string',
                        description: 'URL to navigate to (for "navigate" action)'
                    },
                    selector: {
                        type: 'string',
                        description: 'CSS selector for element (for click/type/extract actions)'
                    },
                    text: {
                        type: 'string',
                        description: 'Text to type (for "type" action)'
                    },
                    js: {
                        type: 'string',
                        description: 'JavaScript to execute (for "evaluate" action)'
                    },
                    wait_for: {
                        type: 'string',
                        description: 'Optional selector to wait for after action'
                    }
                },
                required: ['action']
            }
        }
    }
};

// =========================
// Tool Categories (Color-Coded)
// =========================

/**
 * CORE TOOLS (Green) - Always available, even if model doesn't support structured tool calling
 * These are safe, read-only operations that can be parsed from text output
 */
const CORE_TOOLS = {
    names: ['rag_search', 'file_read', 'file_list'],
    color: 'green',
    description: 'Safe read-only tools - always available',
    alwaysParse: true  // Parse from text output even if model doesn't support tool_calls
};

/**
 * STANDARD TOOLS (Blue) - Available when model supports tool calling
 * Read-only and low-risk operations
 */
const STANDARD_TOOLS = {
    names: ['web_search', 'fetch_url', 'grep', 'memory_store', 'memory_retrieve', 'memory_list', 
            'get_file_summary', 'file_search', 'repo_map', 'npm_info'],
    color: 'blue',
    description: 'Standard tools - require tool calling support',
    alwaysParse: false
};

/**
 * WRITE TOOLS (Orange) - Dangerous operations, require explicit opt-in
 * Can modify files or execute commands
 */
const WRITE_TOOLS = {
    names: ['file_write', 'file_patch', 'run_command', 'browser_automation'],
    color: 'orange',
    description: 'Write/execute tools - require explicit enablement',
    alwaysParse: false
};

/**
 * Get tool definitions by category
 * @param {'core'|'standard'|'write'|'all'} category 
 * @returns {Array} Array of tool definitions
 */
function getToolsByCategory(category) {
    let toolNames = [];
    
    switch (category) {
        case 'core':
            toolNames = CORE_TOOLS.names;
            break;
        case 'standard':
            toolNames = STANDARD_TOOLS.names;
            break;
        case 'write':
            toolNames = WRITE_TOOLS.names;
            break;
        case 'all':
            toolNames = [...CORE_TOOLS.names, ...STANDARD_TOOLS.names, ...WRITE_TOOLS.names];
            break;
        default:
            return [];
    }
    
    return toolNames.map(name => MIDDLEWARE_TOOLS[name]).filter(Boolean);
}

/**
 * Get tool category info for a tool name
 * @param {string} toolName 
 * @returns {{category: string, color: string, description: string}|null}
 */
function getToolCategory(toolName) {
    if (CORE_TOOLS.names.includes(toolName)) {
        return { category: 'core', color: CORE_TOOLS.color, description: CORE_TOOLS.description };
    }
    if (STANDARD_TOOLS.names.includes(toolName)) {
        return { category: 'standard', color: STANDARD_TOOLS.color, description: STANDARD_TOOLS.description };
    }
    if (WRITE_TOOLS.names.includes(toolName)) {
        return { category: 'write', color: WRITE_TOOLS.color, description: WRITE_TOOLS.description };
    }
    return null;
}

/**
 * Get all tool categories with metadata
 */
function getAllToolCategories() {
    return [
        { ...CORE_TOOLS, tools: getToolsByCategory('core') },
        { ...STANDARD_TOOLS, tools: getToolsByCategory('standard') },
        { ...WRITE_TOOLS, tools: getToolsByCategory('write') }
    ];
}

// =========================
// Client Detection & Smart Tool Injection
// =========================

/**
 * Cursor's distinctive tool names - if we see these, it's Cursor
 */
const CURSOR_TOOL_SIGNATURES = new Set([
    'codebase_search',
    'grep', 
    'read_file',
    'edit_file',
    'run_terminal_cmd',
    'list_dir',
    'file_search',
    'delete_file',
    'search_replace',
    'write'
]);

/**
 * Detect if the request is coming from Cursor IDE
 * Detection methods:
 * 1. x-cursor-session header (most reliable)
 * 2. Presence of Cursor-specific tools in the request
 * @param {object} req - Express request object
 * @param {Array} tools - Tools array from request body
 * @returns {{isCursor: boolean, confidence: string, reason: string}}
 */
function detectClient(req, tools = []) {
    // Method 1: Check for Cursor-specific header
    const cursorSession = req.headers?.['x-cursor-session'];
    if (cursorSession) {
        return { isCursor: true, confidence: 'high', reason: 'x-cursor-session header present' };
    }
    
    // Method 2: Check for Cursor-specific tools
    if (Array.isArray(tools) && tools.length > 0) {
        const toolNames = tools.map(t => t.function?.name).filter(Boolean);
        const cursorTools = toolNames.filter(name => CURSOR_TOOL_SIGNATURES.has(name));
        
        if (cursorTools.length >= 2) {
            return { 
                isCursor: true, 
                confidence: 'high', 
                reason: `Found Cursor tools: ${cursorTools.slice(0, 3).join(', ')}` 
            };
        } else if (cursorTools.length === 1) {
            return { 
                isCursor: true, 
                confidence: 'medium', 
                reason: `Found Cursor tool: ${cursorTools[0]}` 
            };
        }
    }
    
    // Method 3: Check user-agent for cursor mentions
    const userAgent = req.headers?.['user-agent'] || '';
    if (userAgent.toLowerCase().includes('cursor')) {
        return { isCursor: true, confidence: 'medium', reason: 'User-agent contains cursor' };
    }
    
    return { isCursor: false, confidence: 'high', reason: 'No Cursor indicators found' };
}

/**
 * Get tools to inject based on client type and config settings
 * Respects toolCalling config: enabled, mode, coreToolsAlways, writeToolsEnabled
 * 
 * Modes:
 * - 'disabled': No tools injected
 * - 'core-only': Only core tools (rag_search, file_read, file_list)
 * - 'auto': Core + Standard tools (excludes write tools unless explicitly enabled)
 * - 'full': All tools including write tools
 * 
 * @param {boolean} isCursor - Whether the client is Cursor
 * @param {boolean} hasExistingTools - Whether the request already has tools
 * @param {object} modelCapabilities - Optional model capability info
 * @returns {Array} Array of tool definitions to inject
 */
function getToolsToInject(isCursor, hasExistingTools, modelCapabilities = null) {
    const toolConfig = getToolCallingConfig();
    
    // Master switch - if disabled, no tools
    if (!toolConfig.enabled || toolConfig.mode === 'disabled') {
        console.log('[Tools] Tool calling is disabled via config');
        return [];
    }
    
    // Determine which tools to include based on mode
    let toolsToInject = [];
    
    switch (toolConfig.mode) {
        case 'core-only':
            // Only core tools (green) - always safe
            toolsToInject = getToolsByCategory('core');
            console.log('[Tools] Mode: core-only - injecting core tools only');
            break;
            
        case 'full':
            // All tools including write tools
            toolsToInject = getToolsByCategory('all');
            console.log('[Tools] Mode: full - injecting all tools');
            break;
            
        case 'auto':
        default:
            // Core + Standard, optionally with write tools
            toolsToInject = [
                ...getToolsByCategory('core'),
                ...getToolsByCategory('standard')
            ];
            
            // Only add write tools if explicitly enabled
            if (toolConfig.writeToolsEnabled) {
                toolsToInject.push(...getToolsByCategory('write'));
                console.log('[Tools] Mode: auto - injecting core + standard + write tools');
            } else {
                console.log('[Tools] Mode: auto - injecting core + standard tools (write disabled)');
            }
            break;
    }
    
    // For Cursor, filter to complementary tools only
    if (isCursor) {
        const cursorComplementaryTools = new Set([
            'rag_search', 'web_search', 'fetch_url', 'npm_info',
            'memory_store', 'memory_retrieve', 'memory_list', 'browser_automation'
        ]);
        
        toolsToInject = toolsToInject.filter(t => 
            cursorComplementaryTools.has(t.function?.name)
        );
        console.log(`[Tools] Filtered for Cursor: ${toolsToInject.length} complementary tools`);
    }
    
    return toolsToInject;
}

// =========================
// Text-Based Tool Call Parser
// =========================

/**
 * Parse text-based tool calls from LLM output
 * Supports multiple formats:
 * - XML: <tool_call>{"name": "...", "arguments": {...}}</tool_call>
 * - JSON block: ```json\n{"name": "...", ...}\n```
 * - Function syntax: tool_name(arg1, arg2)
 * 
 * @param {string} content - LLM response content
 * @returns {Array<{name: string, arguments: object}>} Parsed tool calls
 */
function parseTextToolCalls(content) {
    if (!content || typeof content !== 'string') {
        return [];
    }
    
    const toolCalls = [];
    
    // Pattern 1: <tool_call>...</tool_call> format (most common for local models)
    const xmlPattern = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;
    let match;
    while ((match = xmlPattern.exec(content)) !== null) {
        try {
            const parsed = JSON.parse(match[1]);
            if (parsed.name || parsed.function) {
                toolCalls.push({
                    name: parsed.name || parsed.function?.name || parsed.function,
                    arguments: parsed.arguments || parsed.parameters || parsed.params || {}
                });
            }
        } catch (e) {
            // Try parsing as key-value if JSON fails
            const nameMatch = match[1].match(/"?name"?\s*[:=]\s*"([^"]+)"/);
            if (nameMatch) {
                toolCalls.push({
                    name: nameMatch[1],
                    arguments: {}
                });
            }
        }
    }
    
    // Pattern 2: ```json {...} ``` with tool call structure
    const jsonBlockPattern = /```(?:json)?\s*(\{[\s\S]*?"name"[\s\S]*?\})\s*```/gi;
    while ((match = jsonBlockPattern.exec(content)) !== null) {
        try {
            const parsed = JSON.parse(match[1]);
            if (parsed.name && !toolCalls.find(tc => tc.name === parsed.name)) {
                toolCalls.push({
                    name: parsed.name,
                    arguments: parsed.arguments || parsed.parameters || {}
                });
            }
        } catch (e) {
            // JSON parse failed, skip
        }
    }
    
    // Pattern 3: [tool: name](arguments) markdown-style
    const markdownPattern = /\[tool:\s*(\w+)\]\(([^)]*)\)/gi;
    while ((match = markdownPattern.exec(content)) !== null) {
        const name = match[1];
        if (!toolCalls.find(tc => tc.name === name)) {
            try {
                const args = match[2] ? JSON.parse(match[2]) : {};
                toolCalls.push({ name, arguments: args });
            } catch (e) {
                toolCalls.push({ name, arguments: { raw: match[2] } });
            }
        }
    }
    
    // Pattern 4: Function call syntax: tool_name({"key": "value"})
    const funcPattern = /\b(rag_search|file_read|file_list|web_search|fetch_url|grep|memory_\w+|file_\w+|run_command|get_file_summary|repo_map|npm_info|browser_automation)\s*\(\s*(\{[\s\S]*?\})\s*\)/gi;
    while ((match = funcPattern.exec(content)) !== null) {
        const name = match[1];
        if (!toolCalls.find(tc => tc.name === name)) {
            try {
                const args = JSON.parse(match[2]);
                toolCalls.push({ name, arguments: args });
            } catch (e) {
                // Parse failed, skip
            }
        }
    }
    
    return toolCalls;
}

/**
 * Check if content contains text-based tool calls
 * @param {string} content 
 * @returns {boolean}
 */
function hasTextToolCalls(content) {
    if (!content) return false;
    return (
        content.includes('<tool_call>') ||
        (content.includes('```json') && content.includes('"name"')) ||
        content.includes('[tool:') ||
        /\b(rag_search|file_read|web_search)\s*\(/.test(content)
    );
}

/**
 * Process text-based tool calls from LLM response
 * Executes core tools found in text and returns results
 * @param {string} content - LLM response content
 * @param {boolean} coreOnly - Only process core tools (default: true for safety)
 * @returns {Promise<{executed: Array, results: Array, remaining: string}>}
 */
async function processTextToolCalls(content, coreOnly = true) {
    const toolCalls = parseTextToolCalls(content);
    const executed = [];
    const results = [];
    
    for (const tc of toolCalls) {
        // Check if this tool should be executed
        const category = getToolCategory(tc.name);
        
        // Safety check: only execute core tools from text unless explicitly allowed
        if (coreOnly && category?.category !== 'core') {
            console.log(`[Tools] Skipping text-based ${tc.name} (not a core tool)`);
            continue;
        }
        
        // Check if it's a valid middleware tool
        if (!isMiddlewareTool(tc.name)) {
            console.log(`[Tools] Skipping unknown tool: ${tc.name}`);
            continue;
        }
        
        console.log(`[Tools] Executing text-based tool: ${tc.name}`);
        const result = await executeMiddlewareTool(tc.name, tc.arguments);
        
        executed.push(tc);
        results.push({
            toolName: tc.name,
            arguments: tc.arguments,
            success: result.success,
            result: result.result,
            error: result.error
        });
    }
    
    return { executed, results, originalContent: content };
}

/**
 * Execute a custom middleware tool
 * @param {string} toolName - Name of the tool to execute
 * @param {object} args - Tool arguments
 * @returns {Promise<{success: boolean, result?: any, error?: string}>}
 */
async function executeMiddlewareTool(toolName, args) {
    try {
        switch (toolName) {
            case 'rag_search': {
                const query = args.query;
                const topK = args.topK || 5;
                if (!query) {
                    return { success: false, error: 'Query is required' };
                }
                const results = await ragSearch(query, topK);
                const formatted = results.map(r => ({
                    filePath: r.filePath,
                    summary: r.summaryText || r.rawText?.slice(0, 500),
                    relevance: r.distance ? (1 - r.distance).toFixed(3) : 'N/A'
                }));
                return { success: true, result: formatted };
            }
            
            case 'file_read': {
                const filePath = args.path;
                if (!filePath) {
                    return { success: false, error: 'Path is required' };
                }
                const fs = require('fs').promises;
                const path = require('path');
                const fullPath = path.resolve(process.cwd(), filePath);
                // Security: ensure path is within workspace
                if (!fullPath.startsWith(process.cwd())) {
                    return { success: false, error: 'Path must be within workspace' };
                }
                const content = await fs.readFile(fullPath, 'utf-8');
                // Truncate very large files
                const maxLength = 50000;
                const truncated = content.length > maxLength 
                    ? content.slice(0, maxLength) + `\n... (truncated, ${content.length - maxLength} chars remaining)`
                    : content;
                return { success: true, result: truncated };
            }
            
            case 'get_file_summary': {
                const filePath = args.path;
                if (!filePath) {
                    return { success: false, error: 'Path is required' };
                }
                // Search for the file in RAG index
                const results = await ragSearch(`file:${filePath}`, 1);
                const fileResult = results.find(r => r.filePath?.includes(filePath));
                if (fileResult) {
                    return { 
                        success: true, 
                        result: {
                            filePath: fileResult.filePath,
                            summary: fileResult.summaryText || 'No summary available'
                        }
                    };
                }
                return { success: false, error: `No summary found for file: ${filePath}` };
            }
            
            case 'web_search': {
                const query = args.query;
                const numResults = Math.min(args.num_results || 5, 10);
                if (!query) {
                    return { success: false, error: 'Query is required' };
                }
                try {
                    // Use DuckDuckGo HTML search (no API key required)
                    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
                    const response = await axios.get(searchUrl, {
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                        },
                        timeout: 10000
                    });
                    
                    // Parse results from HTML
                    const html = response.data;
                    const results = [];
                    
                    // Simple regex parsing for DuckDuckGo results
                    const resultRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([^<]*)/g;
                    let match;
                    while ((match = resultRegex.exec(html)) !== null && results.length < numResults) {
                        const url = match[1];
                        const title = match[2].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
                        const snippet = match[3].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
                        if (url && title) {
                            results.push({ title, url, snippet });
                        }
                    }
                    
                    // Fallback: try alternate parsing if no results
                    if (results.length === 0) {
                        const altRegex = /<a[^>]*rel="nofollow"[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/g;
                        while ((match = altRegex.exec(html)) !== null && results.length < numResults) {
                            if (match[1].startsWith('http') && !match[1].includes('duckduckgo.com')) {
                                results.push({ title: match[2], url: match[1], snippet: '' });
                            }
                        }
                    }
                    
                    if (results.length === 0) {
                        return { success: true, result: { message: 'No results found', query } };
                    }
                    
                    return { success: true, result: { query, results } };
                } catch (searchError) {
                    console.error('[Tools] web_search error:', searchError.message);
                    return { success: false, error: `Search failed: ${searchError.message}` };
                }
            }
            
            case 'fetch_url': {
                const url = args.url;
                const selector = args.selector;
                const maxLength = args.max_length || 10000;
                
                if (!url) {
                    return { success: false, error: 'URL is required' };
                }
                
                // Validate URL
                try {
                    new URL(url);
                } catch (e) {
                    return { success: false, error: 'Invalid URL format' };
                }
                
                try {
                    const response = await axios.get(url, {
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
                        },
                        timeout: 15000,
                        maxContentLength: 5 * 1024 * 1024 // 5MB max
                    });
                    
                    let content = response.data;
                    
                    // If HTML, try to extract text content
                    if (typeof content === 'string' && content.includes('<html')) {
                        // Try to use cheerio if available, otherwise basic extraction
                        try {
                            const cheerio = require('cheerio');
                            const $ = cheerio.load(content);
                            
                            // Remove script and style elements
                            $('script, style, nav, footer, header, aside').remove();
                            
                            // If selector provided, use it
                            if (selector) {
                                const selected = $(selector);
                                if (selected.length > 0) {
                                    content = selected.text().trim();
                                } else {
                                    content = $('body').text().trim();
                                }
                            } else {
                                // Try common content selectors
                                const mainContent = $('article, main, .content, .post-content, #content, #readme').first();
                                if (mainContent.length > 0) {
                                    content = mainContent.text().trim();
                                } else {
                                    content = $('body').text().trim();
                                }
                            }
                            
                            // Clean up whitespace
                            content = content.replace(/\s+/g, ' ').replace(/\n\s*\n/g, '\n\n');
                        } catch (cheerioError) {
                            // Cheerio not available, basic text extraction
                            content = content
                                .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                                .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                                .replace(/<[^>]+>/g, ' ')
                                .replace(/\s+/g, ' ')
                                .trim();
                        }
                    }
                    
                    // Truncate if needed
                    if (content.length > maxLength) {
                        content = content.slice(0, maxLength) + `\n\n... (truncated, ${content.length - maxLength} chars remaining)`;
                    }
                    
                    return { 
                        success: true, 
                        result: { 
                            url, 
                            content,
                            contentLength: content.length
                        } 
                    };
                } catch (fetchError) {
                    console.error('[Tools] fetch_url error:', fetchError.message);
                    return { success: false, error: `Fetch failed: ${fetchError.message}` };
                }
            }
            
            case 'npm_info': {
                const packageName = args.package_name;
                if (!packageName) {
                    return { success: false, error: 'Package name is required' };
                }
                
                try {
                    // Fetch from npm registry
                    const registryUrl = `https://registry.npmjs.org/${encodeURIComponent(packageName)}`;
                    const response = await axios.get(registryUrl, { timeout: 10000 });
                    const data = response.data;
                    
                    const latestVersion = data['dist-tags']?.latest;
                    const latestInfo = data.versions?.[latestVersion] || {};
                    
                    const result = {
                        name: data.name,
                        description: data.description,
                        latestVersion,
                        license: latestInfo.license || data.license,
                        homepage: data.homepage,
                        repository: data.repository?.url,
                        keywords: (data.keywords || []).slice(0, 10),
                        dependencies: Object.keys(latestInfo.dependencies || {}).slice(0, 20),
                        devDependencies: Object.keys(latestInfo.devDependencies || {}).slice(0, 10),
                        readme: data.readme ? data.readme.slice(0, 2000) + (data.readme.length > 2000 ? '...' : '') : 'No readme available'
                    };
                    
                    return { success: true, result };
                } catch (npmError) {
                    if (npmError.response?.status === 404) {
                        return { success: false, error: `Package '${packageName}' not found on npm` };
                    }
                    console.error('[Tools] npm_info error:', npmError.message);
                    return { success: false, error: `NPM lookup failed: ${npmError.message}` };
                }
            }
            
            case 'file_list': {
                const fs = require('fs').promises;
                const path = require('path');
                const dirPath = args.path || '.';
                const recursive = args.recursive || false;
                const pattern = args.pattern;
                
                const fullPath = path.resolve(process.cwd(), dirPath);
                
                // Security: ensure path is within workspace
                if (!fullPath.startsWith(process.cwd())) {
                    return { success: false, error: 'Path must be within workspace' };
                }
                
                try {
                    const results = [];
                    const maxDepth = 3;
                    
                    async function listDir(dir, depth = 0) {
                        if (depth > maxDepth) return;
                        
                        const entries = await fs.readdir(dir, { withFileTypes: true });
                        
                        for (const entry of entries) {
                            // Skip hidden files and common ignored directories
                            if (entry.name.startsWith('.') || 
                                ['node_modules', 'dist', 'build', '.git', '__pycache__'].includes(entry.name)) {
                                continue;
                            }
                            
                            const entryPath = path.join(dir, entry.name);
                            const relativePath = path.relative(process.cwd(), entryPath);
                            
                            // Check pattern match if provided
                            if (pattern) {
                                const minimatch = require('minimatch');
                                if (!minimatch(relativePath, pattern, { matchBase: true })) {
                                    if (!entry.isDirectory()) continue;
                                }
                            }
                            
                            if (entry.isDirectory()) {
                                results.push({ name: relativePath, type: 'directory' });
                                if (recursive) {
                                    await listDir(entryPath, depth + 1);
                                }
                            } else {
                                try {
                                    const stats = await fs.stat(entryPath);
                                    results.push({
                                        name: relativePath,
                                        type: 'file',
                                        size: stats.size,
                                        modified: stats.mtime.toISOString()
                                    });
                                } catch {
                                    results.push({ name: relativePath, type: 'file' });
                                }
                            }
                        }
                    }
                    
                    await listDir(fullPath);
                    
                    // Limit results
                    const limited = results.slice(0, 100);
                    return { 
                        success: true, 
                        result: {
                            path: dirPath,
                            entries: limited,
                            total: results.length,
                            truncated: results.length > 100
                        }
                    };
                } catch (listError) {
                    console.error('[Tools] file_list error:', listError.message);
                    return { success: false, error: `Failed to list directory: ${listError.message}` };
                }
            }
            
            case 'file_search': {
                const fs = require('fs').promises;
                const path = require('path');
                const query = args.query;
                const searchContent = args.search_content || false;
                const filePattern = args.file_pattern || '**/*';
                const maxResults = Math.min(args.max_results || 20, 50);
                
                if (!query) {
                    return { success: false, error: 'Query is required' };
                }
                
                try {
                    const results = [];
                    const searchRegex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
                    
                    async function searchDir(dir, depth = 0) {
                        if (depth > 5 || results.length >= maxResults) return;
                        
                        let entries;
                        try {
                            entries = await fs.readdir(dir, { withFileTypes: true });
                        } catch {
                            return;
                        }
                        
                        for (const entry of entries) {
                            if (results.length >= maxResults) break;
                            
                            // Skip hidden and ignored
                            if (entry.name.startsWith('.') || 
                                ['node_modules', 'dist', 'build', '.git', '__pycache__', 'coverage'].includes(entry.name)) {
                                continue;
                            }
                            
                            const entryPath = path.join(dir, entry.name);
                            const relativePath = path.relative(process.cwd(), entryPath);
                            
                            if (entry.isDirectory()) {
                                await searchDir(entryPath, depth + 1);
                            } else {
                                // Check filename match
                                const filenameMatch = searchRegex.test(entry.name);
                                
                                if (searchContent && !filenameMatch) {
                                    // Search content
                                    try {
                                        const content = await fs.readFile(entryPath, 'utf-8');
                                        if (searchRegex.test(content)) {
                                            // Find matching lines
                                            const lines = content.split('\n');
                                            const matchingLines = [];
                                            lines.forEach((line, idx) => {
                                                if (searchRegex.test(line) && matchingLines.length < 3) {
                                                    matchingLines.push({ line: idx + 1, content: line.trim().slice(0, 100) });
                                                }
                                            });
                                            results.push({ 
                                                path: relativePath, 
                                                matchType: 'content',
                                                matches: matchingLines
                                            });
                                        }
                                    } catch {
                                        // Skip binary or unreadable files
                                    }
                                } else if (filenameMatch) {
                                    results.push({ path: relativePath, matchType: 'filename' });
                                }
                            }
                        }
                    }
                    
                    await searchDir(process.cwd());
                    
                    return { 
                        success: true, 
                        result: {
                            query,
                            searchContent,
                            results,
                            total: results.length
                        }
                    };
                } catch (searchError) {
                    console.error('[Tools] file_search error:', searchError.message);
                    return { success: false, error: `Search failed: ${searchError.message}` };
                }
            }
            
            case 'file_write': {
                const fs = require('fs').promises;
                const path = require('path');
                const filePath = args.path;
                const content = args.content;
                const createDirs = args.create_dirs !== false;
                
                if (!filePath) {
                    return { success: false, error: 'Path is required' };
                }
                if (content === undefined || content === null) {
                    return { success: false, error: 'Content is required' };
                }
                
                const fullPath = path.resolve(process.cwd(), filePath);
                
                // Security checks
                if (!fullPath.startsWith(process.cwd())) {
                    return { success: false, error: 'Path must be within workspace' };
                }
                
                // Block dangerous paths
                const dangerousPaths = ['.git', 'node_modules', '.env', 'package-lock.json'];
                if (dangerousPaths.some(p => filePath.includes(p))) {
                    return { success: false, error: `Cannot write to protected path: ${filePath}` };
                }
                
                // Block dangerous extensions in certain directories
                const ext = path.extname(filePath).toLowerCase();
                if (['.exe', '.dll', '.so', '.dylib', '.sh', '.bat', '.cmd', '.ps1'].includes(ext)) {
                    return { success: false, error: `Cannot write executable files: ${ext}` };
                }
                
                try {
                    // Create directories if needed
                    if (createDirs) {
                        await fs.mkdir(path.dirname(fullPath), { recursive: true });
                    }
                    
                    // Check if file exists
                    let existed = false;
                    try {
                        await fs.access(fullPath);
                        existed = true;
                    } catch {
                        existed = false;
                    }
                    
                    // Write file
                    await fs.writeFile(fullPath, content, 'utf-8');
                    
                    const stats = await fs.stat(fullPath);
                    
                    return { 
                        success: true, 
                        result: {
                            path: filePath,
                            created: !existed,
                            overwritten: existed,
                            size: stats.size,
                            message: existed ? `File overwritten: ${filePath}` : `File created: ${filePath}`
                        }
                    };
                } catch (writeError) {
                    console.error('[Tools] file_write error:', writeError.message);
                    return { success: false, error: `Failed to write file: ${writeError.message}` };
                }
            }
            
            case 'file_patch': {
                const fs = require('fs').promises;
                const path = require('path');
                const filePath = args.path;
                const search = args.search;
                const replace = args.replace;
                const replaceAll = args.all || false;
                
                if (!filePath) {
                    return { success: false, error: 'Path is required' };
                }
                if (!search) {
                    return { success: false, error: 'Search text is required' };
                }
                if (replace === undefined) {
                    return { success: false, error: 'Replace text is required' };
                }
                
                const fullPath = path.resolve(process.cwd(), filePath);
                
                // Security checks
                if (!fullPath.startsWith(process.cwd())) {
                    return { success: false, error: 'Path must be within workspace' };
                }
                
                const dangerousPaths = ['.git', 'node_modules', '.env', 'package-lock.json'];
                if (dangerousPaths.some(p => filePath.includes(p))) {
                    return { success: false, error: `Cannot modify protected path: ${filePath}` };
                }
                
                try {
                    const content = await fs.readFile(fullPath, 'utf-8');
                    
                    if (!content.includes(search)) {
                        return { success: false, error: `Search text not found in file: ${search.slice(0, 50)}...` };
                    }
                    
                    let newContent;
                    let replacements = 0;
                    
                    if (replaceAll) {
                        const parts = content.split(search);
                        replacements = parts.length - 1;
                        newContent = parts.join(replace);
                    } else {
                        newContent = content.replace(search, replace);
                        replacements = 1;
                    }
                    
                    await fs.writeFile(fullPath, newContent, 'utf-8');
                    
                    return {
                        success: true,
                        result: {
                            path: filePath,
                            replacements,
                            message: `Made ${replacements} replacement(s) in ${filePath}`
                        }
                    };
                } catch (patchError) {
                    console.error('[Tools] file_patch error:', patchError.message);
                    return { success: false, error: `Failed to patch file: ${patchError.message}` };
                }
            }
            
            case 'run_command': {
                const { exec } = require('child_process');
                const path = require('path');
                const command = args.command;
                const cwd = args.cwd || '.';
                const timeout = Math.min(args.timeout || 30000, 60000);
                
                if (!command) {
                    return { success: false, error: 'Command is required' };
                }
                
                // Security: block dangerous commands
                const dangerousPatterns = [
                    /rm\s+-rf\s+\//i,
                    /del\s+\/s\s+\/q\s+c:/i,
                    /format\s+c:/i,
                    /mkfs/i,
                    /dd\s+if=/i,
                    /:\s*\(\s*\)\s*\{/,  // Fork bomb
                    /wget.*\|.*sh/i,
                    /curl.*\|.*sh/i,
                    /powershell.*-enc/i,
                    /\.\/.*\.sh/i,
                ];
                
                if (dangerousPatterns.some(p => p.test(command))) {
                    return { success: false, error: 'Command blocked for security reasons' };
                }
                
                const workDir = path.resolve(process.cwd(), cwd);
                if (!workDir.startsWith(process.cwd())) {
                    return { success: false, error: 'Working directory must be within workspace' };
                }
                
                try {
                    const result = await new Promise((resolve, reject) => {
                        exec(command, { 
                            cwd: workDir, 
                            timeout,
                            maxBuffer: 1024 * 1024 // 1MB
                        }, (error, stdout, stderr) => {
                            if (error && error.killed) {
                                reject(new Error('Command timed out'));
                            } else {
                                resolve({
                                    exitCode: error ? error.code || 1 : 0,
                                    stdout: stdout.slice(0, 10000),
                                    stderr: stderr.slice(0, 5000)
                                });
                            }
                        });
                    });
                    
                    return {
                        success: true,
                        result: {
                            command,
                            ...result,
                            truncated: result.stdout.length >= 10000 || result.stderr.length >= 5000
                        }
                    };
                } catch (cmdError) {
                    console.error('[Tools] run_command error:', cmdError.message);
                    return { success: false, error: `Command failed: ${cmdError.message}` };
                }
            }
            
            case 'grep': {
                const fs = require('fs').promises;
                const path = require('path');
                const pattern = args.pattern;
                const searchPath = args.path || '.';
                const filePattern = args.file_pattern;
                const contextLines = Math.min(args.context_lines || 2, 5);
                const maxResults = Math.min(args.max_results || 20, 100);
                const caseInsensitive = args.case_insensitive || false;
                
                if (!pattern) {
                    return { success: false, error: 'Pattern is required' };
                }
                
                const fullPath = path.resolve(process.cwd(), searchPath);
                if (!fullPath.startsWith(process.cwd())) {
                    return { success: false, error: 'Path must be within workspace' };
                }
                
                try {
                    const regex = new RegExp(pattern, caseInsensitive ? 'gi' : 'g');
                    const results = [];
                    
                    async function searchFile(filePath) {
                        try {
                            const content = await fs.readFile(filePath, 'utf-8');
                            const lines = content.split('\n');
                            const relativePath = path.relative(process.cwd(), filePath);
                            
                            lines.forEach((line, idx) => {
                                if (results.length >= maxResults) return;
                                if (regex.test(line)) {
                                    regex.lastIndex = 0; // Reset regex
                                    const startLine = Math.max(0, idx - contextLines);
                                    const endLine = Math.min(lines.length - 1, idx + contextLines);
                                    
                                    const context = lines.slice(startLine, endLine + 1).map((l, i) => ({
                                        lineNum: startLine + i + 1,
                                        content: l.slice(0, 200),
                                        isMatch: startLine + i === idx
                                    }));
                                    
                                    results.push({
                                        file: relativePath,
                                        line: idx + 1,
                                        match: line.slice(0, 200),
                                        context
                                    });
                                }
                            });
                        } catch {
                            // Skip unreadable files
                        }
                    }
                    
                    async function searchDir(dir, depth = 0) {
                        if (depth > 5 || results.length >= maxResults) return;
                        
                        let entries;
                        try {
                            entries = await fs.readdir(dir, { withFileTypes: true });
                        } catch {
                            return;
                        }
                        
                        for (const entry of entries) {
                            if (results.length >= maxResults) break;
                            
                            if (entry.name.startsWith('.') || 
                                ['node_modules', 'dist', 'build', '.git', '__pycache__', 'coverage'].includes(entry.name)) {
                                continue;
                            }
                            
                            const entryPath = path.join(dir, entry.name);
                            
                            if (entry.isDirectory()) {
                                await searchDir(entryPath, depth + 1);
                            } else {
                                // Check file pattern
                                if (filePattern) {
                                    const minimatch = require('minimatch');
                                    if (!minimatch(entry.name, filePattern, { matchBase: true })) {
                                        continue;
                                    }
                                }
                                await searchFile(entryPath);
                            }
                        }
                    }
                    
                    const stat = await fs.stat(fullPath);
                    if (stat.isDirectory()) {
                        await searchDir(fullPath);
                    } else {
                        await searchFile(fullPath);
                    }
                    
                    return {
                        success: true,
                        result: {
                            pattern,
                            path: searchPath,
                            matches: results,
                            total: results.length,
                            truncated: results.length >= maxResults
                        }
                    };
                } catch (grepError) {
                    console.error('[Tools] grep error:', grepError.message);
                    return { success: false, error: `Grep failed: ${grepError.message}` };
                }
            }
            
            case 'memory_store': {
                const key = args.key;
                const value = args.value;
                const scope = args.scope || 'session';
                const category = args.category || 'general';
                
                if (!key) {
                    return { success: false, error: 'Key is required' };
                }
                if (value === undefined) {
                    return { success: false, error: 'Value is required' };
                }
                
                try {
                    // Use global memory store
                    if (!global.agentMemory) {
                        global.agentMemory = { session: {}, permanent: {} };
                    }
                    
                    if (scope === 'permanent') {
                        // Store in SQLite for persistence
                        const db = require('./sqlite_cache.js');
                        await db.saveAgentMemory(key, value, category);
                        global.agentMemory.permanent[key] = { value, category, updatedAt: Date.now() };
                    } else {
                        // Session memory (in-memory only)
                        global.agentMemory.session[key] = { value, category, updatedAt: Date.now() };
                    }
                    
                    return {
                        success: true,
                        result: {
                            key,
                            scope,
                            category,
                            message: `Stored "${key}" in ${scope} memory`
                        }
                    };
                } catch (memError) {
                    console.error('[Tools] memory_store error:', memError.message);
                    return { success: false, error: `Failed to store memory: ${memError.message}` };
                }
            }
            
            case 'memory_retrieve': {
                const key = args.key;
                const scope = args.scope || 'all';
                
                if (!key) {
                    return { success: false, error: 'Key is required' };
                }
                
                try {
                    if (!global.agentMemory) {
                        global.agentMemory = { session: {}, permanent: {} };
                    }
                    
                    let result = null;
                    let foundIn = null;
                    
                    // Check session first
                    if (scope === 'session' || scope === 'all') {
                        if (global.agentMemory.session[key]) {
                            result = global.agentMemory.session[key];
                            foundIn = 'session';
                        }
                    }
                    
                    // Check permanent if not found or scope is permanent
                    if (!result && (scope === 'permanent' || scope === 'all')) {
                        // Try cached permanent memory first
                        if (global.agentMemory.permanent[key]) {
                            result = global.agentMemory.permanent[key];
                            foundIn = 'permanent';
                        } else {
                            // Fall back to database
                            const db = require('./sqlite_cache.js');
                            const dbValue = await db.getAgentMemory(key);
                            if (dbValue) {
                                result = dbValue;
                                foundIn = 'permanent';
                                // Cache it
                                global.agentMemory.permanent[key] = result;
                            }
                        }
                    }
                    
                    if (!result) {
                        return { success: false, error: `Memory key not found: ${key}` };
                    }
                    
                    return {
                        success: true,
                        result: {
                            key,
                            value: result.value,
                            category: result.category,
                            scope: foundIn,
                            updatedAt: result.updatedAt
                        }
                    };
                } catch (memError) {
                    console.error('[Tools] memory_retrieve error:', memError.message);
                    return { success: false, error: `Failed to retrieve memory: ${memError.message}` };
                }
            }
            
            case 'memory_list': {
                const category = args.category;
                const scope = args.scope || 'all';
                
                try {
                    if (!global.agentMemory) {
                        global.agentMemory = { session: {}, permanent: {} };
                    }
                    
                    const memories = [];
                    
                    // List session memories
                    if (scope === 'session' || scope === 'all') {
                        for (const [key, data] of Object.entries(global.agentMemory.session)) {
                            if (!category || data.category === category) {
                                memories.push({ key, scope: 'session', category: data.category });
                            }
                        }
                    }
                    
                    // List permanent memories
                    if (scope === 'permanent' || scope === 'all') {
                        const db = require('./sqlite_cache.js');
                        const dbMemories = await db.listAgentMemories(category);
                        for (const mem of dbMemories) {
                            memories.push({ key: mem.key, scope: 'permanent', category: mem.category });
                        }
                    }
                    
                    return {
                        success: true,
                        result: {
                            memories,
                            total: memories.length
                        }
                    };
                } catch (memError) {
                    console.error('[Tools] memory_list error:', memError.message);
                    return { success: false, error: `Failed to list memories: ${memError.message}` };
                }
            }
            
            case 'repo_map': {
                const fs = require('fs').promises;
                const path = require('path');
                const searchPath = args.path || '.';
                const maxDepth = Math.min(args.depth || 3, 5);
                const includeSymbols = args.include_symbols !== false;
                const filePattern = args.file_pattern;
                
                const fullPath = path.resolve(process.cwd(), searchPath);
                if (!fullPath.startsWith(process.cwd())) {
                    return { success: false, error: 'Path must be within workspace' };
                }
                
                try {
                    const map = {
                        root: path.relative(process.cwd(), fullPath) || '.',
                        structure: [],
                        symbols: []
                    };
                    
                    // Simple symbol extraction regex patterns
                    const patterns = {
                        jsFunction: /(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?function)/g,
                        jsClass: /class\s+(\w+)/g,
                        pyFunction: /def\s+(\w+)\s*\(/g,
                        pyClass: /class\s+(\w+)/g,
                        tsInterface: /interface\s+(\w+)/g,
                        tsType: /type\s+(\w+)\s*=/g,
                        export: /export\s+(?:default\s+)?(?:function|class|const|let|var|interface|type)\s+(\w+)/g
                    };
                    
                    async function extractSymbols(filePath) {
                        try {
                            const content = await fs.readFile(filePath, 'utf-8');
                            const ext = path.extname(filePath).toLowerCase();
                            const relativePath = path.relative(process.cwd(), filePath);
                            const symbols = [];
                            
                            const extractMatches = (regex, type) => {
                                let match;
                                while ((match = regex.exec(content)) !== null) {
                                    const name = match[1] || match[2] || match[3];
                                    if (name && name.length > 1) {
                                        symbols.push({ name, type, file: relativePath });
                                    }
                                }
                                regex.lastIndex = 0;
                            };
                            
                            if (['.js', '.ts', '.jsx', '.tsx', '.mjs'].includes(ext)) {
                                extractMatches(patterns.jsFunction, 'function');
                                extractMatches(patterns.jsClass, 'class');
                                extractMatches(patterns.tsInterface, 'interface');
                                extractMatches(patterns.tsType, 'type');
                                extractMatches(patterns.export, 'export');
                            } else if (['.py'].includes(ext)) {
                                extractMatches(patterns.pyFunction, 'function');
                                extractMatches(patterns.pyClass, 'class');
                            }
                            
                            return symbols;
                        } catch {
                            return [];
                        }
                    }
                    
                    async function buildMap(dir, depth = 0, prefix = '') {
                        if (depth > maxDepth) return;
                        
                        let entries;
                        try {
                            entries = await fs.readdir(dir, { withFileTypes: true });
                        } catch {
                            return;
                        }
                        
                        entries.sort((a, b) => {
                            if (a.isDirectory() && !b.isDirectory()) return -1;
                            if (!a.isDirectory() && b.isDirectory()) return 1;
                            return a.name.localeCompare(b.name);
                        });
                        
                        for (const entry of entries) {
                            if (entry.name.startsWith('.') || 
                                ['node_modules', 'dist', 'build', '.git', '__pycache__', 'coverage', '.next'].includes(entry.name)) {
                                continue;
                            }
                            
                            const entryPath = path.join(dir, entry.name);
                            const relativePath = path.relative(process.cwd(), entryPath);
                            const indent = '  '.repeat(depth);
                            
                            if (entry.isDirectory()) {
                                map.structure.push(`${indent}📁 ${entry.name}/`);
                                await buildMap(entryPath, depth + 1, prefix + entry.name + '/');
                            } else {
                                // Check file pattern
                                if (filePattern) {
                                    const minimatch = require('minimatch');
                                    if (!minimatch(entry.name, filePattern, { matchBase: true })) {
                                        continue;
                                    }
                                }
                                
                                map.structure.push(`${indent}📄 ${entry.name}`);
                                
                                if (includeSymbols) {
                                    const symbols = await extractSymbols(entryPath);
                                    map.symbols.push(...symbols.slice(0, 20)); // Limit per file
                                }
                            }
                        }
                    }
                    
                    await buildMap(fullPath);
                    
                    // Limit total symbols
                    map.symbols = map.symbols.slice(0, 200);
                    
                    return {
                        success: true,
                        result: {
                            root: map.root,
                            structure: map.structure.join('\n'),
                            symbols: map.symbols,
                            totalFiles: map.structure.filter(s => s.includes('📄')).length,
                            totalDirs: map.structure.filter(s => s.includes('📁')).length,
                            totalSymbols: map.symbols.length
                        }
                    };
                } catch (mapError) {
                    console.error('[Tools] repo_map error:', mapError.message);
                    return { success: false, error: `Failed to build repo map: ${mapError.message}` };
                }
            }
            
            case 'browser_automation': {
                const action = args.action;
                const url = args.url;
                const selector = args.selector;
                const text = args.text;
                const js = args.js;
                const waitFor = args.wait_for;
                
                if (!action) {
                    return { success: false, error: 'Action is required' };
                }
                
                try {
                    // Lazy load playwright
                    let playwright;
                    try {
                        playwright = require('playwright');
                    } catch {
                        return { success: false, error: 'Playwright not installed. Run: npm install playwright' };
                    }
                    
                    // Use shared browser instance
                    if (!global.browserInstance) {
                        global.browserInstance = await playwright.chromium.launch({ headless: true });
                    }
                    
                    if (!global.browserPage) {
                        const context = await global.browserInstance.newContext();
                        global.browserPage = await context.newPage();
                    }
                    
                    const page = global.browserPage;
                    let result = {};
                    
                    switch (action) {
                        case 'navigate':
                            if (!url) {
                                return { success: false, error: 'URL is required for navigate action' };
                            }
                            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
                            result = { url: page.url(), title: await page.title() };
                            break;
                            
                        case 'click':
                            if (!selector) {
                                return { success: false, error: 'Selector is required for click action' };
                            }
                            await page.click(selector, { timeout: 10000 });
                            result = { clicked: selector };
                            break;
                            
                        case 'type':
                            if (!selector || !text) {
                                return { success: false, error: 'Selector and text are required for type action' };
                            }
                            await page.fill(selector, text);
                            result = { typed: text, into: selector };
                            break;
                            
                        case 'screenshot':
                            const screenshot = await page.screenshot({ type: 'png', fullPage: false });
                            result = { 
                                screenshot: `data:image/png;base64,${screenshot.toString('base64')}`.slice(0, 1000) + '...',
                                message: 'Screenshot captured (base64 truncated)'
                            };
                            break;
                            
                        case 'evaluate':
                            if (!js) {
                                return { success: false, error: 'JavaScript code is required for evaluate action' };
                            }
                            const evalResult = await page.evaluate(js);
                            result = { result: evalResult };
                            break;
                            
                        case 'extract':
                            if (!selector) {
                                return { success: false, error: 'Selector is required for extract action' };
                            }
                            const elements = await page.$$(selector);
                            const extracted = [];
                            for (const el of elements.slice(0, 20)) {
                                extracted.push({
                                    text: (await el.innerText()).slice(0, 200),
                                    tag: await el.evaluate(e => e.tagName.toLowerCase())
                                });
                            }
                            result = { elements: extracted, total: elements.length };
                            break;
                            
                        case 'scroll':
                            await page.evaluate(() => window.scrollBy(0, window.innerHeight));
                            result = { scrolled: true };
                            break;
                            
                        default:
                            return { success: false, error: `Unknown browser action: ${action}` };
                    }
                    
                    // Wait for element if specified
                    if (waitFor) {
                        await page.waitForSelector(waitFor, { timeout: 10000 });
                        result.waitedFor = waitFor;
                    }
                    
                    return { success: true, result };
                } catch (browserError) {
                    console.error('[Tools] browser_automation error:', browserError.message);
                    return { success: false, error: `Browser automation failed: ${browserError.message}` };
                }
            }
            
            default:
                return { success: false, error: `Unknown middleware tool: ${toolName}` };
        }
    } catch (error) {
        console.error(`[Tools] Error executing ${toolName}:`, error.message);
        return { success: false, error: error.message };
    }
}

/**
 * Check if a tool name is a custom middleware tool
 */
function isMiddlewareTool(toolName) {
    return toolName in MIDDLEWARE_TOOLS;
}

/**
 * Get all middleware tool definitions for injection into tools array
 */
function getMiddlewareToolDefinitions() {
    return Object.values(MIDDLEWARE_TOOLS);
}

/**
 * Process messages that may contain tool calls - handle middleware tools internally
 * @param {Array} messages - Chat messages array
 * @returns {Promise<{processedMessages: Array, toolResults: Array}>}
 */
async function processToolCallMessages(messages) {
    const processedMessages = [];
    const toolResults = [];
    
    for (const msg of messages) {
        // Check for tool call responses that need our handling
        if (msg.role === 'assistant' && msg.tool_calls) {
            processedMessages.push(msg);
            
            // Process each tool call
            for (const toolCall of msg.tool_calls) {
                const toolName = toolCall.function?.name;
                if (isMiddlewareTool(toolName)) {
                    // Execute middleware tool and queue result
                    const args = JSON.parse(toolCall.function?.arguments || '{}');
                    const result = await executeMiddlewareTool(toolName, args);
                    toolResults.push({
                        tool_call_id: toolCall.id,
                        role: 'tool',
                        content: JSON.stringify(result.success ? result.result : { error: result.error })
                    });
                }
            }
        } else if (msg.role === 'tool') {
            // Pass through tool responses - don't modify
            processedMessages.push(msg);
        } else {
            processedMessages.push(msg);
        }
    }
    
    // Append our tool results to the messages
    return { 
        processedMessages: [...processedMessages, ...toolResults], 
        toolResults 
    };
}

/**
 * OpenAI-compatible chat completions handler (shared by /v1/chat/completions and /chat/completions).
 */
async function handleChatCompletions(req, res, pathLabel = '/v1/chat/completions') {
    const started = Date.now();
    let budgetInfo = null;
    let ragResults = [];
    let sessionId = DEFAULT_CONVERSATION_ID;
        try {
        const { messages = [], temperature = 0.2, model: requestedModel, stream = false, topK = 5, conversationId: requestedConversationId, tools: requestTools, tool_choice, ...rest } = req.body || {};
        if (!Array.isArray(messages) || messages.length === 0) {
            return res.status(400).json({ error: 'messages array required' });
        }
        
        // =========================
        // Smart Tool Injection with Client Detection
        // =========================
        const clientDetection = detectClient(req, requestTools);
        const hasExistingTools = requestTools && Array.isArray(requestTools) && requestTools.length > 0;
        let toolsToUse = requestTools ? [...requestTools] : [];
        let workingMessages = [...messages];
        let toolChoiceToUse = tool_choice;
        
        // Log client detection
        console.log(`[Tools] Client detection: isCursor=${clientDetection.isCursor}, confidence=${clientDetection.confidence}, reason="${clientDetection.reason}"`);
        
        // Determine which middleware tools to inject
        const toolsToInject = getToolsToInject(clientDetection.isCursor, hasExistingTools);
        const existingToolNames = new Set(toolsToUse.map(t => t.function?.name));
        
        // Inject middleware tools that aren't already present
        let injectedCount = 0;
        for (const mwTool of toolsToInject) {
            if (!existingToolNames.has(mwTool.function.name)) {
                toolsToUse.push(mwTool);
                injectedCount++;
            }
        }
        
        // For clients without tools (like Continue), we now have tools to offer
        const hasToolCalls = toolsToUse.length > 0;
        
        if (injectedCount > 0) {
            const injectedNames = toolsToInject.map(t => t.function.name).join(', ');
            console.log(`[Tools] Injected ${injectedCount} middleware tool(s): ${injectedNames}`);
            
            // For clients that didn't send tools, set tool_choice to auto
            if (!hasExistingTools) {
                toolChoiceToUse = 'auto';
                console.log(`[Tools] Set tool_choice to 'auto' for client without existing tools`);
            }
        }
        
        if (hasExistingTools) {
            console.log(`[Tools] Request includes ${requestTools.length} client tools + ${injectedCount} middleware tools`);
        }
        
        // Process any pending tool calls from previous messages
        if (hasToolCalls) {
            const { processedMessages, toolResults } = await processToolCallMessages(workingMessages);
            if (toolResults.length > 0) {
                console.log(`[Tools] Processed ${toolResults.length} middleware tool calls`);
                workingMessages = processedMessages;
            }
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
        const latestUser = [...workingMessages].reverse().find(m => m?.role === 'user');
        if (!latestUser || !latestUser.content) {
            // For tool call flows, user message might not be the latest - allow continuation
            if (!hasToolCalls) {
                return res.status(400).json({ error: 'at least one user message required' });
            }
        }
        const userPrompt = latestUser ? (typeof latestUser.content === 'string'
            ? latestUser.content
            : Array.isArray(latestUser.content)
                ? latestUser.content.map(c => c.text || '').join('\n')
                : JSON.stringify(latestUser.content)) : '';
        
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
        let enhancedMessages = [];
        
        // Check if this is a tool-calling request - preserve message structure
        if (hasToolCalls) {
            // Build tool awareness prompt for injected tools
            const injectedToolNames = toolsToInject.map(t => t.function.name);
            const toolAwarenessPrompt = injectedCount > 0 
                ? `\n\nYou have access to the following tools:\n${injectedToolNames.map(name => {
                    const tool = MIDDLEWARE_TOOLS[name];
                    return `- ${name}: ${tool?.function?.description || 'No description'}`;
                }).join('\n')}\n\nUse these tools when appropriate to help answer questions about the codebase.`
                : '';
            
            // For tool calls: preserve full message structure including tool_calls and tool responses
            // Only inject RAG context into system message if one exists
            const existingSystem = workingMessages.find(m => m.role === 'system');
            if (existingSystem) {
                // Enhance existing system message with RAG context and tool awareness
                enhancedMessages.push({
                    ...existingSystem,
                    content: existingSystem.content + toolAwarenessPrompt + '\n\n--- Codebase Context ---\n' + composedPrompt
                });
                // Add rest of messages (excluding the system we just modified)
                for (const msg of workingMessages) {
                    if (msg.role !== 'system') {
                        enhancedMessages.push(msg);
                    }
                }
            } else {
                // No system message - prepend one with context and tool awareness
                enhancedMessages.push({
                    role: 'system',
                    content: `You are a coding assistant with access to tools. Use the provided codebase context and tools when helpful.${toolAwarenessPrompt}\n\n--- Codebase Context ---\n` + composedPrompt
                });
                enhancedMessages.push(...workingMessages);
            }
            console.log(`[Tools] Preserved ${enhancedMessages.length} messages with tool structure`);
        } else {
            // Standard flow: rebuild messages with context
            enhancedMessages.push({
                role: 'system',
                content: 'You are a coding assistant. Use the provided context and summaries to answer.\n\n' + composedPrompt
            });
            // Add original user messages (but replace last user message with just the prompt since context is in system)
            for (let i = 0; i < workingMessages.length - 1; i++) {
                enhancedMessages.push(workingMessages[i]);
            }
            enhancedMessages.push({ role: 'user', content: userPrompt });
        }

        // Ensure context fits model - summarize if needed
        // This handles both turn-based (engine ON) and context-based (engine OFF) summarization
        // Skip for tool calls to preserve message structure
        if (!hasToolCalls) {
            try {
                enhancedMessages = await ensureContextFitsModel(enhancedMessages);
            } catch (summaryError) {
                console.warn('[Summary] Context fitting failed, using original messages:', summaryError?.message || summaryError);
            }
        }

        // Determine which model to use based on active preset
        let modelToUse;
        const config = getConfig();
        const activePreset = config.models?.activePreset;

        if (activePreset === 'custom') {
            // Use custom preset selection
            modelToUse = config.models?.customPreset?.main || config.models?.main?.identifier;
        } else if (activePreset && ['high', 'medium', 'low'].includes(activePreset)) {
            // Use quality preset selection
            const presetModel = config.models?.perQualityMainModels?.[activePreset];
            if (presetModel) {
                modelToUse = presetModel;
            } else {
                // Fall back to default main model
                modelToUse = config.models?.main?.identifier;
            }
        } else {
            // No preset or unknown preset, use default main model
            modelToUse = config.models?.main?.identifier;
        }

        // Ensure we have a valid model
        if (!modelToUse) {
            modelToUse = getModelConfig('main').identifier;
        }

        // Log if Cursor requested a different model (for debugging)
        if (requestedModel && requestedModel !== modelToUse) {
            console.log(`[Server] Cursor requested model '${requestedModel}', using selected model '${modelToUse}'`);
        }
        
        if (stream) {
            const lmStarted = Date.now();
            
            // =========================
            // Streaming with Tool Execution Loop
            // =========================
            // When tools are enabled, we need to handle tool calls internally.
            // We use non-streaming internally to detect tool_calls, execute them,
            // and only stream the final response back to the client.
            
            if (hasToolCalls) {
                console.log('[Tools] Streaming request with tools - hybrid streaming mode');
                
                // Prepare SSE headers first
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');
                if (!res.writableEnded) {
                    res.write(`data: ${JSON.stringify({ type: 'session', sessionId })}\n\n`);
                }
                
                // Helper to send progress updates to client
                const sendProgress = (message, toolName = null) => {
                    if (!res.writableEnded) {
                        res.write(`data: ${JSON.stringify({
                            type: 'tool_progress',
                            message,
                            tool: toolName,
                            timestamp: Date.now()
                        })}\n\n`);
                    }
                };
                
                const MAX_TOOL_ITERATIONS = 10;
                let currentMessages = [...enhancedMessages];
                let iteration = 0;
                let toolIterations = 0;
                let streamedContent = '';
                
                try {
                    while (iteration < MAX_TOOL_ITERATIONS) {
                        iteration++;
                        console.log(`[Tools] Streaming tool loop iteration ${iteration}`);
                        
                        // Check if this might be the final iteration
                        // We peek with non-streaming first to detect tool_calls
                        const peekPayload = {
                            model: modelToUse,
                            messages: currentMessages,
                            temperature,
                            stream: false,
                            tools: toolsToUse,
                            tool_choice: iteration === 1 ? (toolChoiceToUse || 'auto') : 'auto',
                            ...rest,
                        };
                        
                        sendProgress(`🤔 Thinking... (iteration ${iteration})`);
                        
                        const peekResponse = await proxyChatCompletion(peekPayload, null);
                        const assistantMessage = peekResponse?.choices?.[0]?.message;
                        
                        if (!assistantMessage) {
                            console.error('[Tools] No assistant message in response');
                            break;
                        }
                        
                        const toolCalls = assistantMessage.tool_calls || [];
                        
                        if (toolCalls.length === 0) {
                            // No tool calls - this is the final response!
                            // Now re-request with STREAMING enabled for real-time output
                            console.log(`[Tools] Final iteration ${iteration} - streaming real response`);
                            toolIterations = iteration;
                            
                            sendProgress('✨ Generating response...');
                            
                            const streamPayload = {
                                model: modelToUse,
                                messages: currentMessages,
                                temperature,
                                stream: true,
                                // Don't include tools on final call to avoid tool_calls
                                ...rest,
                            };
                            
                            // Stream the real response
                            streamedContent = await proxyChatCompletion(streamPayload, res);
                            streamedContent = sanitizeAssistantText(streamedContent);
                            break;
                        }
                        
                        // Check which are middleware tools
                        const middlewareToolCalls = toolCalls.filter(tc => isMiddlewareTool(tc.function?.name));
                        const externalToolCalls = toolCalls.filter(tc => !isMiddlewareTool(tc.function?.name));
                        
                        console.log(`[Tools] LLM called ${toolCalls.length} tools: ${middlewareToolCalls.length} middleware, ${externalToolCalls.length} external`);
                        
                        // If all external, we can't help - stream the partial response
                        if (middlewareToolCalls.length === 0 && externalToolCalls.length > 0) {
                            console.log('[Tools] All tool calls are external - streaming partial response');
                            toolIterations = iteration;
                            
                            const partialContent = assistantMessage.content || 'I tried to use tools that are not available. Please try a different approach.';
                            
                            // Stream the partial content
                            const chunkSize = 20;
                            for (let i = 0; i < partialContent.length; i += chunkSize) {
                                const chunk = partialContent.slice(i, i + chunkSize);
                                if (!res.writableEnded) {
                                    res.write(`data: ${JSON.stringify({
                                        id: `chatcmpl-${Date.now()}`,
                                        object: 'chat.completion.chunk',
                                        created: Math.floor(Date.now() / 1000),
                                        model: modelToUse,
                                        choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }]
                                    })}\n\n`);
                                }
                            }
                            streamedContent = partialContent;
                            break;
                        }
                        
                        // Add assistant message with tool_calls
                        currentMessages.push({
                            role: 'assistant',
                            content: assistantMessage.content || null,
                            tool_calls: toolCalls
                        });
                        
                        // Execute middleware tools with progress updates
                        for (const toolCall of middlewareToolCalls) {
                            const toolName = toolCall.function?.name;
                            let args = {};
                            try {
                                args = JSON.parse(toolCall.function?.arguments || '{}');
                            } catch (parseErr) {
                                console.error(`[Tools] Failed to parse arguments for ${toolName}:`, parseErr.message);
                            }
                            
                            // Send progress update to client
                            const toolEmoji = {
                                'rag_search': '🔍',
                                'file_read': '📄',
                                'file_write': '✏️',
                                'file_patch': '🔧',
                                'file_list': '📁',
                                'file_search': '🔎',
                                'web_search': '🌐',
                                'fetch_url': '🌍',
                                'npm_info': '📦',
                                'grep': '🔍',
                                'run_command': '⚙️',
                                'memory_store': '💾',
                                'memory_retrieve': '📖',
                                'memory_list': '📋',
                                'repo_map': '🗺️',
                                'browser_automation': '🌐',
                                'get_file_summary': '📝',
                            }[toolName] || '🔧';
                            
                            sendProgress(`${toolEmoji} Executing ${toolName}...`, toolName);
                            
                            console.log(`[Tools] Executing middleware tool: ${toolName}`);
                            const result = await executeMiddlewareTool(toolName, args);
                            
                            // Send completion update
                            if (result.success) {
                                sendProgress(`✅ ${toolName} completed`, toolName);
                            } else {
                                sendProgress(`❌ ${toolName} failed: ${result.error}`, toolName);
                            }
                            
                            currentMessages.push({
                                role: 'tool',
                                tool_call_id: toolCall.id,
                                content: JSON.stringify(result.success ? result.result : { error: result.error })
                            });
                        }
                        
                        // Handle external tool calls with error message
                        for (const toolCall of externalToolCalls) {
                            const toolName = toolCall.function?.name;
                            sendProgress(`⚠️ Skipping external tool: ${toolName}`, toolName);
                            currentMessages.push({
                                role: 'tool',
                                tool_call_id: toolCall.id,
                                content: JSON.stringify({ 
                                    error: `Tool '${toolName}' is a client-side tool and cannot be executed by the middleware.` 
                                })
                            });
                        }
                    }
                    
                    if (iteration >= MAX_TOOL_ITERATIONS && !streamedContent) {
                        const errorMsg = 'Tool execution exceeded maximum iterations.';
                        if (!res.writableEnded) {
                            res.write(`data: ${JSON.stringify({
                                id: `chatcmpl-${Date.now()}`,
                                object: 'chat.completion.chunk',
                                created: Math.floor(Date.now() / 1000),
                                model: modelToUse,
                                choices: [{ index: 0, delta: { content: errorMsg }, finish_reason: null }]
                            })}\n\n`);
                        }
                        streamedContent = errorMsg;
                    }
                    
                    // Send final done message if not already sent by proxyChatCompletion
                    if (!res.writableEnded) {
                        res.write(`data: ${JSON.stringify({
                            type: 'tool_summary',
                            iterations: toolIterations,
                            timestamp: Date.now()
                        })}\n\n`);
                        // proxyChatCompletion already sends [DONE], so we just end
                        if (!streamedContent) {
                            res.write('data: [DONE]\n\n');
                        }
                        res.end();
                    }
                    
                    const lmDuration = Date.now() - lmStarted;
                    const duration = Date.now() - started;
                    console.log(`[RESP] ${pathLabel} STREAM+TOOLS 200 in ${duration}ms (LM ${lmDuration}ms) rag=${ragResults.length} iterations=${toolIterations}`);
                    
                    const persistedTurn = await persistConversationTurn({
                        sessionId,
                        userPrompt,
                        assistantResponse: streamedContent,
                        rawContextText,
                        composedContextText: composedPrompt,
                        budgetInfo,
                        ragResults,
                        llmPayloadKind: 'chat',
                        llmPayload: { model: modelToUse, messages: currentMessages, tools: toolsToUse },
                    });
                    void pushSessionUpdate({ sessionId, turn: persistedTurn });
                    
                    if (summaryActive) {
                        recomputeRollingSummary(sessionId, summaryKeepRecentTurns).catch(err => 
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
                    
                } catch (toolErr) {
                    console.error('[Server] Streaming tool loop failed:', toolErr);
                    if (!res.writableEnded) {
                        res.write(`data: ${JSON.stringify({ error: toolErr?.message || 'tool execution failed' })}\n\n`);
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
                        error: toolErr?.message || 'tool execution failed',
                        sessionId,
                        contextMode: budgetInfo?.mode || null
                    });
                    return;
                }
            }
            
            // Standard streaming (no tools)
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
        let completionResponse;
        let content;
        let nonStreamPayload;
        
        if (hasToolCalls) {
            // =========================
            // Tool Execution Loop
            // =========================
            // This loop handles cases where the LLM calls middleware tools.
            // We execute those tools internally, add results to messages,
            // and re-prompt the LLM until we get a final text response.
            // This prevents tool calls from being passed back to clients
            // that don't support them (like Continue).
            
            const MAX_TOOL_ITERATIONS = 10; // Prevent infinite loops
            let currentMessages = [...enhancedMessages];
            let iteration = 0;
            let finalResponse = null;
            
            while (iteration < MAX_TOOL_ITERATIONS) {
                iteration++;
                console.log(`[Tools] Tool execution loop iteration ${iteration}`);
                
                // Build the request payload
                nonStreamPayload = {
                    model: modelToUse,
                    messages: currentMessages,
                    temperature,
                    stream: false,
                    tools: toolsToUse,
                    tool_choice: iteration === 1 ? (toolChoiceToUse || 'auto') : 'auto',
                    ...rest,
                };
                
                // Call the LLM
                completionResponse = await proxyChatCompletion(nonStreamPayload, null);
                const assistantMessage = completionResponse?.choices?.[0]?.message;
                
                if (!assistantMessage) {
                    console.error('[Tools] No assistant message in response');
                    break;
                }
                
                // Check if the LLM made tool calls
                const toolCalls = assistantMessage.tool_calls || [];
                
                if (toolCalls.length === 0) {
                    // No tool calls - LLM gave us a final text response
                    console.log(`[Tools] Final response received after ${iteration} iteration(s)`);
                    finalResponse = completionResponse;
                    break;
                }
                
                // Check which tool calls are middleware tools
                const middlewareToolCalls = toolCalls.filter(tc => isMiddlewareTool(tc.function?.name));
                const externalToolCalls = toolCalls.filter(tc => !isMiddlewareTool(tc.function?.name));
                
                console.log(`[Tools] LLM called ${toolCalls.length} tools: ${middlewareToolCalls.length} middleware, ${externalToolCalls.length} external`);
                
                // If all tool calls are external (client tools), pass back to client
                if (middlewareToolCalls.length === 0 && externalToolCalls.length > 0) {
                    console.log('[Tools] All tool calls are external - returning to client');
                    finalResponse = completionResponse;
                    break;
                }
                
                // Add assistant message with tool_calls to conversation
                currentMessages.push({
                    role: 'assistant',
                    content: assistantMessage.content || null,
                    tool_calls: toolCalls
                });
                
                // Execute middleware tools and collect results
                for (const toolCall of middlewareToolCalls) {
                    const toolName = toolCall.function?.name;
                    let args = {};
                    try {
                        args = JSON.parse(toolCall.function?.arguments || '{}');
                    } catch (parseErr) {
                        console.error(`[Tools] Failed to parse arguments for ${toolName}:`, parseErr.message);
                    }
                    
                    console.log(`[Tools] Executing middleware tool: ${toolName}`, Object.keys(args));
                    const result = await executeMiddlewareTool(toolName, args);
                    
                    // Add tool result to messages
                    currentMessages.push({
                        role: 'tool',
                        tool_call_id: toolCall.id,
                        content: JSON.stringify(result.success ? result.result : { error: result.error })
                    });
                }
                
                // For external tool calls, we need to add placeholder results
                // since we can't execute them (they're client-side tools)
                for (const toolCall of externalToolCalls) {
                    const toolName = toolCall.function?.name;
                    console.log(`[Tools] External tool called but not executed: ${toolName}`);
                    currentMessages.push({
                        role: 'tool',
                        tool_call_id: toolCall.id,
                        content: JSON.stringify({ 
                            error: `Tool '${toolName}' is a client-side tool and cannot be executed by the middleware. Please use a different approach or available middleware tools.` 
                        })
                    });
                }
            }
            
            if (!finalResponse) {
                console.error(`[Tools] Tool loop exceeded max iterations (${MAX_TOOL_ITERATIONS})`);
                finalResponse = completionResponse || {
                    choices: [{ message: { role: 'assistant', content: 'Tool execution loop exceeded maximum iterations.' } }]
                };
            }
            
            // Extract final content
            content = finalResponse?.choices?.[0]?.message?.content || '';
            content = sanitizeAssistantText(content);
            
            // Persist the conversation turn
            const persistedTurn = await persistConversationTurn({
                sessionId,
                userPrompt,
                assistantResponse: content,
                rawContextText,
                composedContextText: composedPrompt,
                budgetInfo,
                ragResults,
                llmPayloadKind: 'chat',
                llmPayload: nonStreamPayload,
            });
            void pushSessionUpdate({ sessionId, turn: persistedTurn });
            
            // Return OpenAI-compatible format
            // Include tool_calls in response ONLY if there are external tools the client should handle
            const responseMessage = finalResponse?.choices?.[0]?.message || { role: 'assistant', content };
            const externalToolCalls = (responseMessage.tool_calls || []).filter(tc => !isMiddlewareTool(tc.function?.name));
            
            const finalMessage = {
                role: 'assistant',
                content: content
            };
            
            // Only include tool_calls if there are external ones for the client
            if (externalToolCalls.length > 0) {
                finalMessage.tool_calls = externalToolCalls;
            }
            
            res.json({
                id: finalResponse?.id || `chatcmpl-${Date.now()}`,
                object: 'chat.completion',
                created: finalResponse?.created || Math.floor(Date.now() / 1000),
                model: modelToUse,
                choices: [{
                    index: 0,
                    message: finalMessage,
                    finish_reason: finalResponse?.choices?.[0]?.finish_reason || 'stop'
                }],
                usage: finalResponse?.usage || {
                    prompt_tokens: budgetInfo?.usedTokens || 0,
                    completion_tokens: Math.ceil((content?.length || 0) / 4),
                    total_tokens: (budgetInfo?.usedTokens || 0) + Math.ceil((content?.length || 0) / 4)
                },
                session_id: sessionId,
                context_mode: appliedContextMode || sessionMode,
                tool_iterations: iteration
            });
        } else {
            // Standard completion flow
            const chatCompletionRequest = {
                prompt: composedPrompt,
                systemPrompt: BASE_SYSTEM_PROMPT,
                temperature,
            };
            completionResponse = await generateCompletion(chatCompletionRequest);
            nonStreamPayload = {
                ...chatCompletionRequest,
                model: modelToUse,
            };
            
            // Extract content
            content = sanitizeAssistantText(extractAssistantText(completionResponse));

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
        }

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

/**
 * GET /v1/models - List all available models (OpenAI-compatible)
 */
app.get('/v1/models', async (req, res) => {
    try {
        const loadedModels = await listLoadedModels();
        
        // Format as OpenAI-compatible response
        const models = loadedModels.map(m => ({
            id: m.id,
            object: 'model',
            created: Math.floor(Date.now() / 1000),
            owned_by: 'lmstudio',
            permission: [],
            root: m.id,
            parent: null
        }));
        
        res.json({
            object: 'list',
            data: models
        });
    } catch (error) {
        console.error('[API] /v1/models failed:', error.message);
        res.status(500).json({ 
            error: { 
                message: error.message, 
                type: 'server_error' 
            } 
        });
    }
});

/**
 * GET /v1/models/:model - Get specific model info (OpenAI-compatible)
 */
app.get('/v1/models/:model', async (req, res) => {
    try {
        const modelId = req.params.model;
        const loadedModels = await listLoadedModels();
        const model = loadedModels.find(m => m.id === modelId || m.id.includes(modelId));
        
        if (!model) {
            return res.status(404).json({
                error: {
                    message: `Model '${modelId}' not found`,
                    type: 'invalid_request_error',
                    code: 'model_not_found'
                }
            });
        }
        
        res.json({
            id: model.id,
            object: 'model',
            created: Math.floor(Date.now() / 1000),
            owned_by: 'lmstudio',
            permission: [],
            root: model.id,
            parent: null
        });
    } catch (error) {
        console.error('[API] /v1/models/:model failed:', error.message);
        res.status(500).json({ 
            error: { 
                message: error.message, 
                type: 'server_error' 
            } 
        });
    }
});

/**
 * POST /v1/embeddings - Generate embeddings (OpenAI-compatible)
 */
app.post('/v1/embeddings', async (req, res) => {
    try {
        const { input, model, encoding_format } = req.body;
        
        if (!input) {
            return res.status(400).json({
                error: {
                    message: 'Missing required parameter: input',
                    type: 'invalid_request_error'
                }
            });
        }
        
        // Handle both single string and array of strings
        const texts = Array.isArray(input) ? input : [input];
        const results = [];
        let totalTokens = 0;
        
        for (let i = 0; i < texts.length; i++) {
            const text = texts[i];
            const result = await embedText(text);
            
            if (result.failed || !result.embeddingVector) {
                return res.status(500).json({
                    error: {
                        message: result.error || 'Embedding generation failed',
                        type: 'server_error'
                    }
                });
            }
            
            // Estimate tokens (rough approximation)
            totalTokens += Math.ceil(text.length / 4);
            
            results.push({
                object: 'embedding',
                index: i,
                embedding: Array.from(result.embeddingVector)
            });
        }
        
        res.json({
            object: 'list',
            data: results,
            model: model || 'text-embedding',
            usage: {
                prompt_tokens: totalTokens,
                total_tokens: totalTokens
            }
        });
    } catch (error) {
        console.error('[API] /v1/embeddings failed:', error.message);
        res.status(500).json({ 
            error: { 
                message: error.message, 
                type: 'server_error' 
            } 
        });
    }
});

/**
 * POST /v1/completions - Legacy text completions (OpenAI-compatible)
 */
app.post('/v1/completions', async (req, res) => {
    try {
        const { model, prompt, max_tokens, temperature = 0.7, stream = false } = req.body;
        
        if (!prompt) {
            return res.status(400).json({
                error: {
                    message: 'Missing required parameter: prompt',
                    type: 'invalid_request_error'
                }
            });
        }
        
        // Convert to chat format and use existing infrastructure
        const result = await generateCompletion({
            prompt: prompt,
            temperature: temperature,
            model: model
        });
        
        // Extract text from chat completion response
        const text = result?.choices?.[0]?.message?.content || '';
        
        res.json({
            id: `cmpl-${Date.now()}`,
            object: 'text_completion',
            created: Math.floor(Date.now() / 1000),
            model: model || 'default',
            choices: [{
                text: text,
                index: 0,
                logprobs: null,
                finish_reason: 'stop'
            }],
            usage: result?.usage || {
                prompt_tokens: 0,
                completion_tokens: 0,
                total_tokens: 0
            }
        });
    } catch (error) {
        console.error('[API] /v1/completions failed:', error.message);
        res.status(500).json({ 
            error: { 
                message: error.message, 
                type: 'server_error' 
            } 
        });
    }
});

// =============================================================================
// DEBUG / DIAGNOSTICS ENDPOINTS
// =============================================================================

/**
 * GET /debug/system-health - Get health status of all RAG components
 */
app.get('/debug/system-health', async (req, res) => {
    try {
        const health = {
            embedder: { status: 'loading', message: 'Checking...' },
            ragSummarizer: { status: 'loading', message: 'Checking...' },
            faiss: { status: 'loading', message: 'Checking...', chunkCount: 0 },
            lmstudio: { status: 'loading', message: 'Checking...' }
        };

        // Check Embedder
        try {
            // Just check if embedder module is available
            const { embedText } = require('./lmstudio/embeddings.js');
            if (typeof embedText === 'function') {
                health.embedder = { status: 'ok', message: 'Jina Code v2 ready' };
            }
        } catch (e) {
            health.embedder = { status: 'error', message: e.message };
        }

        // Check RAG Summarizer (via LM Studio)
        try {
            const { getRagPipelineTier } = require('./config.js');
            const { getRagSummarizerConfig } = require('./rag_pipeline_config.js');
            const tier = getRagPipelineTier();
            const ragSumConfig = getRagSummarizerConfig(tier);
            health.ragSummarizer = { 
                status: 'ok', 
                message: `${ragSumConfig.model_name} (${tier} tier)` 
            };
        } catch (e) {
            health.ragSummarizer = { status: 'error', message: e.message };
        }

        // Check FAISS Index
        try {
            if (faissIndexManager) {
                const count = await faissIndexManager.count();
                health.faiss = { 
                    status: count > 0 ? 'ok' : 'warn', 
                    message: count > 0 ? 'Index loaded' : 'Index empty',
                    chunkCount: count
                };
            } else {
                health.faiss = { status: 'error', message: 'FAISS not initialized' };
            }
        } catch (e) {
            health.faiss = { status: 'error', message: e.message };
        }

        // Check LM Studio
        try {
            const { isLMStudioRunning } = require('./lmstudio_manager.js');
            const { getLMStudioConfig } = require('./config.js');
            const cfg = getLMStudioConfig();
            const isRunning = await isLMStudioRunning(cfg.url);
            health.lmstudio = { 
                status: isRunning ? 'ok' : 'error', 
                message: isRunning ? 'Connected' : 'Not connected'
            };
        } catch (e) {
            health.lmstudio = { status: 'error', message: e.message };
        }

        res.json({ status: 'ok', health });
    } catch (error) {
        res.status(500).json({ error: 'Health check failed', details: error.message });
    }
});

/**
 * POST /debug/test-embedder - Test the embedder with sample text
 */
app.post('/debug/test-embedder', async (req, res) => {
    try {
        const { text } = req.body || {};
        if (!text) {
            return res.status(400).json({ error: 'Missing text field' });
        }

        const startTime = Date.now();
        const { embedText } = require('./lmstudio/embeddings.js');
        const result = await embedText(text);
        const timeMs = Date.now() - startTime;

        if (result.failed || !result.embeddingVector) {
            return res.json({ status: 'error', error: result.error || 'Embedding failed' });
        }

        res.json({
            status: 'ok',
            dimension: result.embeddingVector.length,
            sample: Array.from(result.embeddingVector.slice(0, 10)),
            timeMs
        });
    } catch (error) {
        res.json({ status: 'error', error: error.message });
    }
});

/**
 * POST /debug/test-rag - Test RAG search
 */
app.post('/debug/test-rag', async (req, res) => {
    try {
        const { query, topK = 5 } = req.body || {};
        if (!query) {
            return res.status(400).json({ error: 'Missing query field' });
        }

        const startTime = Date.now();
        const { embedText } = require('./lmstudio/embeddings.js');
        const embResult = await embedText(query);
        
        if (embResult.failed || !embResult.embeddingVector) {
            return res.json({ status: 'error', error: embResult.error || 'Embedding failed' });
        }
        
        // Search FAISS
        const searchResults = await faissIndexManager.search(embResult.embeddingVector, topK);
        
        // Get chunk details from SQLite
        const results = [];
        for (const r of searchResults) {
            const chunk = await sqliteCacheManager.getChunkById(r.id);
            if (chunk) {
                results.push({
                    chunk: {
                        id: chunk.id,
                        filePath: chunk.file_path,
                        chunkIndex: chunk.chunk_index,
                        originalCode: chunk.original_code?.slice(0, 300),
                        summary: chunk.summary?.slice(0, 200),
                        tokens: chunk.tokens
                    },
                    score: r.score
                });
            }
        }

        const timeMs = Date.now() - startTime;
        res.json({ status: 'ok', results, timeMs });
    } catch (error) {
        res.json({ status: 'error', error: error.message });
    }
});

/**
 * POST /debug/test-summarizer - Test the RAG summarizer
 */
app.post('/debug/test-summarizer', async (req, res) => {
    try {
        const { text } = req.body || {};
        if (!text) {
            return res.status(400).json({ error: 'Missing text field' });
        }

        const startTime = Date.now();
        const { summarizeChunk } = require('./lmstudio/chat.js');
        const summary = await summarizeChunk(text);
        const timeMs = Date.now() - startTime;

        res.json({ status: 'ok', summary, timeMs });
    } catch (error) {
        res.json({ status: 'error', error: error.message });
    }
});

/**
 * GET /debug/rag/stats - Get RAG index statistics
 */
app.get('/debug/rag/stats', async (req, res) => {
    try {
        const totalChunks = await faissIndexManager.count();
        
        // Get stats from SQLite
        const dbStats = await sqliteCacheManager.getStats();
        
        const { getStorageConfig } = require('./config.js');
        const storageCfg = getStorageConfig();
        
        res.json({
            status: 'ok',
            stats: {
                totalChunks,
                totalFiles: dbStats?.fileCount || 0,
                totalTokens: dbStats?.totalTokens || 0,
                avgChunkSize: dbStats?.avgChunkSize || 0,
                indexDimension: storageCfg.embedding_dimension || 768,
                lastIndexed: dbStats?.lastIndexed || null
            }
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to get stats', details: error.message });
    }
});

/**
 * GET /debug/rag/files - Get list of indexed files
 */
app.get('/debug/rag/files', async (req, res) => {
    try {
        const files = await sqliteCacheManager.getIndexedFiles();
        res.json({ status: 'ok', files });
    } catch (error) {
        res.status(500).json({ error: 'Failed to get files', details: error.message });
    }
});

/**
 * GET /debug/rag/chunks - Get chunks (optionally filtered by file)
 */
app.get('/debug/rag/chunks', async (req, res) => {
    try {
        const { filePath, limit = 50, offset = 0 } = req.query;
        const chunks = await sqliteCacheManager.getChunks({
            filePath,
            limit: parseInt(limit, 10),
            offset: parseInt(offset, 10)
        });
        res.json({ status: 'ok', chunks });
    } catch (error) {
        res.status(500).json({ error: 'Failed to get chunks', details: error.message });
    }
});

/**
 * GET /debug/rag/chunk/:id - Get single chunk with full details
 */
app.get('/debug/rag/chunk/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const chunk = await sqliteCacheManager.getChunkById(id);
        
        if (!chunk) {
            return res.status(404).json({ error: 'Chunk not found' });
        }

        // Get embedding preview from FAISS if available
        let embeddingPreview = [];
        try {
            const embedding = await faissIndexManager.getEmbedding(id);
            if (embedding) {
                embeddingPreview = Array.from(embedding.slice(0, 20));
            }
        } catch (_) {
            // Embedding lookup failed, that's ok
        }

        res.json({
            status: 'ok',
            chunk: {
                id: chunk.id,
                filePath: chunk.file_path,
                chunkIndex: chunk.chunk_index,
                originalCode: chunk.original_code,
                summary: chunk.summary,
                tokens: chunk.tokens,
                embeddingPreview,
                createdAt: chunk.created_at
            }
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to get chunk', details: error.message });
    }
});

/**
 * POST /debug/rag/search-explain - Search with detailed explanation
 */
app.post('/debug/rag/search-explain', async (req, res) => {
    try {
        const { query, topK = 10 } = req.body || {};
        if (!query) {
            return res.status(400).json({ error: 'Missing query field' });
        }

        const { embedText } = require('./lmstudio/embeddings.js');
        const embResult = await embedText(query);
        
        if (embResult.failed || !embResult.embeddingVector) {
            return res.status(500).json({ error: 'Embedding failed', details: embResult.error });
        }
        
        const queryEmbedding = embResult.embeddingVector;
        
        // Search FAISS with scores
        const searchResults = await faissIndexManager.search(queryEmbedding, topK);
        
        // Enrich with chunk data
        const results = [];
        for (const r of searchResults) {
            const chunk = await sqliteCacheManager.getChunkById(r.id);
            if (chunk) {
                results.push({
                    chunk: {
                        id: chunk.id,
                        filePath: chunk.file_path,
                        chunkIndex: chunk.chunk_index,
                        originalCode: chunk.original_code,
                        summary: chunk.summary,
                        tokens: chunk.tokens,
                        createdAt: chunk.created_at
                    },
                    score: r.score,
                    explanation: `Cosine similarity: ${(r.score * 100).toFixed(2)}%`
                });
            }
        }

        res.json({
            status: 'ok',
            query,
            queryEmbeddingDimension: queryEmbedding.length,
            results
        });
    } catch (error) {
        res.status(500).json({ error: 'Search failed', details: error.message });
    }
});

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

        // Validate config consistency at startup
        console.log('[Server] Validating configuration...');
        const { issues, warnings } = await validateConfigConsistency();
        if (issues.length > 0) {
            console.warn('[Server] Config validation found issues - please check logs');
        }

        // Initialize centralized LM Studio API (unloads all models for clean state)
        console.log('[Server] Initializing LM Studio API...');
        try {
            const { initialize: initializeLMStudioAPI, setBroadcastCallback } = require('./lmstudio/lmstudio_api.js');
            setBroadcastCallback(broadcastWsMessage);
            await initializeLMStudioAPI();
            console.log('[Server] LM Studio API initialized (all models unloaded for clean state)');
        } catch (error) {
            console.warn('[Server] LM Studio API initialization failed:', error.message);
            console.warn('[Server] You may need to start LM Studio manually');
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
        // Set up WebSocket broadcast callback for bootstrap status updates
        setStatusBroadcastCallback(broadcastBootstrapStatus);
        
        const systemConfig = getConfig().system || {};
        const autoBootstrapOnStartup = systemConfig.autoBootstrapOnStartup !== false; // Default to true
        
        if (autoBootstrapOnStartup) {
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
        } else {
            console.log('[Server] Auto-bootstrap disabled (system.autoBootstrapOnStartup = false)');
        }

        // Initialize indexer status from persisted database
        console.log('[Server] Initializing indexer status from database...');
        try {
            await initializeIndexingStatusFromDatabase();
            console.log('[Server] Indexer status initialized successfully.');
        } catch (error) {
            console.warn('[Server] Indexer status initialization failed:', error.message);
        }

        // Auto-load active preset models (in background, non-blocking)
        // Note: Reusing systemConfig from above (already defined)
        if (systemConfig.autoLoadModels !== false) { // Default to true
            const activePreset = getConfig().models?.activePreset || 'medium';
            const delayMs = systemConfig.autoLoadDelayMs || 2000;

            console.log(`[Server] Auto-loading preset '${activePreset}' in ${delayMs}ms...`);

            setTimeout(async () => {
                try {
                    const { ensurePresetModelsLoaded } = require('./lmstudio/model_manager.js');
                    const result = await ensurePresetModelsLoaded(activePreset);

                    const loadedCount = result.loaded.length;
                    const keptCount = result.kept.length;
                    const failedCount = result.failed.length;

                    console.log(`[Server] ✅ Auto-loaded preset '${activePreset}': loaded=${loadedCount}, kept=${keptCount}, failed=${failedCount}`);

                    if (failedCount > 0) {
                        console.warn(`[Server] ⚠️  Some models failed to load:`, result.failed);
                    }
                } catch (error) {
                    console.warn(`[Server] ❌ Auto-loading failed for preset '${activePreset}':`, error.message);
                    console.warn('[Server] Models will need to be loaded manually via the UI');
                }
            }, delayMs);
        } else {
            console.log('[Server] Auto-loading disabled (system.autoLoadModels = false)');
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

