#!/usr/bin/env node

/**
 * Processing state manager for runtime-overridable knobs.
 */

const { getProcessingConfig, updateConfigFile } = require('./config.js');

const DEFAULT_KEEP_RECENT = 3;
const MAX_KEEP_RECENT = 10;

let summaryKeepRecentTurns = null;

function normalizeKeepRecent(value) {
    const num = Number(value);
    if (!Number.isFinite(num) || num < 0) {
        return DEFAULT_KEEP_RECENT;
    }
    return Math.min(MAX_KEEP_RECENT, Math.floor(num));
}

function ensureInitialized() {
    if (summaryKeepRecentTurns === null) {
        refreshProcessingStateFromConfig();
    }
}

function refreshProcessingStateFromConfig() {
    const cfg = getProcessingConfig() || {};
    summaryKeepRecentTurns = normalizeKeepRecent(cfg.summary_keep_recent_turns);
    return summaryKeepRecentTurns;
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

module.exports = {
    getSummaryKeepRecentTurns,
    setSummaryKeepRecentTurns,
    refreshProcessingStateFromConfig,
};
