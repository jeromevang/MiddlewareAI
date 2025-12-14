#!/usr/bin/env node

const { getRuntimeConfig } = require('./config.js');

function getRuntimeMode() {
    const cfg = getRuntimeConfig() || {};
    return (cfg.mode || 'local').toLowerCase();
}

function isCloudMode() {
    return getRuntimeMode() === 'cloud';
}

function getCloudMainConfig() {
    const cfg = getRuntimeConfig() || {};
    return cfg.cloud_main || {};
}

function getCloudConfig() {
    const cfg = getRuntimeConfig() || {};
    return cfg.cloud || {};
}

function getCloudQdrantConfig() {
    const cloudCfg = getCloudConfig();
    return cloudCfg.qdrant || {};
}

function requireModeHealthCheck() {
    const cfg = getRuntimeConfig() || {};
    return !!(cfg.mode_switch && cfg.mode_switch.require_health);
}

module.exports = {
    getRuntimeMode,
    isCloudMode,
    getCloudMainConfig,
    getCloudConfig,
    getCloudQdrantConfig,
    requireModeHealthCheck,
};
