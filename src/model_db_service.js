#!/usr/bin/env node

/**
 * Model Database Service
 * 
 * Manages the models.json database with:
 * - Preset loading and management
 * - LLM-based model discovery and analysis
 * - Active model tracking
 * - Dynamic re-ranking based on performance
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { exec, spawn } = require('child_process');
const { promisify } = require('util');
const { getLMStudioCLIPath } = require('./lmstudio_manager.js');

const execAsync = promisify(exec);

const MODELS_DB_PATH = path.join(__dirname, '../data/models.json');
const LM_STUDIO_URL = 'http://localhost:1234';

let modelsCache = null;

// Track active downloads
const activeDownloads = new Map();

/**
 * Load the models database from disk
 */
function loadModelDatabase() {
    if (modelsCache) return modelsCache;
    
    if (!fs.existsSync(MODELS_DB_PATH)) {
        console.warn('[ModelDB] models.json not found, creating default...');
        const defaultDb = createDefaultDatabase();
        saveModelDatabase(defaultDb);
        return defaultDb;
    }
    
    try {
        const raw = fs.readFileSync(MODELS_DB_PATH, 'utf8');
        modelsCache = JSON.parse(raw);
        return modelsCache;
    } catch (error) {
        console.error('[ModelDB] Failed to load models.json:', error.message);
        throw error;
    }
}

/**
 * Save the models database to disk
 */
function saveModelDatabase(db) {
    try {
        db.lastUpdated = new Date().toISOString();
        fs.writeFileSync(MODELS_DB_PATH, JSON.stringify(db, null, 2));
        modelsCache = db;
        console.log('[ModelDB] Database saved successfully');
        return db;
    } catch (error) {
        console.error('[ModelDB] Failed to save models.json:', error.message);
        throw error;
    }
}

/**
 * Invalidate the cache to force reload
 */
function invalidateCache() {
    modelsCache = null;
}

/**
 * Get all presets
 */
function getPresets() {
    const db = loadModelDatabase();
    return db.presets || {};
}

/**
 * Get a specific preset by quality tier
 */
function getPreset(quality) {
    const presets = getPresets();
    return presets[quality] || null;
}

/**
 * Get model spec by ID
 */
function getModelSpec(modelId) {
    const db = loadModelDatabase();
    return db.modelSpecs?.[modelId] || null;
}

/**
 * Get all model specs
 */
function getAllModelSpecs() {
    const db = loadModelDatabase();
    return db.modelSpecs || {};
}

/**
 * Get models by type (embedder, summarizer, main)
 */
function getModelsByType(type) {
    const db = loadModelDatabase();
    const specs = db.modelSpecs || {};
    return Object.values(specs).filter(spec => spec.type === type);
}

/**
 * Get the last active model
 */
function getLastActiveModel() {
    const db = loadModelDatabase();
    return db.lastActiveModel || null;
}

/**
 * Set the currently active main model
 */
function setActiveModel(modelId) {
    const db = loadModelDatabase();
    db.lastActiveModel = modelId;
    saveModelDatabase(db);
    console.log(`[ModelDB] Active model set to: ${modelId}`);
    return db.lastActiveModel;
}

/**
 * Get suggested models pending approval
 */
function getSuggestedModels() {
    const db = loadModelDatabase();
    return db.suggestedModels || [];
}

/**
 * Add a suggested model
 */
function addSuggestedModel(modelSpec) {
    const db = loadModelDatabase();
    if (!db.suggestedModels) {
        db.suggestedModels = [];
    }
    
    // Check if already exists
    const exists = db.suggestedModels.some(m => m.id === modelSpec.id);
    if (!exists) {
        db.suggestedModels.push({
            ...modelSpec,
            suggestedAt: new Date().toISOString(),
            status: 'pending'
        });
        saveModelDatabase(db);
        console.log(`[ModelDB] Suggested model added: ${modelSpec.id}`);
    }
    
    return db.suggestedModels;
}

/**
 * Approve a suggested model and add it to a preset tier
 */
function approveModel(modelId, quality) {
    const db = loadModelDatabase();
    
    // Find the suggested model
    const suggestedIndex = (db.suggestedModels || []).findIndex(m => m.id === modelId);
    if (suggestedIndex === -1) {
        throw new Error(`Suggested model not found: ${modelId}`);
    }
    
    const modelSpec = db.suggestedModels[suggestedIndex];
    
    // Add to modelSpecs if not already there
    if (!db.modelSpecs[modelId]) {
        db.modelSpecs[modelId] = {
            ...modelSpec,
            status: undefined,
            suggestedAt: undefined
        };
    }
    
    // Add to the preset's mainOptions if it's a main model
    if (modelSpec.type === 'main' && db.presets[quality]) {
        if (!db.presets[quality].mainOptions.includes(modelId)) {
            db.presets[quality].mainOptions.push(modelId);
        }
    }
    
    // Remove from suggested
    db.suggestedModels.splice(suggestedIndex, 1);
    
    saveModelDatabase(db);
    console.log(`[ModelDB] Model approved: ${modelId} for ${quality} tier`);
    
    return db.presets[quality];
}

/**
 * Dismiss a suggested model
 */
function dismissSuggestedModel(modelId) {
    const db = loadModelDatabase();
    
    const suggestedIndex = (db.suggestedModels || []).findIndex(m => m.id === modelId);
    if (suggestedIndex !== -1) {
        db.suggestedModels.splice(suggestedIndex, 1);
        saveModelDatabase(db);
        console.log(`[ModelDB] Suggested model dismissed: ${modelId}`);
    }
    
    return db.suggestedModels;
}

/**
 * Query LM Studio for available models
 */
async function discoverLMStudioModels() {
    try {
        const response = await axios.get(`${LM_STUDIO_URL}/api/v0/models`, {
            timeout: 10000
        });
        
        const models = response.data?.data || response.data || [];
        console.log(`[ModelDB] Discovered ${models.length} models from LM Studio`);
        
        return models;
    } catch (error) {
        console.error('[ModelDB] Failed to query LM Studio:', error.message);
        return [];
    }
}

/**
 * Analyze a model using the main LLM
 */
async function analyzeModelWithLLM(modelInfo, generateCompletion) {
    const prompt = `Analyze this AI model and provide a JSON specification:

Model ID: ${modelInfo.id || modelInfo.path || 'unknown'}
Model Path: ${modelInfo.path || 'unknown'}
Architecture: ${modelInfo.architecture || 'unknown'}
Size: ${modelInfo.size_bytes ? Math.round(modelInfo.size_bytes / 1024 / 1024 / 1024 * 10) / 10 + 'GB' : 'unknown'}
Context Length: ${modelInfo.context_length || 'unknown'}

Based on this information, provide a JSON object with these fields:
- name: Human-readable name
- author: Likely author/organization
- type: "main" (since we're looking for main models)
- description: Brief description of capabilities
- suggestedTier: "high", "medium", or "low" based on size/capabilities
- capabilities: Array of capability strings
- performance: { speed, reasoning, coding, memory } with values "Excellent", "Good", "Fair", or "Basic"

Respond ONLY with valid JSON, no explanation.`;

    try {
        const response = await generateCompletion({
            prompt,
            systemPrompt: 'You are a model analyzer. Respond only with valid JSON.',
            temperature: 0.1
        });
        
        const content = response?.choices?.[0]?.message?.content || '';
        
        // Extract JSON from response
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            return JSON.parse(jsonMatch[0]);
        }
        
        throw new Error('No valid JSON in response');
    } catch (error) {
        console.error('[ModelDB] LLM analysis failed:', error.message);
        
        // Return a basic spec based on available info
        return {
            name: modelInfo.id || modelInfo.path?.split('/').pop() || 'Unknown Model',
            author: 'Unknown',
            type: 'main',
            description: 'Discovered model - details pending analysis',
            suggestedTier: 'medium',
            capabilities: ['General'],
            performance: {
                speed: 'Fair',
                reasoning: 'Fair',
                coding: 'Fair',
                memory: 'Fair'
            }
        };
    }
}

/**
 * Discover new models from LM Studio and analyze them
 */
async function discoverAndAnalyzeModels(generateCompletion) {
    const db = loadModelDatabase();
    const existingIds = new Set(Object.keys(db.modelSpecs || {}));
    
    // Get models from LM Studio
    const lmStudioModels = await discoverLMStudioModels();
    
    const newModels = [];
    
    for (const model of lmStudioModels) {
        const modelId = model.id || model.path;
        
        // Skip if already known
        if (existingIds.has(modelId)) {
            continue;
        }
        
        console.log(`[ModelDB] Analyzing new model: ${modelId}`);
        
        // Analyze with LLM if available
        let analysis = null;
        if (generateCompletion) {
            analysis = await analyzeModelWithLLM(model, generateCompletion);
        } else {
            // Basic analysis without LLM
            analysis = {
                name: modelId.split('/').pop() || modelId,
                author: 'Unknown',
                type: 'main',
                description: 'Discovered model',
                suggestedTier: 'medium',
                capabilities: ['General'],
                performance: {
                    speed: 'Fair',
                    reasoning: 'Fair',
                    coding: 'Fair',
                    memory: 'Fair'
                }
            };
        }
        
        const modelSpec = {
            id: modelId,
            name: analysis.name,
            author: analysis.author,
            type: analysis.type || 'main',
            engine: 'lmstudio',
            size: model.size_bytes ? `~${Math.round(model.size_bytes / 1024 / 1024 / 1024 * 10) / 10}GB` : 'Unknown',
            contextLength: model.context_length || 4096,
            description: analysis.description,
            suggestedTier: analysis.suggestedTier,
            requirements: {
                vram: 'Unknown',
                recommendedHardware: 'Unknown'
            },
            performance: analysis.performance,
            capabilities: analysis.capabilities,
            tags: ['discovered', analysis.suggestedTier]
        };
        
        addSuggestedModel(modelSpec);
        newModels.push(modelSpec);
    }
    
    // Update last LLM check timestamp
    db.lastLLMCheck = new Date().toISOString();
    saveModelDatabase(db);
    
    console.log(`[ModelDB] Discovery complete. ${newModels.length} new models found.`);
    
    return newModels;
}

/**
 * Re-rank models in a preset based on performance metrics
 */
function reRankPresetModels(quality, performanceData) {
    const db = loadModelDatabase();
    const preset = db.presets[quality];
    
    if (!preset || !preset.mainOptions) {
        throw new Error(`Invalid quality tier: ${quality}`);
    }
    
    // Sort mainOptions based on performance data if provided
    if (performanceData && Object.keys(performanceData).length > 0) {
        preset.mainOptions.sort((a, b) => {
            const scoreA = performanceData[a]?.score || 0;
            const scoreB = performanceData[b]?.score || 0;
            return scoreB - scoreA; // Higher score first
        });
    }
    
    saveModelDatabase(db);
    console.log(`[ModelDB] Re-ranked ${quality} tier models`);
    
    return preset.mainOptions;
}

/**
 * Create a default database structure
 */
function createDefaultDatabase() {
    return {
        version: '1.0.0',
        lastUpdated: new Date().toISOString(),
        lastLLMCheck: null,
        lastActiveModel: null,
        presets: {
            high: {
                name: 'High Quality',
                description: 'Best accuracy, needs RTX 3080+ / 12GB+ VRAM',
                embedding: 'Xenova/all-MiniLM-L6-v2',
                summarizer: 'lmstudio-community/Phi-3-mini-4k-instruct-GGUF',
                mainOptions: []
            },
            medium: {
                name: 'Balanced',
                description: 'Good quality + speed, RTX 3060+ / 8GB VRAM',
                embedding: 'Xenova/all-MiniLM-L6-v2',
                summarizer: 'lmstudio-community/Qwen2.5-1.5B-Instruct-GGUF',
                mainOptions: []
            },
            low: {
                name: 'Fast & Lightweight',
                description: 'Works on 4GB VRAM, fastest inference',
                embedding: 'Xenova/all-MiniLM-L6-v2',
                summarizer: 'lmstudio-community/Qwen2.5-1.5B-Instruct-GGUF',
                mainOptions: [
                    'lmstudio-community/Llama-3.2-1B-Instruct-GGUF',
                    'lmstudio-community/Llama-3.2-3B-Instruct-GGUF',
                    'lmstudio-community/Qwen2.5-1.5B-Instruct-GGUF',
                    'lmstudio-community/Qwen2.5-3B-Instruct-GGUF',
                    'microsoft/Phi-2-GGUF',
                    'microsoft/Phi-3-mini-4k-instruct-GGUF'
                ]
            }
        },
        modelSpecs: {},
        suggestedModels: []
    };
}

// =============================================================================
// LM Studio CLI Integration
// =============================================================================

/**
 * Get list of downloaded models from LM Studio using CLI
 * @returns {Promise<Array>} List of downloaded models
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
                console.error('[ModelDB] All model discovery methods failed');
                return [];
            }
        }
    }
}

/**
 * Download a model using LM Studio CLI
 * @param {string} modelId - The model ID to download
 * @returns {Promise<{success: boolean, message: string}>}
 */
/**
 * Start downloading a model via LM Studio CLI
 * Uses spawn to run in background and returns immediately
 * @param {string} modelId - Model ID to download
 * @returns {{success: boolean, message: string, status?: string}}
 */
/**
 * Available quantization options for GGUF models
 */
const QUANT_OPTIONS = [
    { id: 'q4_k_m', name: 'Q4_K_M', description: 'Balanced (recommended)', sizeMultiplier: 0.5 },
    { id: 'q5_k_m', name: 'Q5_K_M', description: 'Better quality', sizeMultiplier: 0.6 },
    { id: 'q8_0', name: 'Q8_0', description: 'High quality', sizeMultiplier: 0.9 },
    { id: 'q3_k_m', name: 'Q3_K_M', description: 'Compact', sizeMultiplier: 0.4 },
    { id: 'q2_k', name: 'Q2_K', description: 'Smallest', sizeMultiplier: 0.3 },
];

const DEFAULT_QUANT = 'q4_k_m';

/**
 * Get available quantization options
 */
function getQuantOptions() {
    return QUANT_OPTIONS;
}

/**
 * Extract a clean model name for LM Studio CLI from a full model ID
 * LM Studio CLI expects simple search terms like: "phi-2", "llama-3.1-8b", "qwen2.5-coder-7b"
 * 
 * Examples:
 * - "lmstudio-community/Phi-2-GGUF" -> "phi-2"
 * - "lmstudio-community/Qwen2.5-Coder-7B-Instruct-GGUF" -> "qwen2.5-coder-7b-instruct"
 * - "bartowski/Llama-3.2-1B-Instruct-GGUF" -> "llama-3.2-1b-instruct"
 * 
 * @param {string} modelId - Full model ID
 * @param {string} [quantization] - Optional quantization (e.g., 'q4_k_m')
 * @returns {string} CLI-ready model name with optional @quant suffix
 */
function extractModelNameForCLI(modelId, quantization = null) {
    if (!modelId) return '';
    
    // Remove organization prefix (e.g., "lmstudio-community/")
    let name = modelId.includes('/') ? modelId.split('/').pop() : modelId;
    
    // Remove existing quantization markers (e.g., @q4_k_m)
    name = name.replace(/@.*$/, '');
    
    // Remove -GGUF suffix
    name = name.replace(/-GGUF$/i, '');
    
    // Convert to lowercase for CLI search
    name = name.toLowerCase();
    
    // Append quantization if provided
    if (quantization) {
        name = `${name}@${quantization}`;
    }
    
    return name;
}

/**
 * Start downloading a model via LM Studio CLI
 * @param {string} modelId - Model ID to download
 * @param {string} [quantization] - Optional quantization (e.g., 'q4_k_m'). Defaults to 'q4_k_m'
 * @returns {{success: boolean, message: string, status?: string}}
 */
async function downloadModel(modelId, quantization = DEFAULT_QUANT) {
    if (activeDownloads.has(modelId)) {
        return { success: false, message: 'Download already in progress', status: 'downloading' };
    }

    // Extract clean model name for CLI with quantization
    const cliModelName = extractModelNameForCLI(modelId, quantization);
    console.log(`[ModelDB] Starting download for: ${modelId}`);
    console.log(`[ModelDB] CLI command: lms get "${cliModelName}" -y`);
    
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

    // Use spawn with -y flag for non-interactive mode
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

/**
 * Get download status for a model
 * @param {string} modelId - The model ID
 * @returns {{downloading: boolean, status: string|null}}
 */
function getDownloadStatus(modelId) {
    const download = activeDownloads.get(modelId);
    return {
        downloading: !!download,
        status: download?.status || null,
        startedAt: download?.startedAt || null
    };
}

/**
 * Get all active downloads
 * @returns {Object} Map of active downloads
 */
function getActiveDownloads() {
    const downloads = {};
    for (const [id, status] of activeDownloads.entries()) {
        downloads[id] = status;
    }
    return downloads;
}

/**
 * Check if a model is available by fuzzy matching against downloaded models
 * @param {string} modelId - The model ID to check
 * @param {Array} downloadedModels - List of downloaded models
 * @returns {boolean} - Whether the model is available
 */
function isModelDownloaded(modelId, downloadedModels) {
    if (!modelId) return false;
    
    const normalizedTarget = normalizeModelIdForMatching(modelId);
    const targetTokens = extractModelTokens(modelId);
    
    for (const model of downloadedModels) {
        const downloadedId = model.id || model.path || '';
        const normalizedDownloaded = normalizeModelIdForMatching(downloadedId);
        
        // Exact normalized match
        if (normalizedTarget === normalizedDownloaded) {
            return true;
        }
        
        // Check if one contains the other (for partial matches)
        if (normalizedDownloaded.includes(normalizedTarget) || normalizedTarget.includes(normalizedDownloaded)) {
            return true;
        }
        
        // Token-based fuzzy matching with higher threshold
        const score = tokenOverlapScore(modelId, downloadedId);
        if (score >= 0.6) {  // At least 60% token overlap
            return true;
        }
    }
    
    return false;
}

/**
 * Validate presets against downloaded models
 * Updates models.json with availability status
 * @returns {Promise<{available: string[], missing: string[]}>}
 */
async function validatePresets() {
    console.log('[ModelDB] Validating presets against downloaded models...');
    
    const downloadedModels = await getDownloadedModels();
    console.log(`[ModelDB] Found ${downloadedModels.length} downloaded models via CLI`);
    
    const db = loadModelDatabase();
    const available = [];
    const missing = [];
    
    // Check all models in modelSpecs using fuzzy matching
    for (const [modelId, spec] of Object.entries(db.modelSpecs || {})) {
        const isAvailable = isModelDownloaded(modelId, downloadedModels);
        spec.available = isAvailable;
        
        if (isAvailable) {
            available.push(modelId);
        } else {
            missing.push(modelId);
        }
    }
    
    // Also check preset models not in modelSpecs
    for (const [tier, preset] of Object.entries(db.presets || {})) {
        // Check ragSummarizer
        if (preset.ragSummarizer && !db.modelSpecs[preset.ragSummarizer]) {
            const namePart = preset.ragSummarizer.split('/').pop()?.toLowerCase() || '';
            const isAvailable = isModelDownloaded(preset.ragSummarizer, downloadedModels);
            
            db.modelSpecs[preset.ragSummarizer] = {
                id: preset.ragSummarizer,
                name: namePart,
                type: 'summarizer',
                engine: 'lmstudio',
                available: isAvailable
            };
            
            if (isAvailable) available.push(preset.ragSummarizer);
            else missing.push(preset.ragSummarizer);
        }
        
        // Check rollingSummarizer
        if (preset.rollingSummarizer && !db.modelSpecs[preset.rollingSummarizer]) {
            const namePart = preset.rollingSummarizer.split('/').pop()?.toLowerCase() || '';
            const isAvailable = isModelDownloaded(preset.rollingSummarizer, downloadedModels);
            
            db.modelSpecs[preset.rollingSummarizer] = {
                id: preset.rollingSummarizer,
                name: namePart,
                type: 'summarizer',
                engine: 'lmstudio',
                available: isAvailable
            };
            
            if (isAvailable) available.push(preset.rollingSummarizer);
            else missing.push(preset.rollingSummarizer);
        }
        
        // Check mainOptions
        for (const mainId of (preset.mainOptions || [])) {
            if (!db.modelSpecs[mainId]) {
                const namePart = mainId.split('/').pop()?.toLowerCase() || '';
                const isAvailable = isModelDownloaded(mainId, downloadedModels);
                
                db.modelSpecs[mainId] = {
                    id: mainId,
                    name: namePart,
                    type: 'main',
                    engine: 'lmstudio',
                    available: isAvailable
                };
                
                if (isAvailable) available.push(mainId);
                else missing.push(mainId);
            }
        }
    }
    
    db.lastValidation = new Date().toISOString();
    saveModelDatabase(db);
    
    console.log(`[ModelDB] Validation complete: ${available.length} available, ${missing.length} missing`);
    
    return { available, missing, downloadedModels };
}

/**
 * Initialize the model database at server startup
 * Validates presets and discovers new models
 * @returns {Promise<{available: string[], missing: string[], discovered: number}>}
 */
async function initializeModelDatabase() {
    console.log('[ModelDB] Initializing model database...');
    
    try {
        // Load or create database
        loadModelDatabase();
        
        // Validate presets against downloaded models
        const { available, missing, downloadedModels } = await validatePresets();
        
        // Discover new models not in our database
        const db = loadModelDatabase();
        const existingIds = new Set(Object.keys(db.modelSpecs || {}));
        let discovered = 0;
        
        for (const model of downloadedModels) {
            const modelId = model.id || model.path;
            if (!modelId) continue;
            
            // Check if this model is not in our specs
            const idLower = modelId.toLowerCase();
            const isKnown = Array.from(existingIds).some(id => 
                id.toLowerCase() === idLower || 
                id.toLowerCase().includes(modelId.split('/').pop()?.toLowerCase() || '')
            );
            
            if (!isKnown) {
                // Add as a discovered model
                const namePart = modelId.split('/').pop() || modelId;
                db.modelSpecs[modelId] = {
                    id: modelId,
                    name: namePart.replace(/-GGUF$/i, '').replace(/@.*$/, ''),
                    author: modelId.split('/')[0] || 'Unknown',
                    type: 'main',
                    engine: 'lmstudio',
                    available: true,
                    size: model.size_bytes ? `~${Math.round(model.size_bytes / 1024 / 1024 / 1024 * 10) / 10}GB` : 'Unknown',
                    contextLength: model.context_length || 4096,
                    description: 'Discovered model',
                    requirements: { vram: 'Unknown', recommendedHardware: 'Unknown' },
                    performance: { speed: 'Unknown', reasoning: 'Unknown', coding: 'Unknown', memory: 'Unknown' },
                    capabilities: ['General'],
                    tags: ['discovered']
                };
                discovered++;
            }
        }
        
        if (discovered > 0) {
            saveModelDatabase(db);
            console.log(`[ModelDB] Discovered ${discovered} new models`);
        }
        
        console.log('[ModelDB] Initialization complete');
        
        return { available, missing, discovered };
    } catch (error) {
        console.error('[ModelDB] Initialization failed:', error.message);
        return { available: [], missing: [], discovered: 0 };
    }
}

/**
 * Get model availability status for all preset models
 * @returns {Object} Map of modelId -> availability status
 */
function getModelAvailability() {
    const db = loadModelDatabase();
    const availability = {};

    for (const [modelId, spec] of Object.entries(db.modelSpecs || {})) {
        availability[modelId] = {
            available: spec.available ?? false,
            downloading: getDownloadStatus(modelId).downloading
        };
    }

    return availability;
}

/**
 * Check if a specific model is available (downloaded)
 * @param {string} modelId - Model ID to check
 * @returns {boolean}
 */
function isModelAvailable(modelId) {
    if (!modelId) return false;
    const db = loadModelDatabase();
    const spec = db.modelSpecs?.[modelId];
    return spec?.available ?? false;
}

/**
 * Normalize a model ID for matching
 * Converts "lmstudio-community/Qwen2.5-3B-Instruct-GGUF" -> "qwen2.5-3b-instruct"
 */
function normalizeModelIdForMatching(id) {
    if (!id) return '';
    let s = String(id).trim().toLowerCase();
    // Remove path prefixes (lmstudio-community/, etc.) but keep the last segment
    const parts = s.split('/');
    s = parts[parts.length - 1];
    // Also check if it's a full GGUF path like "Mungert/model/file.gguf"
    if (s.endsWith('.gguf')) {
        s = s.replace(/\.gguf$/i, '');
    }
    // Remove common suffixes
    s = s.replace(/-gguf$/i, '');
    s = s.replace(/-q\d.*$/i, '');
    s = s.replace(/@.*$/i, '');
    // Remove quantization markers
    s = s.replace(/_q\d+_\w+$/i, '');
    return s;
}

/**
 * Extract key tokens from a model name for fuzzy matching
 */
function extractModelTokens(name) {
    if (!name) return [];
    const normalized = normalizeModelIdForMatching(name);
    // Split on common separators and filter out very common suffixes that don't help identify
    return normalized.split(/[-_.]/)
        .filter(t => t.length > 0)
        // Keep important tokens like model sizes (1b, 3b, 7b, etc.) and types (instruct, chat)
        .filter(t => !['hf', 'gguf', 'v1', 'v2', 'v3', 'v0', 'the'].includes(t));
}

/**
 * Calculate token overlap score between two model names
 */
function tokenOverlapScore(name1, name2) {
    const tokens1 = new Set(extractModelTokens(name1));
    const tokens2 = new Set(extractModelTokens(name2));
    if (tokens1.size === 0 || tokens2.size === 0) return 0;
    
    let overlap = 0;
    for (const t of tokens1) {
        if (tokens2.has(t)) overlap++;
    }
    // Return Jaccard-like similarity
    return overlap / Math.max(tokens1.size, tokens2.size);
}

/**
 * Find the actual LM Studio model ID that best matches a preset model ID
 * @param {string} presetModelId - The preset model ID (e.g., "lmstudio-community/Qwen2.5-3B-Instruct-GGUF")
 * @returns {Promise<string|null>} - The actual LM Studio model ID or null if not found
 */
async function findLMStudioModelId(presetModelId) {
    if (!presetModelId) return null;
    
    try {
        // Get the list of downloaded models from LM Studio
        const downloadedModels = await getDownloadedModels();
        
        if (!downloadedModels || downloadedModels.length === 0) {
            console.warn('[ModelDB] No downloaded models found');
            return null;
        }
        
        // Normalize the preset ID for matching
        const normalizedPreset = normalizeModelIdForMatching(presetModelId);
        console.log(`[ModelDB] Looking for match: "${presetModelId}" -> normalized: "${normalizedPreset}"`);
        
        // Try exact match first (for when user selects from UI with actual ID)
        for (const model of downloadedModels) {
            const modelId = model.id || model.path || model.name;
            if (modelId === presetModelId) {
                console.log(`[ModelDB] Exact match found: ${modelId}`);
                return modelId;
            }
        }
        
        // Try normalized exact matching
        for (const model of downloadedModels) {
            const modelId = model.id || model.path || model.name;
            const normalizedModel = normalizeModelIdForMatching(modelId);
            
            if (normalizedModel === normalizedPreset) {
                console.log(`[ModelDB] Normalized exact match: ${modelId}`);
                return modelId;
            }
        }
        
        // Try substring matching with scoring
        let bestMatch = null;
        let bestScore = 0;
        
        for (const model of downloadedModels) {
            const modelId = model.id || model.path || model.name;
            const normalizedModel = normalizeModelIdForMatching(modelId);
            
            // Check if one contains the other (partial match)
            if (normalizedModel.includes(normalizedPreset) || normalizedPreset.includes(normalizedModel)) {
                const score = Math.min(normalizedModel.length, normalizedPreset.length) / 
                             Math.max(normalizedModel.length, normalizedPreset.length);
                if (score > bestScore) {
                    bestScore = score;
                    bestMatch = modelId;
                }
            }
        }
        
        if (bestMatch && bestScore > 0.5) {
            console.log(`[ModelDB] Best partial match: ${bestMatch} (score: ${bestScore.toFixed(2)})`);
            return bestMatch;
        }
        
        // Fallback: Try token-based fuzzy matching
        for (const model of downloadedModels) {
            const modelId = model.id || model.path || model.name;
            const score = tokenOverlapScore(presetModelId, modelId);
            if (score > bestScore && score > 0.6) {
                bestScore = score;
                bestMatch = modelId;
            }
        }
        
        if (bestMatch) {
            console.log(`[ModelDB] Best token match: ${bestMatch} (score: ${bestScore.toFixed(2)})`);
            return bestMatch;
        }
        
        console.warn(`[ModelDB] No match found for: ${presetModelId}`);
        return null;
    } catch (error) {
        console.error(`[ModelDB] Error finding LM Studio model ID:`, error.message);
        return null;
    }
}

module.exports = {
    loadModelDatabase,
    saveModelDatabase,
    invalidateCache,
    getPresets,
    getPreset,
    getModelSpec,
    getAllModelSpecs,
    getModelsByType,
    getLastActiveModel,
    setActiveModel,
    getSuggestedModels,
    addSuggestedModel,
    approveModel,
    dismissSuggestedModel,
    discoverLMStudioModels,
    analyzeModelWithLLM,
    discoverAndAnalyzeModels,
    reRankPresetModels,
    // CLI integration
    getDownloadedModels,
    downloadModel,
    getDownloadStatus,
    getActiveDownloads,
    getQuantOptions,
    extractModelNameForCLI,
    // Model ID matching
    findLMStudioModelId,
    normalizeModelIdForMatching,
    // Startup & validation
    validatePresets,
    initializeModelDatabase,
    getModelAvailability,
    isModelAvailable
};
