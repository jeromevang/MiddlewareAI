'use strict';

// Default endpoint for debug telemetry when no override is provided.
const DEFAULT_DEBUG_LOG_ENDPOINT = 'http://127.0.0.1:7242/ingest/1125f441-1d5b-4fd7-b3b9-6ab8dc90022a';
const RATE_LIMIT_WINDOW_MS = 2000;
const RATE_LIMIT_MAX_KEYS = 200;

const fallbackSessionId = `session-${process.pid}`;
const fallbackRunId = `run-${Date.now()}`;
const recentEvents = new Map();

let telemetryOverride = null;

function isTelemetryEnabled() {
    if (telemetryOverride !== null) {
        return telemetryOverride;
    }
    const flag = process.env.ENABLE_DEBUG_TELEMETRY;
    if (!flag) {
        return false;
    }
    const normalized = String(flag).trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function setTelemetryOverride(value) {
    if (value === null || value === undefined) {
        telemetryOverride = null;
        return telemetryOverride;
    }
    telemetryOverride = Boolean(value);
    return telemetryOverride;
}

function getTelemetryOverride() {
    return telemetryOverride;
}

function resolveEndpoint() {
    const override = process.env.DEBUG_LOG_ENDPOINT;
    if (override && override.trim()) {
        return override.trim();
    }
    return DEFAULT_DEBUG_LOG_ENDPOINT;
}

function safeStringify(payload) {
    try {
        return JSON.stringify(payload);
    } catch (err) {
        const fallbackPayload = {
            sessionId: payload.sessionId,
            runId: payload.runId,
            hypothesisId: payload.hypothesisId,
            location: payload.location,
            message: payload.message,
            data: { note: 'payload serialization failed', error: err ? err.message : 'unknown' },
            timestamp: payload.timestamp
        };
        return JSON.stringify(fallbackPayload);
    }
}

// Simple sliding window to avoid repeated identical messages.
function isRateLimited(key, now) {
    const last = recentEvents.get(key);
    if (last && now - last < RATE_LIMIT_WINDOW_MS) {
        return true;
    }
    recentEvents.set(key, now);
    if (recentEvents.size > RATE_LIMIT_MAX_KEYS) {
        for (const [entryKey, ts] of recentEvents) {
            if (now - ts > RATE_LIMIT_WINDOW_MS) {
                recentEvents.delete(entryKey);
            }
        }
    }
    return false;
}

async function logDebugEvent(event) {
    if (!event || typeof event !== 'object') {
        return;
    }
    if (!isTelemetryEnabled()) {
        return;
    }
    if (typeof fetch !== 'function') {
        return;
    }

    const { location, message, data, hypothesisId } = event;
    if (!location || !message) {
        return;
    }

    const endpoint = resolveEndpoint();
    if (!endpoint) {
        return;
    }

    const now = Date.now();
    const rateKey = `${location}::${message}`;
    if (isRateLimited(rateKey, now)) {
        return;
    }

    const payload = {
        sessionId: process.env.DEBUG_LOG_SESSION || fallbackSessionId,
        runId: process.env.DEBUG_LOG_RUN || fallbackRunId,
        hypothesisId: hypothesisId || 'HX',
        location,
        message,
        data: data !== undefined ? data : {},
        timestamp: now
    };

    try {
        await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: safeStringify(payload)
        });
    } catch (_) {
        // Swallow network errors silently.
    }
}

module.exports = {
    logDebugEvent,
    isTelemetryEnabled,
    setTelemetryOverride,
    getTelemetryOverride
};
