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
const { getLMStudioCLIPath } = require('./lmstudio_manager.js');
const { isPresetLocked, getPresetLockedModels } = require('./model_lock_service.js');

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
        const { stdout } = await execAsync(`"${getLMStudioCLIPath()}" ls`, { timeout: 30000 });
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
        const { stdout, stderr } = await execAsync(`"${getLMStudioCLIPath()}" get "${modelId}"`, {
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
        const { stdout, stderr } = await execAsync(`"${getLMStudioCLIPath()}" load "${modelId}"`, {
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
        const { stdout, stderr } = await execAsync(`"${getLMStudioCLIPath()}" unload "${modelId}"`, {
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
 * Get list of downloaded models from LM Studio using model_sync
 * This ensures we use exact modelKeys for consistency
 */
async function getDownloadedModels() {
    try {
        // Use model_sync service for canonical modelKey format
        const { syncModels } = require('./lmstudio/model_sync.js');
        const { models } = await syncModels(true); // Force refresh
        
        // Return in expected format for bootstrap processing
        return models.map(m => ({
            id: m.modelKey,            // Use exact modelKey
            path: m.modelKey,
            name: m.displayName || m.modelKey,
            // Include additional metadata from sync
            sizeGB: m.sizeGB,
            paramsString: m.paramsString,
            trainedForToolUse: m.trainedForToolUse,
            function: m.function,      // 'main', 'summarizer', or 'embedder'
            tiers: m.tiers,            // Pre-computed tiers from model_sync
            architecture: m.architecture,
            maxContextLength: m.maxContextLength
        }));
    } catch (error) {
        console.error('[Bootstrap] Failed to get models via model_sync:', error.message);
        
        // Fallback to CLI if model_sync fails
        try {
            const { stdout } = await execAsync(`"${getLMStudioCLIPath()}" ls --json`, { timeout: 30000 });
            const rawModels = JSON.parse(stdout);
            return rawModels.map(m => ({
                id: m.modelKey,
                path: m.modelKey,
                name: m.displayName || m.modelKey,
                sizeGB: m.sizeBytes / (1024 * 1024 * 1024),
                paramsString: m.paramsString,
                trainedForToolUse: m.trainedForToolUse,
                architecture: m.architecture
            }));
        } catch (fallbackError) {
            console.error('[Bootstrap] Fallback also failed:', fallbackError.message);
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
 * Heuristic-based model categorization
 * Uses pre-computed tiers from model_sync when available
 */
function analyzeModelHeuristic(modelInfo) {
    // If model_sync already computed tiers, use them directly
    if (modelInfo.tiers && modelInfo.tiers.length > 0) {
        // Use the highest tier the model fits in
        const tier = modelInfo.tiers.includes('high') ? 'high' :
                     modelInfo.tiers.includes('medium') ? 'medium' : 'low';
        
        const reason = modelInfo.trainedForToolUse 
            ? `${modelInfo.paramsString || 'Unknown'} model with tool use (${modelInfo.function})`
            : `${modelInfo.paramsString || 'Unknown'} model (${modelInfo.function})`;
            
        return { tier, confidence: 0.9, reason };
    }
    
    // Fallback to name-based heuristics if no pre-computed data
    const name = (modelInfo.name || modelInfo.id || '').toLowerCase();
    
    // Use sizeGB if available
    if (modelInfo.sizeGB) {
        const sizeGB = modelInfo.sizeGB;
        if (sizeGB > 10) {
            return { tier: 'high', confidence: 0.85, reason: `Large model (${sizeGB.toFixed(1)}GB)` };
        } else if (sizeGB > 3) {
            return { tier: 'medium', confidence: 0.85, reason: `Medium model (${sizeGB.toFixed(1)}GB)` };
        } else {
            return { tier: 'low', confidence: 0.85, reason: `Small model (${sizeGB.toFixed(1)}GB)` };
        }
    }
    
    // Size-based heuristics from name
    if (name.includes('70b') || name.includes('72b') || name.includes('65b')) {
        return { tier: 'high', confidence: 0.9, reason: 'Very large model (65B+)' };
    }
    if (name.includes('7b') || name.includes('8b') || name.includes('13b') || name.includes('14b')) {
        return { tier: 'high', confidence: 0.8, reason: 'Large model (7B-14B)' };
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
 * Only adds main models (with tool use) to mainOptions
 * Uses exact modelKey from LM Studio
 * Respects preset locks - locked models are not replaced
 */
async function updatePresetsWithModels(analyzedModels, modelDbService) {
    updateBootstrapStatus({ message: 'Updating presets...', progress: 80 });
    
    const db = modelDbService.loadModelDatabase();
    
    // Get list of models that are locked and should be preserved
    const lockedModels = getPresetLockedModels();
    if (lockedModels.length > 0) {
        console.log(`[Bootstrap] Preserving ${lockedModels.length} locked models:`, lockedModels.join(', '));
    }
    
    // Categorize by tier AND function
    const highMainModels = [];
    const mediumMainModels = [];
    const lowMainModels = [];
    
    for (const { model, analysis } of analyzedModels) {
        // Use exact modelKey (not path or name)
        const modelKey = model.id;
        if (!modelKey) continue;
        
        // Skip embedding models for mainOptions
        if (model.function === 'embedder') {
            console.log(`[Bootstrap] Skipping embedder: ${modelKey}`);
            continue;
        }
        
        // Add/update in modelSpecs with exact modelKey
        if (!db.modelSpecs[modelKey]) {
            db.modelSpecs[modelKey] = {
                id: modelKey,
                name: model.name || modelKey,
                author: modelKey.split('/')[0] || 'Unknown',
                type: model.function || 'main',
                engine: 'lmstudio',
                available: true,
                description: analysis.reason || 'Discovered model',
                sizeGB: model.sizeGB,
                paramsString: model.paramsString,
                trainedForToolUse: model.trainedForToolUse || false,
                maxContextLength: model.maxContextLength,
                requirements: { 
                    vram: model.sizeGB ? `${model.sizeGB.toFixed(1)}GB` : 'Unknown',
                    recommendedHardware: analysis.tier === 'high' ? 'RTX 4080+' : 
                                        analysis.tier === 'medium' ? 'RTX 3080+' : 'RTX 3060+'
                },
                capabilities: model.trainedForToolUse ? ['Tool Use', 'Coding'] : ['General', 'Coding'],
                tags: ['discovered', analysis.tier, model.function]
            };
        } else {
            db.modelSpecs[modelKey].available = true;
            db.modelSpecs[modelKey].sizeGB = model.sizeGB;
            db.modelSpecs[modelKey].trainedForToolUse = model.trainedForToolUse;
        }
        
        // Only main/summarizer models go into mainOptions
        // Prefer models with tool use for main, but include all LLMs
        if (model.function !== 'embedder') {
            // Use pre-computed tiers from model_sync if available
            const tiers = model.tiers || [];
            
            if (tiers.includes('high') || analysis.tier === 'high') {
                highMainModels.push(modelKey);
            }
            if (tiers.includes('medium') || analysis.tier === 'medium') {
                mediumMainModels.push(modelKey);
            }
            if (tiers.includes('low') || analysis.tier === 'low') {
                lowMainModels.push(modelKey);
            }
        }
    }
    
    // Sort by: tool use first, then by size (smaller first for each tier)
    const sortModels = (models, analyzed) => {
        return [...new Set(models)].sort((a, b) => {
            const aModel = analyzed.find(x => x.model.id === a)?.model;
            const bModel = analyzed.find(x => x.model.id === b)?.model;
            
            // Tool use models first
            if (aModel?.trainedForToolUse && !bModel?.trainedForToolUse) return -1;
            if (!aModel?.trainedForToolUse && bModel?.trainedForToolUse) return 1;
            
            // Then by size (smaller first)
            return (aModel?.sizeGB || 0) - (bModel?.sizeGB || 0);
        });
    };
    
    // Helper to preserve locked models when updating presets
    const updatePresetWithLocks = (tier, newModels) => {
        const sorted = sortModels(newModels, analyzedModels);
        const existing = db.presets[tier].mainOptions || [];
        
        // Locked models always stay at the beginning (preserved)
        const locked = existing.filter(id => isPresetLocked(id));
        
        // Unlocked models can be replaced
        const unlocked = existing.filter(id => !isPresetLocked(id) && sorted.includes(id));
        
        // New models not in existing
        const newOnes = sorted.filter(id => !existing.includes(id));
        
        // Combine: locked first, then unlocked existing, then new
        const combined = [...new Set([...locked, ...unlocked, ...newOnes])];
        return combined.slice(0, 10);
    };
    
    // Update presets with sorted models (max 10 per tier), respecting locks
    if (highMainModels.length > 0) {
        db.presets.high.mainOptions = updatePresetWithLocks('high', highMainModels);
    }
    
    if (mediumMainModels.length > 0) {
        db.presets.medium.mainOptions = updatePresetWithLocks('medium', mediumMainModels);
    }
    
    if (lowMainModels.length > 0) {
        db.presets.low.mainOptions = updatePresetWithLocks('low', lowMainModels);
    }
    
    db.lastBootstrap = new Date().toISOString();
    modelDbService.saveModelDatabase(db);
    
    console.log(`[Bootstrap] Updated presets: ${db.presets.high.mainOptions?.length || 0} high, ${db.presets.medium.mainOptions?.length || 0} medium, ${db.presets.low.mainOptions?.length || 0} low`);
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
