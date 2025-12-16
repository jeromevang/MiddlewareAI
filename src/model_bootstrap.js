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
 * Generate capability tags from analysis
 */
function getCapabilityTags(analysis) {
    const tags = [];
    if (analysis.capabilities) {
        if (analysis.capabilities.main > 0.7) tags.push('Tool Use');
        if (analysis.capabilities.rag_summarizer > 0.7) tags.push('Code Analysis');
        if (analysis.capabilities.rolling_summarizer > 0.7) tags.push('Memory Management');
    }
    tags.push('Coding'); // All models get coding tag for now
    return tags;
}

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
 * Analyze a model using the bootstrap LLM for specific capabilities
 */
async function analyzeModelWithLLM(modelInfo) {
    const prompt = `Analyze this AI model for a coding assistant middleware system.

Model: ${modelInfo.name || modelInfo.id}
Full ID: ${modelInfo.id}
Size: ${modelInfo.sizeGB ? `${modelInfo.sizeGB.toFixed(1)}GB` : 'Unknown'}
Context: ${modelInfo.maxContextLength || 'Unknown'} tokens
Tool Use: ${modelInfo.trainedForToolUse ? 'Yes' : 'No'}

Evaluate this model for THREE specific roles in a coding assistant:

**Main Chat**: Complex reasoning, tool use, code generation, instruction following
**RAG Summarization**: Code semantics understanding, chunk summarization, relationship analysis
**Rolling Summarization**: Conversation memory management, coherence maintenance, context compression

Rate each capability 0.0-1.0 and assign the SINGLE best primary role.

Respond with ONLY valid JSON:
{
  "primaryRole": "main"|"rag_summarizer"|"rolling_summarizer",
  "capabilities": {
    "main": 0.0-1.0,
    "rag_summarizer": 0.0-1.0,
    "rolling_summarizer": 0.0-1.0
  },
  "tier": "high"|"medium"|"low",
  "confidence": 0.0-1.0,
  "reason": "brief explanation of role assignment"
}`;

    try {
        const response = await axios.post(`${LM_STUDIO_URL}/v1/chat/completions`, {
            model: 'local-model',
            messages: [
                { role: 'system', content: 'You are an expert model evaluator for coding assistants. Respond only with valid JSON.' },
                { role: 'user', content: prompt }
            ],
            temperature: 0.1,
            max_tokens: 300
        }, { timeout: 30000 });

        const content = response.data?.choices?.[0]?.message?.content || '';

        // Extract JSON from response
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const result = JSON.parse(jsonMatch[0]);

            // Validate the response structure
            if (!result.primaryRole || !result.capabilities || !result.tier) {
                throw new Error('Invalid response structure');
            }

            return result;
        }

        throw new Error('No valid JSON in response');
    } catch (error) {
        console.warn('[Bootstrap] LLM analysis failed, using heuristic:', error.message);
        return analyzeModelHeuristic(modelInfo);
    }
}

/**
 * Heuristic-based model analysis with capability evaluation
 * Uses pre-computed tiers from model_sync when available
 */
function analyzeModelHeuristic(modelInfo) {
    const name = (modelInfo.name || modelInfo.id || '').toLowerCase();
    const hasToolUse = modelInfo.trainedForToolUse || false;
    const sizeGB = modelInfo.sizeGB || 0;

    // Determine tier based on size
    let tier = 'medium';
    if (sizeGB > 10 || name.includes('70b') || name.includes('65b')) {
        tier = 'high';
    } else if (sizeGB < 3 || name.includes('1b') || name.includes('0.5b') || name.includes('tiny') || name.includes('mini')) {
        tier = 'low';
    }

    // Evaluate capabilities based on model characteristics
    let capabilities = {
        main: 0.5,
        rag_summarizer: 0.5,
        rolling_summarizer: 0.5
    };

    // Tool use models are great for main chat
    if (hasToolUse) {
        capabilities.main += 0.3;
    }

    // Coding-focused models excel at RAG summarization
    if (name.includes('coder') || name.includes('code') || name.includes('deepseek')) {
        capabilities.rag_summarizer += 0.4;
        capabilities.main += 0.2;
    }

    // Instruction-tuned models good for conversation management
    if (name.includes('instruct') || name.includes('chat')) {
        capabilities.rolling_summarizer += 0.3;
        capabilities.main += 0.2;
    }

    // Size-based capability adjustments
    if (tier === 'high') {
        capabilities.main += 0.2; // Large models good for complex tasks
        capabilities.rag_summarizer += 0.1; // Good at understanding complex code
    } else if (tier === 'low') {
        capabilities.rolling_summarizer += 0.2; // Fast models good for memory tasks
        capabilities.main -= 0.1; // Less capable for complex reasoning
    }

    // Cap capabilities at 1.0
    Object.keys(capabilities).forEach(key => {
        capabilities[key] = Math.min(1.0, Math.max(0.0, capabilities[key]));
    });

    // Determine primary role based on highest capability
    const primaryRole = Object.entries(capabilities).reduce((a, b) =>
        capabilities[a[0]] > capabilities[b[0]] ? a : b
    )[0];

    // Generate reason
    const sizeDesc = sizeGB > 0 ? `${sizeGB.toFixed(1)}GB` : 'unknown size';
    const toolDesc = hasToolUse ? 'with tool use' : '';
    const roleDesc = {
        main: 'best for complex reasoning and tool use',
        rag_summarizer: 'best for code understanding and summarization',
        rolling_summarizer: 'best for conversation memory management'
    }[primaryRole];

    const reason = `${sizeDesc} ${tier}-tier model ${toolDesc} - ${roleDesc}`;

    return {
        primaryRole,
        capabilities,
        tier,
        confidence: 0.7,
        reason
    };
}

/**
 * Update models.json presets with analyzed models
 * Assigns models to optimal roles based on capability analysis
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

    // Categorize models by their primary role and tier
    const roleCategories = {
        main: { high: [], medium: [], low: [] },
        rag_summarizer: { high: [], medium: [], low: [] },
        rolling_summarizer: { high: [], medium: [], low: [] }
    };

    for (const { model, analysis } of analyzedModels) {
        // Use exact modelKey (not path or name)
        const modelKey = model.id;
        if (!modelKey) continue;

        // Skip embedding models
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
                type: analysis.primaryRole || model.function || 'main',
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
                capabilities: getCapabilityTags(analysis),
                tags: ['discovered', analysis.tier, analysis.primaryRole],
                analysis: {
                    primaryRole: analysis.primaryRole,
                    capabilities: analysis.capabilities,
                    confidence: analysis.confidence
                }
            };
        } else {
            db.modelSpecs[modelKey].available = true;
            db.modelSpecs[modelKey].sizeGB = model.sizeGB;
            db.modelSpecs[modelKey].trainedForToolUse = model.trainedForToolUse;
            db.modelSpecs[modelKey].analysis = {
                primaryRole: analysis.primaryRole,
                capabilities: analysis.capabilities,
                confidence: analysis.confidence
            };
        }

        // Categorize by primary role and tier
        const primaryRole = analysis.primaryRole || 'main';
        const tier = analysis.tier || 'medium';

        if (roleCategories[primaryRole] && roleCategories[primaryRole][tier]) {
            roleCategories[primaryRole][tier].push(modelKey);
        }
    }
    
    // Enhanced sorting that considers capability scores
    const sortModelsByCapability = (models, analyzed, role) => {
        return [...new Set(models)].sort((a, b) => {
            const aAnalysis = analyzed.find(x => x.model.id === a)?.analysis;
            const bAnalysis = analyzed.find(x => x.model.id === b)?.analysis;
            const aModel = analyzed.find(x => x.model.id === a)?.model;
            const bModel = analyzed.find(x => x.model.id === b)?.model;

            // Primary sort: capability score for the target role
            const aCapability = aAnalysis?.capabilities?.[role] || 0;
            const bCapability = bAnalysis?.capabilities?.[role] || 0;
            if (aCapability !== bCapability) {
                return bCapability - aCapability; // Higher capability first
            }

            // Secondary sort: tool use models first (for main role)
            if (role === 'main') {
                if (aModel?.trainedForToolUse && !bModel?.trainedForToolUse) return -1;
                if (!aModel?.trainedForToolUse && bModel?.trainedForToolUse) return 1;
            }

            // Tertiary sort: smaller models first (for efficiency)
            return (aModel?.sizeGB || 0) - (bModel?.sizeGB || 0);
        });
    };

    // Helper to preserve locked models when updating role assignments
    const updateRoleWithLocks = (tier, role, newModels) => {
        const sorted = sortModelsByCapability(newModels, analyzedModels, role);
        const existing = db.presets[tier][role === 'main' ? 'mainOptions' : role === 'rolling_summarizer' ? 'rollingSummarizerOptions' : 'ragSummarizerOptions'] || [];

        // Locked models always stay at the beginning (preserved)
        const locked = existing.filter(id => isPresetLocked(id));

        // Unlocked models can be replaced
        const unlocked = existing.filter(id => !isPresetLocked(id) && sorted.includes(id));

        // New models not in existing
        const newOnes = sorted.filter(id => !existing.includes(id));

        // Combine: locked first, then unlocked existing, then new
        const combined = [...new Set([...locked, ...unlocked, ...newOnes])];
        return combined.slice(0, 5); // Max 5 per role per tier
    };

    // Update presets with role-assigned models, respecting locks
    const tiers = ['high', 'medium', 'low'];
    const roles = ['main', 'rag_summarizer', 'rolling_summarizer'];

    for (const tier of tiers) {
        for (const role of roles) {
            const models = roleCategories[role]?.[tier] || [];
            if (models.length > 0) {
                const fieldName = role === 'main' ? 'mainOptions' :
                                role === 'rolling_summarizer' ? 'rollingSummarizerOptions' :
                                'ragSummarizerOptions';

                if (!db.presets[tier]) db.presets[tier] = {};
                db.presets[tier][fieldName] = updateRoleWithLocks(tier, role, models);
            }
        }
    }

    db.lastBootstrap = new Date().toISOString();
    modelDbService.saveModelDatabase(db);

    // Log the results
    const results = {};
    for (const tier of tiers) {
        results[tier] = {};
        for (const role of roles) {
            const fieldName = role === 'main' ? 'mainOptions' :
                            role === 'rolling_summarizer' ? 'rollingSummarizerOptions' :
                            'ragSummarizerOptions';
            results[tier][role] = db.presets[tier]?.[fieldName]?.length || 0;
        }
    }

    console.log(`[Bootstrap] Updated role assignments:`, JSON.stringify(results, null, 2));
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
