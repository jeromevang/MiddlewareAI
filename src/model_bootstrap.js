#!/usr/bin/env node

/**
 * Model Bootstrap Service
 * 
 * Uses a small model (TinyAgent-1.1B) to analyze downloaded models
 * and populate the quality presets in models.json.
 * 
 * The bootstrap model is loaded temporarily and unloaded when done
 * to free VRAM for the user's main model.
 */

const { exec } = require('child_process');
const { promisify } = require('util');
const axios = require('axios');

const execAsync = promisify(exec);

// Bootstrap model configuration
const BOOTSTRAP_MODEL = 'squeeze-ai-lab/TinyAgent-1.1B-GGUF';
const FALLBACK_MODEL = 'Qwen/Qwen2.5-0.5B-Instruct-GGUF';
const LM_STUDIO_URL = 'http://localhost:1234';

// Bootstrap state
let bootstrapState = {
    running: false,
    progress: 0,
    message: '',
    startedAt: null,
    completedAt: null,
    error: null
};

/**
 * Get current bootstrap status
 */
function getBootstrapStatus() {
    return { ...bootstrapState };
}

/**
 * Update bootstrap status
 */
function updateBootstrapStatus(updates) {
    bootstrapState = { ...bootstrapState, ...updates };
    console.log(`[Bootstrap] ${updates.message || bootstrapState.message}`);
}

/**
 * Check if a model is downloaded in LM Studio
 */
async function isModelDownloaded(modelId) {
    try {
        const { stdout } = await execAsync('lms ls', { timeout: 30000 });
        const lines = stdout.toLowerCase();
        const modelName = modelId.split('/').pop()?.toLowerCase() || '';
        return lines.includes(modelName) || lines.includes(modelId.toLowerCase());
    } catch (error) {
        console.warn('[Bootstrap] Could not check downloaded models:', error.message);
        return false;
    }
}

/**
 * Download the bootstrap model if needed
 */
async function downloadBootstrapModel(modelId) {
    updateBootstrapStatus({ message: `Downloading bootstrap model: ${modelId}...`, progress: 10 });
    
    try {
        const { stdout, stderr } = await execAsync(`lms get "${modelId}"`, {
            timeout: 300000 // 5 minutes
        });
        console.log('[Bootstrap] Download output:', stdout || stderr);
        return true;
    } catch (error) {
        console.error('[Bootstrap] Failed to download model:', error.message);
        return false;
    }
}

/**
 * Load the bootstrap model into LM Studio
 */
async function loadBootstrapModel(modelId) {
    updateBootstrapStatus({ message: `Loading bootstrap model...`, progress: 20 });
    
    try {
        const { stdout, stderr } = await execAsync(`lms load "${modelId}"`, {
            timeout: 120000 // 2 minutes
        });
        console.log('[Bootstrap] Load output:', stdout || stderr);
        
        // Wait for model to be ready
        await new Promise(resolve => setTimeout(resolve, 3000));
        return true;
    } catch (error) {
        console.error('[Bootstrap] Failed to load model:', error.message);
        return false;
    }
}

/**
 * Unload the bootstrap model to free VRAM
 */
async function unloadBootstrapModel(modelId) {
    updateBootstrapStatus({ message: `Unloading bootstrap model...`, progress: 90 });
    
    try {
        const { stdout, stderr } = await execAsync(`lms unload "${modelId}"`, {
            timeout: 30000
        });
        console.log('[Bootstrap] Unload output:', stdout || stderr);
        return true;
    } catch (error) {
        console.warn('[Bootstrap] Failed to unload model:', error.message);
        // Not critical - continue
        return false;
    }
}

/**
 * Get list of downloaded models from LM Studio
 */
async function getDownloadedModels() {
    try {
        // Try CLI first
        const { stdout } = await execAsync('lms ls', { timeout: 30000 });
        const lines = stdout.trim().split('\n').filter(line => line.trim());
        
        // Parse the lms ls output properly
        // Skip header lines like "You have X models..." and "LLM  PARAMS  ARCH  SIZE"
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
            
            // Extract model name (first column, before the spaces that separate params)
            // Format: "model-name    7B    Llama    4.08 GB"
            const modelName = trimmed.split(/\s{2,}/)[0].trim();
            
            if (modelName && modelName.length > 0) {
                models.push({
                    id: modelName,
                    path: modelName,
                    name: modelName
                });
            }
        }
        
        return models;
    } catch (error) {
        // Fallback to API
        try {
            const response = await axios.get(`${LM_STUDIO_URL}/api/v0/models`, { timeout: 10000 });
            return response.data?.data || response.data || [];
        } catch (apiError) {
            console.error('[Bootstrap] Failed to get models:', apiError.message);
            return [];
        }
    }
}

/**
 * Analyze a model using the bootstrap LLM
 */
async function analyzeModelWithLLM(modelInfo) {
    const prompt = `Analyze this AI model and categorize it for a coding assistant app.

Model: ${modelInfo.name || modelInfo.id}
Full ID: ${modelInfo.id}

Based on the model name/size, categorize into ONE tier:
- "high": 7B+ params, complex coding tasks, needs 12GB+ VRAM
- "medium": 3-7B params, balanced performance, needs 8GB VRAM  
- "low": <3B params, fast/lightweight, works on 4GB VRAM

Respond with ONLY valid JSON:
{"tier": "high" or "medium" or "low", "confidence": 0.0-1.0, "reason": "brief explanation"}`;

    try {
        const response = await axios.post(`${LM_STUDIO_URL}/v1/chat/completions`, {
            model: 'local-model',
            messages: [
                { role: 'system', content: 'You are a model analyzer. Respond only with valid JSON.' },
                { role: 'user', content: prompt }
            ],
            temperature: 0.1,
            max_tokens: 150
        }, { timeout: 30000 });

        const content = response.data?.choices?.[0]?.message?.content || '';
        
        // Extract JSON from response
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            return JSON.parse(jsonMatch[0]);
        }
        
        throw new Error('No valid JSON in response');
    } catch (error) {
        console.warn('[Bootstrap] LLM analysis failed, using heuristic:', error.message);
        return analyzeModelHeuristic(modelInfo);
    }
}

/**
 * Fallback heuristic-based model categorization
 */
function analyzeModelHeuristic(modelInfo) {
    const name = (modelInfo.name || modelInfo.id || '').toLowerCase();
    
    // Size-based heuristics
    if (name.includes('70b') || name.includes('72b') || name.includes('65b')) {
        return { tier: 'high', confidence: 0.9, reason: 'Very large model (65B+)' };
    }
    if (name.includes('7b') || name.includes('8b') || name.includes('13b')) {
        return { tier: 'high', confidence: 0.8, reason: 'Large model (7B-13B)' };
    }
    if (name.includes('3b') || name.includes('4b') || name.includes('6b')) {
        return { tier: 'medium', confidence: 0.8, reason: 'Medium model (3B-6B)' };
    }
    if (name.includes('1b') || name.includes('2b') || name.includes('0.5b') || name.includes('500m')) {
        return { tier: 'low', confidence: 0.8, reason: 'Small model (<3B)' };
    }
    
    // Name-based heuristics
    if (name.includes('tiny') || name.includes('mini') || name.includes('small')) {
        return { tier: 'low', confidence: 0.7, reason: 'Name suggests small model' };
    }
    if (name.includes('coder') || name.includes('code') || name.includes('deepseek')) {
        return { tier: 'medium', confidence: 0.6, reason: 'Coding model, assuming medium' };
    }
    
    // Default to medium
    return { tier: 'medium', confidence: 0.5, reason: 'Unknown size, defaulting to medium' };
}

/**
 * Update models.json presets with analyzed models
 */
async function updatePresetsWithModels(analyzedModels, modelDbService) {
    updateBootstrapStatus({ message: 'Updating presets...', progress: 80 });
    
    const db = modelDbService.loadModelDatabase();
    
    // Clear existing mainOptions (we'll repopulate)
    const highModels = [];
    const mediumModels = [];
    const lowModels = [];
    
    for (const { model, analysis } of analyzedModels) {
        const modelId = model.id || model.path;
        if (!modelId) continue;
        
        // Add to modelSpecs
        if (!db.modelSpecs[modelId]) {
            db.modelSpecs[modelId] = {
                id: modelId,
                name: model.name || modelId.split('/').pop(),
                author: modelId.split('/')[0] || 'Unknown',
                type: 'main',
                engine: 'lmstudio',
                available: true,
                description: analysis.reason || 'Discovered model',
                requirements: { vram: 'Unknown', recommendedHardware: 'Unknown' },
                performance: { speed: 'Unknown', reasoning: 'Unknown', coding: 'Unknown', memory: 'Unknown' },
                capabilities: ['General'],
                tags: ['discovered', analysis.tier]
            };
        } else {
            db.modelSpecs[modelId].available = true;
        }
        
        // Categorize by tier
        if (analysis.tier === 'high' && analysis.confidence >= 0.5) {
            highModels.push(modelId);
        } else if (analysis.tier === 'medium' && analysis.confidence >= 0.5) {
            mediumModels.push(modelId);
        } else if (analysis.tier === 'low' && analysis.confidence >= 0.5) {
            lowModels.push(modelId);
        } else {
            // Low confidence - add to medium as default
            mediumModels.push(modelId);
        }
    }
    
    // Update presets (keep top 5 per tier, add new ones)
    if (highModels.length > 0) {
        const existing = db.presets.high.mainOptions || [];
        const combined = [...new Set([...existing, ...highModels])];
        db.presets.high.mainOptions = combined.slice(0, 10);
    }
    
    if (mediumModels.length > 0) {
        const existing = db.presets.medium.mainOptions || [];
        const combined = [...new Set([...existing, ...mediumModels])];
        db.presets.medium.mainOptions = combined.slice(0, 10);
    }
    
    if (lowModels.length > 0) {
        const existing = db.presets.low.mainOptions || [];
        const combined = [...new Set([...existing, ...lowModels])];
        db.presets.low.mainOptions = combined.slice(0, 10);
    }
    
    db.lastBootstrap = new Date().toISOString();
    modelDbService.saveModelDatabase(db);
    
    console.log(`[Bootstrap] Updated presets: ${highModels.length} high, ${mediumModels.length} medium, ${lowModels.length} low`);
}

/**
 * Run the full bootstrap process
 */
async function runBootstrap(modelDbService) {
    if (bootstrapState.running) {
        console.log('[Bootstrap] Already running, skipping');
        return { success: false, message: 'Bootstrap already in progress' };
    }
    
    updateBootstrapStatus({
        running: true,
        progress: 0,
        message: 'Starting bootstrap...',
        startedAt: Date.now(),
        error: null
    });
    
    let bootstrapModelId = null;
    
    try {
        // Step 1: Get downloaded models
        updateBootstrapStatus({ message: 'Scanning downloaded models...', progress: 5 });
        const downloadedModels = await getDownloadedModels();
        
        if (downloadedModels.length === 0) {
            throw new Error('No models found in LM Studio');
        }
        
        console.log(`[Bootstrap] Found ${downloadedModels.length} downloaded models`);
        
        // Step 2: Check if bootstrap model is available
        let useBootstrapModel = await isModelDownloaded(BOOTSTRAP_MODEL);
        
        if (!useBootstrapModel) {
            // Try fallback model
            useBootstrapModel = await isModelDownloaded(FALLBACK_MODEL);
            if (useBootstrapModel) {
                bootstrapModelId = FALLBACK_MODEL;
            }
        } else {
            bootstrapModelId = BOOTSTRAP_MODEL;
        }
        
        // Step 3: Analyze each model
        updateBootstrapStatus({ message: 'Analyzing models...', progress: 30 });
        const analyzedModels = [];
        
        for (let i = 0; i < downloadedModels.length; i++) {
            const model = downloadedModels[i];
            const progress = 30 + Math.round((i / downloadedModels.length) * 40);
            updateBootstrapStatus({ 
                message: `Analyzing: ${model.name || model.id}...`, 
                progress 
            });
            
            let analysis;
            if (bootstrapModelId) {
                // Use LLM for analysis (if bootstrap model loaded)
                analysis = await analyzeModelWithLLM(model);
            } else {
                // Use heuristic fallback
                analysis = analyzeModelHeuristic(model);
            }
            
            analyzedModels.push({ model, analysis });
            console.log(`[Bootstrap] ${model.name || model.id}: ${analysis.tier} (${Math.round(analysis.confidence * 100)}%)`);
        }
        
        // Step 4: Update models.json
        await updatePresetsWithModels(analyzedModels, modelDbService);
        
        // Step 5: Unload bootstrap model if we loaded it
        if (bootstrapModelId) {
            await unloadBootstrapModel(bootstrapModelId);
        }
        
        updateBootstrapStatus({
            running: false,
            progress: 100,
            message: 'Bootstrap complete',
            completedAt: Date.now()
        });
        
        return { 
            success: true, 
            message: `Analyzed ${analyzedModels.length} models`,
            models: analyzedModels.length
        };
        
    } catch (error) {
        console.error('[Bootstrap] Failed:', error.message);
        
        updateBootstrapStatus({
            running: false,
            progress: 0,
            message: `Bootstrap failed: ${error.message}`,
            error: error.message
        });
        
        // Try to unload bootstrap model if we loaded it
        if (bootstrapModelId) {
            await unloadBootstrapModel(bootstrapModelId).catch(() => {});
        }
        
        return { success: false, message: error.message };
    }
}

module.exports = {
    runBootstrap,
    getBootstrapStatus,
    getDownloadedModels,
    analyzeModelHeuristic,
    analyzeModelWithLLM
};
