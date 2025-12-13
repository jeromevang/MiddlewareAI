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

let summaryKeepRecentTurns = null;
let contextModeDefault = null;
let rawContextMarginPct = null;

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

module.exports = {
    getSummaryKeepRecentTurns,
    setSummaryKeepRecentTurns,
    getContextModeDefault,
    setContextModeDefault,
    getRawContextMarginPct,
    setRawContextMarginPct,
    refreshProcessingStateFromConfig,
};
