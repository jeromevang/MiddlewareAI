#!/usr/bin/env node

/**
 * LM Studio Manager
 *
 * Starts LM Studio server (optional) and loads required models using the LM Studio CLI.
 */

const { spawn } = require('child_process');
const os = require('os');
const { getLMStudioConfig, getModelConfig } = require('./config.js');
const axios = require('axios');
const net = require('net');

const loadedModels = new Set();

function expandPath(p) {
    if (!p) return p;
    if (p.startsWith('~')) {
        return p.replace('~', os.homedir());
    }
    if (os.platform() === 'win32' && p.includes('%USERPROFILE%')) {
        return p.replace('%USERPROFILE%', process.env.USERPROFILE || os.homedir());
    }
    return p;
}

/**
 * Resolve LM Studio CLI path by platform.
 */
function getLMStudioCLIPath() {
    const cfg = getLMStudioConfig();
    const cli = cfg.cli_path || {};
    switch (os.platform()) {
        case 'win32':
            return expandPath(cli.windows);
        case 'darwin':
            return expandPath(cli.darwin);
        case 'linux':
            return expandPath(cli.linux);
        default:
            throw new Error(`Unsupported platform: ${os.platform()}`);
    }
}

/**
 * Check if LM Studio server is running (TCP check only; no HTTP probe).
 */
async function isLMStudioRunning(url) {
    try {
        const parsed = new URL(url);
        const port = Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80);
        await new Promise((resolve, reject) => {
            const socket = net.connect({ host: parsed.hostname, port, timeout: 1500 }, () => {
                socket.end();
                resolve();
            });
            socket.on('error', reject);
            socket.on('timeout', () => {
                socket.destroy();
                reject(new Error('timeout'));
            });
        });
        return true;
    } catch (_err) {
        return false;
    }
}

/**
 * Start LM Studio server using CLI if configured.
 */
async function startLMStudioServer() {
    const cfg = getLMStudioConfig();
    if (await isLMStudioRunning(cfg.url)) {
        console.log('[LM Studio] Server already running.');
        return true;
    }

    if (!cfg.auto_start) {
        console.log('[LM Studio] Auto-start disabled; please start server manually.');
        return false;
    }

    const cliPath = getLMStudioCLIPath();
    const args = ['server', 'start', '--port', (cfg.server_port || 1234).toString()];

    return new Promise((resolve, reject) => {
        console.log(`[LM Studio] Starting server on port ${cfg.server_port || 1234}...`);
        const proc = spawn(cliPath, args, { stdio: 'inherit', shell: true });

        proc.on('error', (err) => {
            console.error('[LM Studio] Failed to start server:', err.message);
            reject(err);
        });

        setTimeout(async () => {
            if (await isLMStudioRunning(cfg.url)) {
                console.log('[LM Studio] Server started.');
                resolve(true);
            } else {
                console.warn('[LM Studio] Server not reachable after start attempt.');
                resolve(false);
            }
        }, 3000);
    });
}

// Model loading skipped by request: assume models are already loaded in LM Studio.

/**
 * Initialize LM Studio: start server and load all configured models.
 */
async function initializeLMStudio() {
    const cfg = getLMStudioConfig();

    if (cfg.auto_start) {
        await startLMStudioServer();
    } else if (!(await isLMStudioRunning(cfg.url))) {
        throw new Error('LM Studio server not running; enable auto_start or start manually.');
    }

    // Skip pre-loading; assume models are already loaded
    console.log('[LM Studio] Initialization complete (startup load skipped).');
}

module.exports = {
    getLMStudioCLIPath,
    isLMStudioRunning,
    startLMStudioServer,
    initializeLMStudio,
};

