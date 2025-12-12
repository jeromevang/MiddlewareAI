#!/usr/bin/env node

const crypto = require('crypto');
const { getLMStudioConfig } = require('../config.js');

const lmStudioConfig = getLMStudioConfig();
const LM_STUDIO_URL = lmStudioConfig.url;
const LM_STUDIO_TIMEOUT_MS = lmStudioConfig.timeout_ms || 60000;
const MAX_RETRIES = lmStudioConfig.max_retries || 3;
const TOKENS_PER_CHAR_APPROX = 0.25;
const MAX_EMBED_CHARS = 4000;
const CLOUD_REQUEST_TIMEOUT_MS = LM_STUDIO_TIMEOUT_MS;

const loadedModels = new Set();
const loadingModels = new Map();
const lmStudioQueue = [];
let lmStudioActive = false;
let lastLoadedSnapshot = null;

function generateRequestId() {
    return crypto.randomBytes(4).toString('hex');
}

async function withLMStudioLock(fn) {
    return new Promise((resolve, reject) => {
        lmStudioQueue.push({ fn, resolve, reject });
        if (!lmStudioActive) {
            lmStudioActive = true;
            void (async function run() {
                while (lmStudioQueue.length > 0) {
                    const job = lmStudioQueue.shift();
                    try {
                        const result = await job.fn();
                        job.resolve(result);
                    } catch (err) {
                        job.reject(err);
                    }
                }
                lmStudioActive = false;
            })();
        }
    });
}

function setLastLoadedSnapshot(snapshot) {
    lastLoadedSnapshot = snapshot;
}

function getLastLoadedSnapshot() {
    return lastLoadedSnapshot;
}

module.exports = {
    LM_STUDIO_URL,
    LM_STUDIO_TIMEOUT_MS,
    MAX_RETRIES,
    TOKENS_PER_CHAR_APPROX,
    MAX_EMBED_CHARS,
    CLOUD_REQUEST_TIMEOUT_MS,
    loadedModels,
    loadingModels,
    withLMStudioLock,
    generateRequestId,
    setLastLoadedSnapshot,
    getLastLoadedSnapshot,
};
