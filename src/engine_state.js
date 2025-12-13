#!/usr/bin/env node

const { getConfig, updateConfigFile } = require('./config.js');

const ENGINE_KEYS = ['rag', 'summary'];

function coerceEnabled(value, fallback = true) {
    if (typeof value === 'boolean') return value;
    return fallback;
}

function buildBaseState() {
    const cfg = getConfig();
    const engines = cfg.engines || {};
    return {
        rag: {
            enabled: coerceEnabled(engines.rag?.enabled, true),
        },
        summary: {
            enabled: coerceEnabled(engines.summary?.enabled, true),
        }
    };
}

let baseState = buildBaseState();
const overrides = {
    rag: null,
    summary: null,
};

let ragBypassCount = 0;

function refreshEngineStateFromConfig() {
    baseState = buildBaseState();
}

function getEngineState(engine) {
    if (!ENGINE_KEYS.includes(engine)) {
        throw new Error(`Unknown engine: ${engine}`);
    }
    const base = baseState[engine] || { enabled: true };
    const override = overrides[engine];
    if (!override) {
        return { ...base, source: 'config' };
    }
    return {
        ...base,
        ...override,
        source: override.source || 'override',
        updatedAt: override.updatedAt || Date.now(),
    };
}

function setEngineOverride(engine, nextState) {
    if (!ENGINE_KEYS.includes(engine)) {
        throw new Error(`Unknown engine: ${engine}`);
    }
    overrides[engine] = {
        ...(overrides[engine] || {}),
        ...nextState,
        updatedAt: Date.now(),
    };
}

function clearEngineOverride(engine) {
    if (!ENGINE_KEYS.includes(engine)) {
        throw new Error(`Unknown engine: ${engine}`);
    }
    overrides[engine] = null;
}

function persistEngineEnabled(engine, enabled) {
    updateConfigFile((current) => {
        const next = { ...current };
        next.engines = next.engines || {};
        next.engines[engine] = next.engines[engine] || {};
        next.engines[engine].enabled = !!enabled;
        return next;
    });
    refreshEngineStateFromConfig();
}

function updateEngineEnabled(engine, enabled, { persist = false } = {}) {
    setEngineOverride(engine, { enabled: !!enabled, source: persist ? 'config' : 'override' });
    if (persist) {
        persistEngineEnabled(engine, enabled);
        clearEngineOverride(engine);
    }
}

function isRagEnabled() {
    return !!getEngineState('rag').enabled;
}

function isSummaryEnabled() {
    return !!getEngineState('summary').enabled;
}

function getEnginesSnapshot() {
    return {
        rag: { ...getEngineState('rag'), bypassedRequests: ragBypassCount },
        summary: getEngineState('summary'),
    };
}

function incrementRagBypass() {
    ragBypassCount += 1;
}

function resetRagBypassCount() {
    ragBypassCount = 0;
}

module.exports = {
    getEnginesSnapshot,
    isRagEnabled,
    isSummaryEnabled,
    updateEngineEnabled,
    refreshEngineStateFromConfig,
    incrementRagBypass,
    resetRagBypassCount,
};
