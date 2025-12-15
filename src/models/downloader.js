/**
 * Model Downloader
 * Handles downloading models via LM Studio CLI
 */

const { exec, spawn } = require('child_process');
const { promisify } = require('util');
const axios = require('axios');
const { getLMStudioCLIPath } = require('../lmstudio_manager.js');
const { loadModelDatabase, saveModelDatabase } = require('./database.js');

const execAsync = promisify(exec);
const LM_STUDIO_URL = 'http://localhost:1234';

// Track active downloads
const activeDownloads = new Map();

/**
 * Get downloaded models from LM Studio
 * @returns {Promise<Array>} Downloaded models
 */
async function getDownloadedModels() {
    try {
        // Try lms ls --json first
        const { stdout } = await execAsync(`"${getLMStudioCLIPath()}" ls --json`, {
            timeout: 30000,
            encoding: 'utf8'
        });

        const models = JSON.parse(stdout);
        console.log(`[ModelDB] Found ${models.length} downloaded models via CLI`);
        return models;
    } catch (error) {
        // Fallback: try without --json and parse text output
        try {
            const { stdout } = await execAsync(`"${getLMStudioCLIPath()}" ls`, {
                timeout: 30000,
                encoding: 'utf8'
            });

            // Parse text output properly - skip header lines
            const lines = stdout.trim().split('\n').filter(line => line.trim());
            const models = [];

            for (const line of lines) {
                const trimmed = line.trim();

                // Skip summary/header lines
                if (trimmed.startsWith('You have') ||
                    trimmed.startsWith('LLM') ||
                    trimmed.startsWith('EMBEDDING') ||
                    trimmed.includes('taking up') ||
                    trimmed.includes('PARAMS') ||
                    trimmed.length < 5) {
                    continue;
                }

                // Extract model name (first column, before the multi-space separator)
                const modelName = trimmed.split(/\s{2,}/)[0].trim();

                if (modelName && modelName.length > 0) {
                    models.push({
                        id: modelName,
                        path: modelName,
                        available: true
                    });
                }
            }

            console.log(`[ModelDB] Found ${models.length} downloaded models via CLI (text parse)`);
            return models;
        } catch (fallbackError) {
            console.warn('[ModelDB] LMS CLI not available:', fallbackError.message);

            // Ultimate fallback: use API if CLI fails
            try {
                const response = await axios.get(`${LM_STUDIO_URL}/api/v0/models`, {
                    timeout: 10000
                });
                const apiModels = response.data?.data || response.data || [];
                console.log(`[ModelDB] Found ${apiModels.length} models via API fallback`);
                return apiModels.map(m => ({ ...m, available: true }));
            } catch (apiError) {
                console.error('[ModelDB] All model listing methods failed:', apiError.message);
                return [];
            }
        }
    }
}

/**
 * Get download status for a model
 * @param {string} modelId - Model ID
 * @returns {Object} Download status
 */
function getDownloadStatus(modelId) {
    const download = activeDownloads.get(modelId);
    return {
        downloading: !!download,
        status: download?.status || null,
        progress: download?.progress || 0,
        startedAt: download?.startedAt || null
    };
}

/**
 * Get all active downloads
 * @returns {Object} Active downloads map
 */
function getActiveDownloads() {
    const result = {};
    for (const [id, data] of activeDownloads.entries()) {
        result[id] = data;
    }
    return result;
}

/**
 * Extract a clean model name for LM Studio CLI from a full model ID
 * LM Studio CLI expects simple search terms like: "phi-2", "llama-3.1-8b", "qwen2.5-coder-7b"
 * 
 * Examples:
 * - "lmstudio-community/Phi-2-GGUF" -> "phi-2"
 * - "lmstudio-community/Qwen2.5-Coder-7B-Instruct-GGUF" -> "qwen2.5-coder-7b-instruct"
 * - "bartowski/Llama-3.2-1B-Instruct-GGUF" -> "llama-3.2-1b-instruct"
 * @param {string} modelId - Full model ID
 * @returns {string} Clean model name for CLI
 */
function extractModelNameForCLI(modelId) {
    if (!modelId) return '';
    
    // Remove organization prefix (e.g., "lmstudio-community/")
    let name = modelId.includes('/') ? modelId.split('/').pop() : modelId;
    
    // Remove quantization markers (e.g., @q4_k_m)
    name = name.replace(/@.*$/, '');
    
    // Remove -GGUF suffix
    name = name.replace(/-GGUF$/i, '');
    
    // Convert to lowercase for CLI search
    name = name.toLowerCase();
    
    return name;
}

/**
 * Start downloading a model via LM Studio CLI
 * Uses spawn to run in background and returns immediately
 * @param {string} modelId - Model ID to download
 * @returns {{success: boolean, message: string, status?: string}}
 */
async function downloadModel(modelId) {
    if (activeDownloads.has(modelId)) {
        return { success: false, message: 'Download already in progress', status: 'downloading' };
    }

    // Extract clean model name for CLI
    const cliModelName = extractModelNameForCLI(modelId);
    console.log(`[ModelDB] Starting download for: ${modelId} (CLI name: ${cliModelName})`);
    
    activeDownloads.set(modelId, { 
        status: 'downloading', 
        startedAt: Date.now(), 
        progress: 0, 
        cliName: cliModelName,
        modelId: modelId
    });

    // Update model spec with download status
    const db = loadModelDatabase();
    if (db.modelSpecs[modelId]) {
        db.modelSpecs[modelId].downloadProgress = 'starting';
        saveModelDatabase(db);
    }

    const cliPath = getLMStudioCLIPath();
    
    // Use spawn with -y flag for non-interactive mode (auto-confirms and selects recommended quantization)
    const downloadProcess = spawn(cliPath, ['get', cliModelName, '-y'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
        shell: true
    });

    let output = '';
    
    downloadProcess.stdout.on('data', (data) => {
        const text = data.toString();
        output += text;
        
        // Parse progress from LM Studio output (e.g., "99.13% |   2.37 GB / 2.39 GB")
        const progressMatch = text.match(/(\d+(?:\.\d+)?)\s*%/);
        if (progressMatch) {
            const progress = Math.round(parseFloat(progressMatch[1]));
            const currentDownload = activeDownloads.get(modelId) || {};
            activeDownloads.set(modelId, { 
                ...currentDownload,
                status: 'downloading', 
                progress,
                lastUpdate: Date.now()
            });
            
            // Only log every 10% to reduce noise
            if (progress % 10 === 0 || progress >= 99) {
                console.log(`[ModelDB Download] ${modelId}: ${progress}%`);
            }
        }
        
        // Check for completion message
        if (text.includes('Download completed') || text.includes('Finalizing')) {
            console.log(`[ModelDB Download] ${modelId}: Finalizing...`);
        }
    });

    downloadProcess.stderr.on('data', (data) => {
        const text = data.toString();
        console.log(`[ModelDB Download Error] ${modelId}: ${text.trim()}`);
    });

    downloadProcess.on('close', (code) => {
        activeDownloads.delete(modelId);
        
        const dbUpdated = loadModelDatabase();
        if (code === 0) {
            console.log(`[ModelDB] Download complete for: ${modelId}`);
            if (dbUpdated.modelSpecs[modelId]) {
                dbUpdated.modelSpecs[modelId].available = true;
                dbUpdated.modelSpecs[modelId].downloadProgress = null;
                saveModelDatabase(dbUpdated);
            }
        } else {
            console.error(`[ModelDB] Download failed for ${modelId} with code ${code}`);
            if (dbUpdated.modelSpecs[modelId]) {
                dbUpdated.modelSpecs[modelId].downloadProgress = null;
                saveModelDatabase(dbUpdated);
            }
        }
    });

    downloadProcess.on('error', (error) => {
        console.error(`[ModelDB] Download process error for ${modelId}:`, error.message);
        activeDownloads.delete(modelId);
    });

    // Return immediately - download runs in background
    return { 
        success: true, 
        message: 'Download started', 
        status: 'downloading' 
    };
}

module.exports = {
    getDownloadedModels,
    getDownloadStatus,
    getActiveDownloads,
    downloadModel
};
