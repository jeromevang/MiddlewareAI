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
const { getEssentialModels } = require('./recommended_models.js');

// Bootstrap model configuration
const BOOTSTRAP_MODEL = 'squeeze-ai-lab/TinyAgent-1.1B-GGUF';
const FALLBACK_MODEL = 'Qwen/Qwen2.5-0.5B-Instruct-GGUF';
const LM_STUDIO_URL = 'http://localhost:1234';

// =========================
// Model Blacklist
// =========================
// Models that should never be used in presets due to poor quality or issues
const MODEL_BLACKLIST = [
    { pattern: 'tinyllama', reason: 'Produces garbage/repetitive output, too small for reliable inference' },
    { pattern: 'phi-1', reason: 'Too small for meaningful output (1.3B)' },
    { pattern: 'orca-mini', reason: 'Poor instruction following and coherence' },
    { pattern: 'stablelm-zephyr-3b', reason: 'Inconsistent output quality' },
    { pattern: 'pythia', reason: 'Base model without instruction tuning' }
];

/**
 * Check if a model is blacklisted
 * @param {string} modelId - Model identifier to check
 * @returns {{ blacklisted: boolean, reason?: string }}
 */
function isModelBlacklisted(modelId) {
    if (!modelId) return { blacklisted: false };
    const lower = modelId.toLowerCase();
    
    for (const entry of MODEL_BLACKLIST) {
        if (lower.includes(entry.pattern)) {
            return { blacklisted: true, reason: entry.reason };
        }
    }
    return { blacklisted: false };
}

/**
 * Filter out blacklisted models from a list
 * @param {Array} models - Array of model objects with id/name property
 * @returns {{ allowed: Array, removed: Array<{model: object, reason: string}> }}
 */
function filterBlacklistedModels(models) {
    const allowed = [];
    const removed = [];
    
    for (const model of models) {
        const id = model.id || model.name || '';
        const check = isModelBlacklisted(id);
        if (check.blacklisted) {
            removed.push({ model, reason: check.reason });
            console.warn(`[Blacklist] Excluding model '${id}': ${check.reason}`);
        } else {
            allowed.push(model);
        }
    }
    
    return { allowed, removed };
}

/**
 * Remove blacklisted models from LM Studio
 * Attempts to unload and remove using CLI
 * @returns {Promise<{removed: string[], failed: string[]}>}
 */
async function removeBlacklistedModels() {
    const results = { removed: [], failed: [] };
    const cliPath = getLMStudioCLIPath();
    
    try {
        // Get list of downloaded models
        const { stdout } = await execAsync(`"${cliPath}" ls --json`, { timeout: 30000 });
        const models = JSON.parse(stdout);
        
        for (const model of models) {
            const modelId = model.path || model.id || '';
            const check = isModelBlacklisted(modelId);
            
            if (check.blacklisted) {
                console.log(`[Blacklist] Attempting to remove blacklisted model: ${modelId}`);
                
                try {
                    // Try to unload first if loaded
                    await execAsync(`"${cliPath}" unload "${modelId}" -y`, { timeout: 30000 }).catch(() => {});
                    
                    // Try to remove (lms rm may not exist in all versions)
                    try {
                        await execAsync(`"${cliPath}" rm "${modelId}" -y`, { timeout: 60000 });
                        results.removed.push(modelId);
                        console.log(`[Blacklist] Successfully removed: ${modelId}`);
                    } catch (rmError) {
                        // rm command might not exist - log for manual removal
                        console.warn(`[Blacklist] Could not auto-remove ${modelId} (CLI 'rm' may not be supported). Please remove manually.`);
                        console.warn(`[Blacklist] Reason for removal: ${check.reason}`);
                        results.failed.push(modelId);
                    }
                } catch (error) {
                    console.error(`[Blacklist] Failed to process ${modelId}:`, error.message);
                    results.failed.push(modelId);
                }
            }
        }
    } catch (error) {
        console.error('[Blacklist] Failed to get model list:', error.message);
    }
    
    return results;
}

/**
 * Download essential models for a given tier
 * Called when no models are found during bootstrap
 * @param {string} tier - 'high', 'medium', or 'low'
 * @param {number} maxDownloads - Maximum number of models to download
 * @returns {Promise<number>} - Number of models downloaded
 */
async function downloadEssentialModels(tier, maxDownloads = 3) {
    const essentials = getEssentialModels(tier);
    const cliPath = getLMStudioCLIPath();
    let downloaded = 0;
    
    console.log(`[Bootstrap] Downloading up to ${maxDownloads} essential models for tier: ${tier}`);
    
    for (const model of essentials) {
        if (downloaded >= maxDownloads) {
            console.log(`[Bootstrap] Reached max downloads (${maxDownloads}), stopping`);
            break;
        }
        
        const modelId = model.id;
        const quant = model.quant || 'Q4_K_M';
        
        updateBootstrapStatus({ 
            message: `Downloading: ${modelId} (${quant})...`, 
            progress: 10 + (downloaded * 5)
        });
        
        try {
            console.log(`[Bootstrap] Downloading ${modelId}@${quant}...`);
            
            // Use lms get command
            const cmd = `"${cliPath}" get "${modelId}@${quant.toLowerCase()}" -y`;
            await execAsync(cmd, { timeout: 600000 }); // 10 minute timeout for downloads
            
            downloaded++;
            console.log(`[Bootstrap] Successfully downloaded: ${modelId}`);
        } catch (error) {
            console.error(`[Bootstrap] Failed to download ${modelId}:`, error.message);
            // Continue with other downloads
        }
    }
    
    console.log(`[Bootstrap] Downloaded ${downloaded} essential models`);
    return downloaded;
}

// Bootstrap state
let bootstrapState = {
    running: false,
    progress: 0,
    message: '',
    startedAt: null,
    completedAt: null,
    error: null,
    currentModel: null,
    modelsAnalyzed: 0,
    totalModels: 0
};

// Callback for broadcasting status updates (set by server.js)
let statusBroadcastCallback = null;

/**
 * Set the callback function for broadcasting status updates via WebSocket
 * @param {Function} callback - Function to call with status updates
 */
function setStatusBroadcastCallback(callback) {
    statusBroadcastCallback = callback;
}

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
 * Update bootstrap status and broadcast to WebSocket clients
 */
function updateBootstrapStatus(updates) {
    bootstrapState = { ...bootstrapState, ...updates };
    console.log(`[Bootstrap] ${updates.message || bootstrapState.message}`);
    
    // Broadcast to WebSocket clients if callback is set
    if (statusBroadcastCallback) {
        try {
            statusBroadcastCallback(bootstrapState);
        } catch (err) {
            console.warn('[Bootstrap] Failed to broadcast status:', err.message);
        }
    }
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
    const sizeGB = modelInfo.sizeGB || 0;
    const prompt = `Analyze this AI model for a coding assistant middleware system.

Model: ${modelInfo.name || modelInfo.id}
Full ID: ${modelInfo.id}
Size: ${sizeGB ? `${sizeGB.toFixed(1)}GB` : 'Unknown'}
Context: ${modelInfo.maxContextLength || 'Unknown'} tokens
Tool Use: ${modelInfo.trainedForToolUse ? 'Yes' : 'No'}

Evaluate this model for THREE specific roles in a coding assistant:

**Main Chat**: Complex reasoning, tool use, code generation, instruction following. Any size model.
**RAG Summarization**: Code semantics understanding, chunk summarization. MUST be small (<4GB) for speed.
**Rolling Summarization**: Conversation memory management, context compression. MUST be small (<4GB) for speed.

CRITICAL RULE: Summarizer roles (rag_summarizer, rolling_summarizer) REQUIRE small, fast models.
- Models >4GB should have LOW scores (0.1-0.2) for summarizer roles
- Models <2GB are IDEAL for summarization (0.7-0.9 scores)
- Models 2-4GB are acceptable for summarization (0.4-0.6 scores)

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

// Summarizers should ALWAYS be small and fast, regardless of quality tier
const MAX_SUMMARIZER_SIZE_GB = 4;  // 4GB max for summarizer models
const IDEAL_SUMMARIZER_SIZE_GB = 2; // 2GB or less is ideal

/**
 * Heuristic-based model analysis with capability evaluation
 * Uses pre-computed tiers from model_sync when available
 * 
 * KEY DESIGN: Summarizers are always small/fast models. The quality tier
 * only affects the main model. This ensures summarizers don't compete
 * for VRAM and remain snappy.
 */
function analyzeModelHeuristic(modelInfo) {
    const name = (modelInfo.name || modelInfo.id || '').toLowerCase();
    const hasToolUse = modelInfo.trainedForToolUse || false;
    const sizeGB = modelInfo.sizeGB || 0;

    // Determine tier based on size (used for main model quality)
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

    // ============================================
    // SUMMARIZER SIZE ENFORCEMENT (Critical!)
    // Summarizers MUST be small and fast
    // ============================================
    
    if (sizeGB > MAX_SUMMARIZER_SIZE_GB) {
        // Large models should NOT be summarizers - heavy penalty
        capabilities.rag_summarizer = 0.1;
        capabilities.rolling_summarizer = 0.1;
    } else if (sizeGB <= IDEAL_SUMMARIZER_SIZE_GB) {
        // Small models are ideal for summarization - big bonus
        capabilities.rag_summarizer += 0.35;
        capabilities.rolling_summarizer += 0.4;
    } else {
        // Medium-small models (2-4GB) are acceptable summarizers
        capabilities.rag_summarizer += 0.15;
        capabilities.rolling_summarizer += 0.2;
    }

    // Tool use models are great for main chat
    if (hasToolUse) {
        capabilities.main += 0.3;
    }

    // Coding-focused models excel at RAG summarization (if small enough)
    if (name.includes('coder') || name.includes('code') || name.includes('deepseek')) {
        if (sizeGB <= MAX_SUMMARIZER_SIZE_GB) {
            capabilities.rag_summarizer += 0.3; // Great for code summarization
        }
        capabilities.main += 0.2;
    }

    // Instruction-tuned models good for conversation management (if small enough)
    if (name.includes('instruct') || name.includes('chat')) {
        if (sizeGB <= MAX_SUMMARIZER_SIZE_GB) {
            capabilities.rolling_summarizer += 0.25;
        }
        capabilities.main += 0.2;
    }

    // Size-based capability adjustments for MAIN role only
    if (tier === 'high') {
        capabilities.main += 0.25; // Large models good for complex tasks
    } else if (tier === 'low') {
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
        rag_summarizer: 'ideal for fast code summarization',
        rolling_summarizer: 'ideal for fast conversation memory'
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

    // ============================================
    // KEY: Summarizers should be small and fast for ALL presets
    // Pool all summarizer-capable models across tiers
    // ============================================
    const allRagSummarizers = [
        ...roleCategories.rag_summarizer.high,
        ...roleCategories.rag_summarizer.medium,
        ...roleCategories.rag_summarizer.low
    ];
    const allRollingSummarizers = [
        ...roleCategories.rolling_summarizer.high,
        ...roleCategories.rolling_summarizer.medium,
        ...roleCategories.rolling_summarizer.low
    ];

    // Sort pooled summarizers by capability (best first)
    const sortedRagSummarizers = sortModelsByCapability([...new Set(allRagSummarizers)], analyzedModels, 'rag_summarizer');
    const sortedRollingSummarizers = sortModelsByCapability([...new Set(allRollingSummarizers)], analyzedModels, 'rolling_summarizer');

    console.log(`[Bootstrap] Pooled summarizers - RAG: ${sortedRagSummarizers.length}, Rolling: ${sortedRollingSummarizers.length}`);

    for (const tier of tiers) {
        if (!db.presets[tier]) db.presets[tier] = {};

        for (const role of roles) {
            let models;
            
            if (role === 'main') {
                // Main models follow tier-based selection
                models = roleCategories[role]?.[tier] || [];
            } else if (role === 'rag_summarizer') {
                // RAG summarizers: use the SAME pooled small models for ALL tiers
                models = sortedRagSummarizers;
            } else if (role === 'rolling_summarizer') {
                // Rolling summarizers: use the SAME pooled small models for ALL tiers
                models = sortedRollingSummarizers;
            }

            if (models && models.length > 0) {
                const fieldName = role === 'main' ? 'mainOptions' :
                                role === 'rolling_summarizer' ? 'rollingSummarizerOptions' :
                                'ragSummarizerOptions';

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
        // Step 0: Remove blacklisted models
        updateBootstrapStatus({ message: 'Checking for blacklisted models...', progress: 2 });
        const blacklistResults = await removeBlacklistedModels();
        if (blacklistResults.removed.length > 0) {
            console.log(`[Bootstrap] Removed ${blacklistResults.removed.length} blacklisted models`);
        }
        if (blacklistResults.failed.length > 0) {
            console.warn(`[Bootstrap] ${blacklistResults.failed.length} blacklisted models need manual removal`);
        }
        
        // Step 1: Get downloaded models
        updateBootstrapStatus({ message: 'Scanning downloaded models...', progress: 5 });
        let downloadedModels = await getDownloadedModels();
        
        // Filter out any remaining blacklisted models from analysis
        const { allowed: filteredModels, removed: blacklistedInList } = filterBlacklistedModels(downloadedModels);
        if (blacklistedInList.length > 0) {
            console.log(`[Bootstrap] Filtered out ${blacklistedInList.length} blacklisted models from analysis`);
        }
        downloadedModels = filteredModels;
        
        // Step 1b: Auto-download recommended models if enabled
        const { getConfig } = require('./config.js');
        const config = getConfig();
        const autoDownload = config.system?.autoDownloadModels !== false;
        const autoDownloadTier = config.system?.autoDownloadTier || 'medium';
        const maxAutoDownloads = config.system?.maxAutoDownloadsPerBootstrap || 3;
        
        if (autoDownload && downloadedModels.length === 0) {
            // No models at all - download essential models
            updateBootstrapStatus({ message: 'No models found. Downloading essential models...', progress: 8 });
            const downloaded = await downloadEssentialModels(autoDownloadTier, maxAutoDownloads);
            if (downloaded > 0) {
                // Re-fetch models after download
                downloadedModels = await getDownloadedModels();
                const filtered = filterBlacklistedModels(downloadedModels);
                downloadedModels = filtered.allowed;
            }
        }
        
        if (downloadedModels.length === 0) {
            throw new Error('No models found in LM Studio (after filtering blacklist)');
        }
        
        console.log(`[Bootstrap] Found ${downloadedModels.length} models (after blacklist filtering)`);
        
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
        updateBootstrapStatus({ 
            message: 'Analyzing models...', 
            progress: 30,
            totalModels: downloadedModels.length,
            modelsAnalyzed: 0
        });
        const analyzedModels = [];
        
        for (let i = 0; i < downloadedModels.length; i++) {
            const model = downloadedModels[i];
            const progress = 30 + Math.round((i / downloadedModels.length) * 40);
            updateBootstrapStatus({ 
                message: `Analyzing: ${model.name || model.id}...`, 
                progress,
                currentModel: model.name || model.id,
                modelsAnalyzed: i
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
    setStatusBroadcastCallback,
    getDownloadedModels,
    analyzeModelHeuristic,
    analyzeModelWithLLM,
    // Blacklist functions
    isModelBlacklisted,
    filterBlacklistedModels,
    removeBlacklistedModels,
    MODEL_BLACKLIST,
    // Auto-download
    downloadEssentialModels
};
