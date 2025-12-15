/**
 * Model Optimizer Service
 * 
 * Uses a small LLM to intelligently select the best model configuration
 * for the user's hardware. Falls back to heuristics if no LLM available.
 */

const { exec } = require('child_process');
const { promisify } = require('util');
const axios = require('axios');
const { getLMStudioCLIPath } = require('./lmstudio_manager.js');
const { detectHardware, getModelStarRating } = require('./hardware_detector.js');
const { syncModels } = require('./lmstudio/model_sync.js');

const execAsync = promisify(exec);

const LM_STUDIO_URL = 'http://localhost:1234';

// Small models suitable for optimization analysis
const OPTIMIZER_MODELS = [
    'squeeze-ai-lab/TinyAgent-1.1B-GGUF',
    'Qwen/Qwen2.5-0.5B-Instruct-GGUF',
    'qwen2.5-coder-0.5b-instruct',
    'tinyllama-1.1b-chat-v1.0'
];

let optimizerState = {
    running: false,
    modelId: null
};

/**
 * Find the best available optimizer model from downloaded models
 */
async function findOptimizerModel(downloadedModels) {
    const modelIds = downloadedModels.map(m => m.modelKey?.toLowerCase() || m.id?.toLowerCase());
    
    for (const candidate of OPTIMIZER_MODELS) {
        const candidateLower = candidate.toLowerCase();
        const found = modelIds.find(id => 
            id.includes(candidateLower) || 
            candidateLower.includes(id.split('/').pop() || '')
        );
        if (found) {
            const model = downloadedModels.find(m => 
                (m.modelKey?.toLowerCase() || m.id?.toLowerCase()) === found
            );
            return model?.modelKey || model?.id || found;
        }
    }
    
    // Fallback: find smallest non-embedder model
    const smallModels = downloadedModels
        .filter(m => m.function !== 'embedder' && m.sizeGB && m.sizeGB < 2)
        .sort((a, b) => (a.sizeGB || 0) - (b.sizeGB || 0));
    
    return smallModels[0]?.modelKey || smallModels[0]?.id || null;
}

/**
 * Load the optimizer model temporarily
 */
async function loadOptimizerModel(modelId) {
    try {
        console.log(`[Optimizer] Loading optimizer model: ${modelId}`);
        const cliPath = getLMStudioCLIPath();
        await execAsync(`"${cliPath}" load "${modelId}" --gpu 0.3 --yes`, { timeout: 120000 });
        await new Promise(r => setTimeout(r, 3000)); // Wait for model to initialize
        optimizerState.modelId = modelId;
        return true;
    } catch (error) {
        console.error(`[Optimizer] Failed to load model:`, error.message);
        return false;
    }
}

/**
 * Unload the optimizer model
 */
async function unloadOptimizerModel() {
    if (!optimizerState.modelId) return;
    
    try {
        console.log(`[Optimizer] Unloading optimizer model: ${optimizerState.modelId}`);
        const cliPath = getLMStudioCLIPath();
        await execAsync(`"${cliPath}" unload "${optimizerState.modelId}"`, { timeout: 30000 });
    } catch (error) {
        console.warn(`[Optimizer] Failed to unload model:`, error.message);
    } finally {
        optimizerState.modelId = null;
    }
}

/**
 * Ask the LLM to recommend optimal models
 */
async function askLLMForRecommendation(hardware, availableModels) {
    const mainModels = availableModels.filter(m => m.function === 'main' || m.trainedForToolUse);
    const summarizerModels = availableModels.filter(m => m.function === 'summarizer' || 
        (m.function !== 'embedder' && m.sizeGB && m.sizeGB < 3));
    const embedderModels = availableModels.filter(m => m.function === 'embedder');

    const prompt = `You are a model configuration optimizer. Given the user's hardware and available models, select the best combination.

HARDWARE:
- GPU: ${hardware.gpu?.name || 'None'}
- VRAM: ${hardware.gpu?.totalGB?.toFixed(1) || 0} GB
- RAM: ${hardware.ram?.totalGB?.toFixed(1) || 0} GB

AVAILABLE MAIN MODELS (for chat/coding):
${mainModels.slice(0, 10).map(m => `- ${m.modelKey}: ${m.sizeGB?.toFixed(1) || '?'}GB, toolUse=${m.trainedForToolUse || false}, ctx=${m.maxContextLength || '?'}`).join('\n')}

AVAILABLE SUMMARIZER MODELS (for context compression):
${summarizerModels.slice(0, 5).map(m => `- ${m.modelKey}: ${m.sizeGB?.toFixed(1) || '?'}GB`).join('\n')}

AVAILABLE EMBEDDER MODELS (for semantic search):
${embedderModels.slice(0, 5).map(m => `- ${m.modelKey}: ${m.sizeGB?.toFixed(1) || '?'}GB`).join('\n')}

CONSTRAINTS:
- Total VRAM usage must be under ${hardware.gpu?.totalGB || 8} GB (with ~2GB headroom)
- Main model should have toolUse=true if possible
- Summarizer should be small and fast (<2GB)
- Prioritize quality within VRAM budget

Return ONLY valid JSON:
{
  "main": "exact modelKey",
  "summarizer": "exact modelKey", 
  "embedder": "exact modelKey or null",
  "reasoning": "brief explanation",
  "estimatedVRAM": number_in_GB
}`;

    try {
        const response = await axios.post(`${LM_STUDIO_URL}/v1/chat/completions`, {
            model: 'local-model',
            messages: [
                { role: 'system', content: 'You are a model optimizer. Return only valid JSON.' },
                { role: 'user', content: prompt }
            ],
            temperature: 0.1,
            max_tokens: 300
        }, { timeout: 60000 });

        const content = response.data?.choices?.[0]?.message?.content || '';
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        
        if (jsonMatch) {
            return JSON.parse(jsonMatch[0]);
        }
        throw new Error('No valid JSON in response');
    } catch (error) {
        console.warn('[Optimizer] LLM recommendation failed:', error.message);
        return null;
    }
}

/**
 * Heuristic-based optimization (fallback when no LLM available)
 */
function heuristicOptimization(hardware, availableModels) {
    const vramBudget = (hardware.gpu?.totalGB || 8) - 2; // 2GB headroom
    
    // Categorize models
    const mainModels = availableModels
        .filter(m => m.function === 'main' || m.trainedForToolUse)
        .sort((a, b) => {
            // Prefer tool use models, then by size (larger is better quality)
            if (a.trainedForToolUse && !b.trainedForToolUse) return -1;
            if (!a.trainedForToolUse && b.trainedForToolUse) return 1;
            return (b.sizeGB || 0) - (a.sizeGB || 0);
        });
    
    const summarizerModels = availableModels
        .filter(m => m.function === 'summarizer' || (m.function !== 'embedder' && m.sizeGB && m.sizeGB < 3))
        .sort((a, b) => (a.sizeGB || 0) - (b.sizeGB || 0)); // Smallest first
    
    const embedderModels = availableModels
        .filter(m => m.function === 'embedder')
        .sort((a, b) => (a.sizeGB || 0) - (b.sizeGB || 0)); // Smallest first

    // Find best combination that fits
    let bestMain = null;
    let bestSummarizer = summarizerModels[0] || null;
    let bestEmbedder = embedderModels[0] || null;
    
    const summarizerSize = bestSummarizer?.sizeGB || 0;
    const embedderSize = bestEmbedder?.sizeGB || 0;
    const reservedSize = summarizerSize + embedderSize;
    const mainBudget = vramBudget - reservedSize;

    // Find largest main model that fits
    for (const model of mainModels) {
        if ((model.sizeGB || 0) <= mainBudget) {
            bestMain = model;
            break;
        }
    }

    // If no main model fits, try with even smaller summarizer
    if (!bestMain && mainModels.length > 0) {
        bestMain = mainModels[mainModels.length - 1]; // Smallest main model
    }

    const totalVRAM = (bestMain?.sizeGB || 0) + summarizerSize + embedderSize;
    
    return {
        main: bestMain?.modelKey || bestMain?.id || null,
        summarizer: bestSummarizer?.modelKey || bestSummarizer?.id || null,
        embedder: bestEmbedder?.modelKey || bestEmbedder?.id || null,
        reasoning: `Selected based on ${hardware.gpu?.totalGB || 8}GB VRAM budget. ` +
            `Main: ${bestMain?.modelKey || 'none'} (${bestMain?.sizeGB?.toFixed(1) || 0}GB). ` +
            `Total estimated: ${totalVRAM.toFixed(1)}GB`,
        estimatedVRAM: totalVRAM
    };
}

/**
 * Run optimization to find best model configuration
 */
async function optimizeForHardware() {
    if (optimizerState.running) {
        return { success: false, error: 'Optimization already in progress' };
    }
    
    optimizerState.running = true;
    
    try {
        console.log('[Optimizer] Starting optimization...');
        
        // Step 1: Detect hardware
        const hardware = await detectHardware(true);
        console.log(`[Optimizer] Hardware: ${hardware.gpu?.name || 'No GPU'}, ${hardware.gpu?.totalGB || 0}GB VRAM`);
        
        // Step 2: Get available models
        const { models: availableModels } = await syncModels(true);
        console.log(`[Optimizer] Found ${availableModels.length} available models`);
        
        if (availableModels.length === 0) {
            return { success: false, error: 'No models available' };
        }
        
        // Step 3: Try LLM-based optimization first
        const optimizerModelId = await findOptimizerModel(availableModels);
        let recommendation = null;
        
        if (optimizerModelId) {
            console.log(`[Optimizer] Using LLM for optimization: ${optimizerModelId}`);
            const loaded = await loadOptimizerModel(optimizerModelId);
            
            if (loaded) {
                recommendation = await askLLMForRecommendation(hardware, availableModels);
                await unloadOptimizerModel();
            }
        }
        
        // Step 4: Fall back to heuristics if LLM failed
        if (!recommendation) {
            console.log('[Optimizer] Using heuristic optimization');
            recommendation = heuristicOptimization(hardware, availableModels);
        }
        
        // Validate recommendation
        if (!recommendation.main) {
            return { 
                success: false, 
                error: 'Could not find suitable main model for your hardware' 
            };
        }
        
        console.log(`[Optimizer] Recommendation: main=${recommendation.main}, summarizer=${recommendation.summarizer}, VRAM=${recommendation.estimatedVRAM}GB`);
        
        return {
            success: true,
            recommendation,
            hardware: {
                gpu: hardware.gpu?.name,
                vram: hardware.gpu?.totalGB
            }
        };
        
    } catch (error) {
        console.error('[Optimizer] Optimization failed:', error.message);
        return { success: false, error: error.message };
    } finally {
        optimizerState.running = false;
        // Ensure optimizer model is unloaded
        if (optimizerState.modelId) {
            await unloadOptimizerModel();
        }
    }
}

/**
 * Get optimization status
 */
function getOptimizationStatus() {
    return {
        running: optimizerState.running,
        modelId: optimizerState.modelId
    };
}

module.exports = {
    optimizeForHardware,
    getOptimizationStatus,
    heuristicOptimization
};

