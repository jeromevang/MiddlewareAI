#!/usr/bin/env node

/**
 * Processing state manager for runtime-overridable knobs.
 */

const { getProcessingConfig, updateConfigFile } = require('./config.js');

const DEFAULT_KEEP_RECENT = 3;
const MAX_KEEP_RECENT = 10;
const CONTEXT_MODES = ['raw', 'compressed'];
const DEFAULT_CONTEXT_MODE = 'raw';
const DEFAULT_RAW_MARGIN = 0.1;
const MIN_RAW_MARGIN = 0.01;
const MAX_RAW_MARGIN = 0.5;
const DEFAULT_MAX_CONTEXT = 4096;

let summaryKeepRecentTurns = null;
let contextModeDefault = null;
let rawContextMarginPct = null;
let mainModelMaxContext = DEFAULT_MAX_CONTEXT;

// Per-model context tracking
const loadedModelContexts = new Map();

function normalizeKeepRecent(value) {
    const num = Number(value);
    if (!Number.isFinite(num) || num < 0) {
        return DEFAULT_KEEP_RECENT;
    }
    return Math.min(MAX_KEEP_RECENT, Math.floor(num));
}

function ensureInitialized() {
    if (summaryKeepRecentTurns === null || contextModeDefault === null || rawContextMarginPct === null) {
        refreshProcessingStateFromConfig();
    }
}

function refreshProcessingStateFromConfig() {
    const cfg = getProcessingConfig() || {};
    summaryKeepRecentTurns = normalizeKeepRecent(cfg.summary_keep_recent_turns);
    contextModeDefault = normalizeContextMode(cfg.context_mode_default);
    rawContextMarginPct = normalizeRawMargin(cfg.raw_context_margin_pct);
    return {
        summaryKeepRecentTurns,
        contextModeDefault,
        rawContextMarginPct,
    };
}

function getSummaryKeepRecentTurns() {
    ensureInitialized();
    return summaryKeepRecentTurns;
}

function setSummaryKeepRecentTurns(value, { persist = true } = {}) {
    const normalized = normalizeKeepRecent(value);
    summaryKeepRecentTurns = normalized;
    if (persist) {
        updateConfigFile((draft) => {
            const next = { ...draft };
            next.processing = next.processing || {};
            next.processing.summary_keep_recent_turns = normalized;
            return next;
        });
    }
    return summaryKeepRecentTurns;
}

function normalizeContextMode(mode) {
    if (typeof mode !== 'string') {
        return DEFAULT_CONTEXT_MODE;
    }
    const lowered = mode.trim().toLowerCase();
    return CONTEXT_MODES.includes(lowered) ? lowered : DEFAULT_CONTEXT_MODE;
}

function normalizeRawMargin(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) {
        return DEFAULT_RAW_MARGIN;
    }
    return Math.min(MAX_RAW_MARGIN, Math.max(MIN_RAW_MARGIN, Number(num.toFixed(3))));
}

function getContextModeDefault() {
    ensureInitialized();
    return contextModeDefault;
}

function setContextModeDefault(mode, { persist = true } = {}) {
    const normalized = normalizeContextMode(mode);
    contextModeDefault = normalized;
    if (persist) {
        updateConfigFile((draft) => {
            const next = { ...draft };
            next.processing = next.processing || {};
            next.processing.context_mode_default = normalized;
            return next;
        });
    }
    return contextModeDefault;
}

function getRawContextMarginPct() {
    ensureInitialized();
    return rawContextMarginPct;
}

function setRawContextMarginPct(value, { persist = true } = {}) {
    const normalized = normalizeRawMargin(value);
    rawContextMarginPct = normalized;
    if (persist) {
        updateConfigFile((draft) => {
            const next = { ...draft };
            next.processing = next.processing || {};
            next.processing.raw_context_margin_pct = normalized;
            return next;
        });
    }
    return rawContextMarginPct;
}

/**
 * Get the current main model's max context size in tokens.
 * @returns {number} - Max context tokens
 */
function getMainModelMaxContext() {
    return mainModelMaxContext;
}

/**
 * Set the main model's max context size (called when model is loaded).
 * @param {number} tokens - Max context tokens for the loaded model
 */
function setMainModelMaxContext(tokens) {
    const parsed = Number(tokens);
    if (Number.isFinite(parsed) && parsed > 0) {
        mainModelMaxContext = parsed;
        console.log(`[Context] Main model max context updated: ${mainModelMaxContext} tokens`);
    } else {
        console.warn(`[Context] Invalid max context value: ${tokens}, keeping ${mainModelMaxContext}`);
    }
}

// ============================================================================
// Per-Model Context Tracking
// ============================================================================

/**
 * Set the context length for a specific loaded model.
 * @param {string} modelId - Model identifier
 * @param {number} contextLength - Context length in tokens
 */
function setModelContextLength(modelId, contextLength) {
    if (!modelId) return;
    const parsed = Number(contextLength);
    if (Number.isFinite(parsed) && parsed > 0) {
        loadedModelContexts.set(modelId, parsed);
        console.log(`[Context] Model ${modelId} context set to ${parsed} tokens`);
    }
}

/**
 * Get the context length for a specific loaded model.
 * @param {string} modelId - Model identifier
 * @returns {number|null} - Context length or null if not tracked
 */
function getModelContextLength(modelId) {
    if (!modelId) return null;
    return loadedModelContexts.get(modelId) || null;
}

/**
 * Remove a model from context tracking (when unloaded).
 * @param {string} modelId - Model identifier
 */
function clearModelContextLength(modelId) {
    if (modelId) {
        loadedModelContexts.delete(modelId);
    }
}

/**
 * Get all tracked model context lengths.
 * @returns {Object} - Map of modelId to contextLength
 */
function getAllModelContexts() {
    return Object.fromEntries(loadedModelContexts);
}

module.exports = {
    getSummaryKeepRecentTurns,
    setSummaryKeepRecentTurns,
    getContextModeDefault,
    setContextModeDefault,
    getRawContextMarginPct,
    setRawContextMarginPct,
    refreshProcessingStateFromConfig,
    getMainModelMaxContext,
    setMainModelMaxContext,
    setModelContextLength,
    getModelContextLength,
    clearModelContextLength,
    getAllModelContexts,
};
