/**
 * GPU Optimizer Service
 * 
 * Optimizes GPU offload settings for loaded model combinations.
 * Uses smart initial guesses based on VRAM, then iteratively refines
 * based on actual performance (tokens/second) measurements.
 * 
 * @module gpu_optimizer
 */

const crypto = require('crypto');
const { logger } = require('./logger.js');
const { getGPUInfo, getVRAMUsage, monitorDuringBenchmark, getGPUMetrics } = require('./gpu_monitor.js');
const { getConfig } = require('./config.js');

// In-memory optimization state
let optimizationState = {
    isOptimizing: false,
    currentModel: null,
    iteration: 0,
    maxIterations: 4,
    progress: 0,
    message: '',
    results: {}
};

// Callbacks for status updates (WebSocket broadcasting)
let statusCallback = null;

/**
 * Set callback for status updates
 * @param {Function} callback 
 */
function setStatusCallback(callback) {
    statusCallback = callback;
}

/**
 * Broadcast optimization status
 */
function broadcastStatus() {
    if (statusCallback) {
        statusCallback({
            type: 'gpu-optimization-status',
            payload: getOptimizationStatus()
        });
    }
}

/**
 * Update optimization state and broadcast
 * @param {Object} updates 
 */
function updateState(updates) {
    optimizationState = { ...optimizationState, ...updates };
    broadcastStatus();
}

/**
 * Get current optimization status
 * @returns {Object}
 */
function getOptimizationStatus() {
    return { ...optimizationState };
}

/**
 * Generate a hash for a model combination
 * @param {Array<string>} modelIds - Sorted array of model IDs
 * @returns {string} Hash string
 */
function generateCombinationHash(modelIds) {
    const sorted = [...modelIds].sort();
    return crypto.createHash('md5').update(sorted.join('|')).digest('hex').substring(0, 16);
}

/**
 * Calculate smart initial GPU offload based on VRAM
 * @param {number} modelSizeGB - Estimated model size in GB
 * @param {number} availableVRAM - Available VRAM in GB
 * @param {number} otherModelsVRAM - VRAM used by other loaded models
 * @returns {number} Initial GPU offload (0.0 - 1.0)
 */
function calculateInitialGPU(modelSizeGB, availableVRAM, otherModelsVRAM = 0) {
    const config = getConfig();
    const headroom = config.gpuOptimization?.vramHeadroomGB || 1.5;
    
    const usableVRAM = availableVRAM - headroom - otherModelsVRAM;
    
    if (usableVRAM <= 0) {
        logger.warn(`[GPU Optimizer] No usable VRAM (available: ${availableVRAM}GB, headroom: ${headroom}GB, other: ${otherModelsVRAM}GB)`);
        return 0.1; // Minimal GPU offload
    }
    
    // Calculate what fraction of the model can fit
    const initialGPU = Math.min(1.0, Math.max(0.1, usableVRAM / modelSizeGB));
    
    // Round to 0.05 increments for cleaner values
    const rounded = Math.round(initialGPU * 20) / 20;
    
    logger.info(`[GPU Optimizer] Smart initial GPU: ${rounded} (model: ${modelSizeGB}GB, usable VRAM: ${usableVRAM.toFixed(1)}GB)`);
    return rounded;
}

/**
 * Estimate model size from metadata or filename
 * @param {Object} modelInfo - Model information object
 * @returns {number} Estimated size in GB
 */
function estimateModelSize(modelInfo) {
    // If we have explicit size info, use it
    if (modelInfo.sizeGB) {
        return modelInfo.sizeGB;
    }
    
    // Try to extract from filename (e.g., "7b", "13b", "70b")
    const modelId = modelInfo.id || modelInfo.modelKey || '';
    const sizeMatch = modelId.match(/(\d+\.?\d*)b/i);
    
    if (sizeMatch) {
        const paramBillions = parseFloat(sizeMatch[1]);
        // Rough estimate: ~0.5GB per billion parameters for Q4 quantization
        // Adjust based on quantization if known
        let bytesPerParam = 0.5; // Default Q4
        
        if (modelId.includes('q8') || modelId.includes('Q8')) {
            bytesPerParam = 1.0;
        } else if (modelId.includes('q2') || modelId.includes('Q2')) {
            bytesPerParam = 0.25;
        } else if (modelId.includes('q6') || modelId.includes('Q6')) {
            bytesPerParam = 0.75;
        }
        
        return paramBillions * bytesPerParam;
    }
    
    // Default estimate for unknown models
    logger.warn(`[GPU Optimizer] Could not estimate size for ${modelId}, using default 4GB`);
    return 4.0;
}

/**
 * Run a benchmark on a model and measure performance
 * @param {string} modelId - Model to benchmark
 * @param {string} role - Model role (main, summarizer)
 * @param {Object} options - Benchmark options
 * @returns {Promise<Object>} Benchmark results
 */
async function runBenchmark(modelId, role, options = {}) {
    const config = getConfig();
    const contextSizes = config.gpuOptimization?.contextSizes || { main: 16384, summarizer: 4096 };
    const benchmarkPrompts = config.gpuOptimization?.benchmarkPrompts || 3;
    
    // Select context size based on role
    const contextSize = role === 'main' ? contextSizes.main : contextSizes.summarizer;
    
    // Generate test prompts based on role
    const testPrompts = generateTestPrompts(role, benchmarkPrompts);
    
    logger.info(`[GPU Optimizer] Running benchmark for ${modelId} (role: ${role}, context: ${contextSize})`);
    
    const results = [];
    let totalTokens = 0;
    let totalTimeMs = 0;
    
    // Warm-up run (discard results)
    try {
        await sendTestCompletion(modelId, testPrompts[0], contextSize);
        logger.info(`[GPU Optimizer] Warm-up complete for ${modelId}`);
    } catch (error) {
        logger.warn(`[GPU Optimizer] Warm-up failed for ${modelId}:`, error.message);
    }
    
    // Start GPU monitoring
    const monitorPromise = monitorDuringBenchmark(30000, 100); // 30 second max
    
    // Run actual benchmarks
    for (let i = 0; i < benchmarkPrompts; i++) {
        try {
            const startTime = Date.now();
            const response = await sendTestCompletion(modelId, testPrompts[i], contextSize);
            const endTime = Date.now();
            
            const timeMs = endTime - startTime;
            const tokens = response.usage?.completion_tokens || estimateTokens(response.content);
            
            results.push({
                promptIndex: i,
                timeMs,
                tokens,
                tokensPerSecond: (tokens / timeMs) * 1000
            });
            
            totalTokens += tokens;
            totalTimeMs += timeMs;
            
            logger.info(`[GPU Optimizer] Benchmark ${i + 1}/${benchmarkPrompts}: ${tokens} tokens in ${timeMs}ms (${((tokens / timeMs) * 1000).toFixed(1)} t/s)`);
        } catch (error) {
            logger.error(`[GPU Optimizer] Benchmark ${i + 1} failed:`, error.message);
        }
    }
    
    // Get GPU metrics from monitoring
    const gpuMetrics = await monitorPromise;
    
    if (results.length === 0) {
        throw new Error('All benchmark attempts failed');
    }
    
    const avgTokensPerSecond = (totalTokens / totalTimeMs) * 1000;
    
    return {
        modelId,
        role,
        benchmarkCount: results.length,
        totalTokens,
        totalTimeMs,
        avgTokensPerSecond,
        gpuUtilization: gpuMetrics.gpuUtilization?.avg || -1,
        gpuUtilizationMax: gpuMetrics.gpuUtilization?.max || -1,
        vramUsedGB: gpuMetrics.vramUsedGB?.avg || 0,
        results
    };
}

/**
 * Generate test prompts based on role
 * @param {string} role 
 * @param {number} count 
 * @returns {Array<string>}
 */
function generateTestPrompts(role, count) {
    const prompts = [];
    
    if (role === 'main') {
        // Longer coding-focused prompts for main model
        prompts.push(
            'Write a JavaScript function that implements a binary search tree with insert, delete, and search operations. Include proper error handling and comments.',
            'Explain how async/await works in JavaScript and provide 3 practical examples showing different use cases including error handling.',
            'Create a React component that implements a sortable, filterable data table with pagination. Use TypeScript and include prop types.',
            'Write a Python class that implements a thread-safe singleton pattern with lazy initialization. Explain the design decisions.',
            'Implement a REST API endpoint in Node.js/Express that handles file uploads with validation, virus scanning, and cloud storage integration.'
        );
    } else {
        // Shorter summarization prompts
        prompts.push(
            'Summarize the following code:\n```javascript\nfunction quickSort(arr) {\n  if (arr.length <= 1) return arr;\n  const pivot = arr[0];\n  const left = arr.slice(1).filter(x => x < pivot);\n  const right = arr.slice(1).filter(x => x >= pivot);\n  return [...quickSort(left), pivot, ...quickSort(right)];\n}\n```',
            'Explain this function in one paragraph:\n```python\ndef memoize(func):\n    cache = {}\n    def wrapper(*args):\n        if args not in cache:\n            cache[args] = func(*args)\n        return cache[args]\n    return wrapper\n```',
            'Summarize the purpose of this code:\n```typescript\ninterface Observer<T> {\n  next: (value: T) => void;\n  error: (err: Error) => void;\n  complete: () => void;\n}\n```',
            'Describe what this SQL query does:\nSELECT u.name, COUNT(o.id) as order_count FROM users u LEFT JOIN orders o ON u.id = o.user_id GROUP BY u.id HAVING order_count > 5 ORDER BY order_count DESC LIMIT 10;',
            'Summarize this regex pattern: /^(?=.*[a-z])(?=.*[A-Z])(?=.*\\d)(?=.*[@$!%*?&])[A-Za-z\\d@$!%*?&]{8,}$/'
        );
    }
    
    return prompts.slice(0, count);
}

/**
 * Send a test completion request
 * @param {string} modelId 
 * @param {string} prompt 
 * @param {number} maxTokens 
 * @returns {Promise<Object>}
 */
async function sendTestCompletion(modelId, prompt, maxTokens = 500) {
    const config = getConfig();
    const lmStudioUrl = config.lmstudio?.url || 'http://localhost:1234';
    
    const response = await fetch(`${lmStudioUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: modelId,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: maxTokens,
            temperature: 0.7,
            stream: false
        })
    });
    
    if (!response.ok) {
        throw new Error(`LM Studio request failed: ${response.status}`);
    }
    
    const data = await response.json();
    return {
        content: data.choices?.[0]?.message?.content || '',
        usage: data.usage
    };
}

/**
 * Estimate tokens from text (rough estimate)
 * @param {string} text 
 * @returns {number}
 */
function estimateTokens(text) {
    // Rough estimate: ~4 characters per token for English
    return Math.ceil((text || '').length / 4);
}

/**
 * Optimize a single model's GPU offload setting
 * @param {Object} model - Model info { id, role, currentGPU, sizeGB }
 * @param {number} availableVRAM - Available VRAM for this model
 * @returns {Promise<Object>} Optimal settings
 */
async function optimizeSingleModel(model, availableVRAM) {
    const config = getConfig();
    const maxIterations = config.gpuOptimization?.maxIterationsPerModel || 4;
    
    const { id: modelId, role, sizeGB } = model;
    let currentGPU = calculateInitialGPU(sizeGB, availableVRAM);
    let bestResult = null;
    let bestGPU = currentGPU;
    
    logger.info(`[GPU Optimizer] Optimizing ${modelId} (role: ${role}, size: ${sizeGB}GB, initial GPU: ${currentGPU})`);
    
    for (let iteration = 0; iteration < maxIterations; iteration++) {
        updateState({
            currentModel: modelId,
            iteration: iteration + 1,
            maxIterations,
            message: `Testing ${modelId} with GPU=${currentGPU.toFixed(2)} (iteration ${iteration + 1}/${maxIterations})`
        });
        
        // Load model with current GPU setting
        try {
            await reloadModelWithGPU(modelId, currentGPU, role);
        } catch (error) {
            logger.error(`[GPU Optimizer] Failed to reload ${modelId}:`, error.message);
            break;
        }
        
        // Wait for model to stabilize
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Run benchmark
        let benchmarkResult;
        try {
            benchmarkResult = await runBenchmark(modelId, role);
        } catch (error) {
            logger.error(`[GPU Optimizer] Benchmark failed for ${modelId}:`, error.message);
            break;
        }
        
        benchmarkResult.gpuOffload = currentGPU;
        
        logger.info(`[GPU Optimizer] Iteration ${iteration + 1}: GPU=${currentGPU.toFixed(2)}, ${benchmarkResult.avgTokensPerSecond.toFixed(1)} t/s, GPU util=${benchmarkResult.gpuUtilization.toFixed(1)}%`);
        
        // Check if this is the best result so far
        const improved = !bestResult || benchmarkResult.avgTokensPerSecond > bestResult.avgTokensPerSecond;
        
        if (improved) {
            bestResult = benchmarkResult;
            bestGPU = currentGPU;
        }
        
        // Decide next GPU setting
        const gpuUtil = benchmarkResult.gpuUtilization;
        
        if (gpuUtil < 0) {
            // GPU monitoring failed, use conservative approach
            logger.warn(`[GPU Optimizer] GPU monitoring unavailable, stopping optimization`);
            break;
        }
        
        if (gpuUtil > 95) {
            // Memory pressure - decrease and stop
            logger.info(`[GPU Optimizer] GPU > 95%, potential memory pressure, keeping best setting`);
            break;
        }
        
        if (!improved) {
            // No improvement, stop
            logger.info(`[GPU Optimizer] No improvement, keeping best setting`);
            break;
        }
        
        if (gpuUtil < 85 && currentGPU < 0.95) {
            // Room for improvement, increase GPU
            const newGPU = Math.min(1.0, currentGPU + 0.15);
            if (newGPU === currentGPU) {
                break; // Already at max
            }
            currentGPU = newGPU;
        } else {
            // GPU utilization is good (85-95%), stop
            logger.info(`[GPU Optimizer] GPU utilization optimal (${gpuUtil.toFixed(1)}%), stopping`);
            break;
        }
    }
    
    // Ensure model is loaded with best settings
    if (bestGPU !== currentGPU && bestResult) {
        await reloadModelWithGPU(modelId, bestGPU, role);
    }
    
    return {
        modelId,
        role,
        optimalGPU: bestGPU,
        tokensPerSecond: bestResult?.avgTokensPerSecond || 0,
        gpuUtilization: bestResult?.gpuUtilization || 0,
        vramUsedGB: bestResult?.vramUsedGB || 0,
        iterations: optimizationState.iteration
    };
}

/**
 * Reload a model with specific GPU offload setting
 * @param {string} modelId 
 * @param {number} gpu 
 * @param {string} role 
 */
async function reloadModelWithGPU(modelId, gpu, role) {
    const { unloadModel, openModel } = require('./lmstudio/model_manager.js');
    const { getRoleDefaults } = require('./lmstudio/model_sync.js');
    
    logger.info(`[GPU Optimizer] Reloading ${modelId} with GPU=${gpu.toFixed(2)}`);
    
    // Unload current instance
    try {
        await unloadModel(modelId);
        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for unload
    } catch (error) {
        // Model might not be loaded, continue
    }
    
    // Get role defaults for context length
    const roleDefaults = getRoleDefaults(role);
    
    // Load with new GPU setting
    await openModel(modelId, {
        role,
        gpu,
        contextLength: roleDefaults.contextLength
    });
}

/**
 * Optimize all loaded models as a combination
 * @param {Array<Object>} models - Array of model info objects
 * @returns {Promise<Object>} Optimization results
 */
async function optimizeCombination(models) {
    if (optimizationState.isOptimizing) {
        throw new Error('Optimization already in progress');
    }
    
    const gpuInfo = await getGPUInfo();
    if (!gpuInfo.available) {
        throw new Error('GPU not available for optimization');
    }
    
    const totalVRAM = gpuInfo.totalVRAM;
    const config = getConfig();
    const headroom = config.gpuOptimization?.vramHeadroomGB || 1.5;
    
    logger.info(`[GPU Optimizer] Starting combination optimization for ${models.length} models`);
    logger.info(`[GPU Optimizer] Total VRAM: ${totalVRAM.toFixed(1)}GB, Headroom: ${headroom}GB`);
    
    updateState({
        isOptimizing: true,
        progress: 0,
        message: 'Starting optimization...',
        results: {}
    });
    
    try {
        // Sort models by size (largest first - they get VRAM priority)
        const sortedModels = [...models].sort((a, b) => {
            const sizeA = a.sizeGB || estimateModelSize(a);
            const sizeB = b.sizeGB || estimateModelSize(b);
            return sizeB - sizeA;
        });
        
        let remainingVRAM = totalVRAM - headroom;
        const optimalSettings = {};
        
        for (let i = 0; i < sortedModels.length; i++) {
            const model = sortedModels[i];
            model.sizeGB = model.sizeGB || estimateModelSize(model);
            
            updateState({
                progress: Math.round((i / sortedModels.length) * 100),
                message: `Optimizing ${model.id} (${i + 1}/${sortedModels.length})`
            });
            
            const result = await optimizeSingleModel(model, remainingVRAM);
            optimalSettings[model.id] = result;
            
            // Update remaining VRAM for next model
            remainingVRAM -= result.vramUsedGB || (model.sizeGB * result.optimalGPU);
        }
        
        // Generate combination hash
        const modelIds = models.map(m => m.id);
        const combinationHash = generateCombinationHash(modelIds);
        
        const finalResult = {
            combinationHash,
            models: modelIds,
            settings: optimalSettings,
            totalVRAMUsed: totalVRAM - remainingVRAM,
            calibratedAt: new Date().toISOString(),
            gpuName: gpuInfo.name
        };
        
        // Save to cache
        await saveToCacheDB(finalResult);
        
        updateState({
            isOptimizing: false,
            progress: 100,
            message: 'Optimization complete',
            results: optimalSettings
        });
        
        logger.info(`[GPU Optimizer] Optimization complete. Total VRAM used: ${(totalVRAM - remainingVRAM).toFixed(1)}GB`);
        
        return finalResult;
    } catch (error) {
        updateState({
            isOptimizing: false,
            progress: 0,
            message: `Optimization failed: ${error.message}`,
            results: {}
        });
        throw error;
    }
}

/**
 * Get cached settings for a model combination
 * @param {Array<string>} modelIds 
 * @returns {Promise<Object|null>}
 */
async function getCachedSettings(modelIds) {
    const combinationHash = generateCombinationHash(modelIds);
    return await loadFromCacheDB(combinationHash);
}

/**
 * Apply cached settings to loaded models
 * @param {Object} cachedSettings 
 * @returns {Promise<Object>}
 */
async function applyCachedSettings(cachedSettings) {
    logger.info(`[GPU Optimizer] Applying cached settings from ${cachedSettings.calibratedAt}`);
    
    const results = {};
    
    for (const [modelId, settings] of Object.entries(cachedSettings.settings)) {
        try {
            await reloadModelWithGPU(modelId, settings.optimalGPU, settings.role);
            results[modelId] = { success: true, gpu: settings.optimalGPU };
        } catch (error) {
            results[modelId] = { success: false, error: error.message };
        }
    }
    
    return results;
}

/**
 * Clear cached settings for a combination
 * @param {string} combinationHash 
 */
async function clearCachedSettings(combinationHash) {
    await deleteFromCacheDB(combinationHash);
}

/**
 * Manually set GPU offload for a model (override)
 * @param {string} modelId 
 * @param {number} gpu 
 * @param {string} role 
 */
async function setManualGPU(modelId, gpu, role) {
    logger.info(`[GPU Optimizer] Manual GPU override: ${modelId} = ${gpu}`);
    await reloadModelWithGPU(modelId, gpu, role);
    
    // Update cache if exists
    const { listLoadedModels } = require('./lmstudio/model_manager.js');
    const loaded = await listLoadedModels();
    const modelIds = loaded.map(m => m.id);
    const hash = generateCombinationHash(modelIds);
    
    const cached = await loadFromCacheDB(hash);
    if (cached && cached.settings[modelId]) {
        cached.settings[modelId].optimalGPU = gpu;
        cached.settings[modelId].manual = true;
        await saveToCacheDB(cached);
    }
}

// =============================================================================
// Cache Database Operations (using SQLite)
// =============================================================================

let cacheDB = null;

/**
 * Initialize cache database connection
 */
async function initCacheDB() {
    if (cacheDB) return;
    
    const { SQLiteCacheManager } = require('./sqlite_cache.js');
    cacheDB = new SQLiteCacheManager();
    await cacheDB.ensureGPUOptimizationTable();
}

/**
 * Save optimization result to cache
 * @param {Object} result 
 */
async function saveToCacheDB(result) {
    await initCacheDB();
    await cacheDB.saveGPUOptimization(result);
}

/**
 * Load from cache
 * @param {string} combinationHash 
 * @returns {Promise<Object|null>}
 */
async function loadFromCacheDB(combinationHash) {
    await initCacheDB();
    return await cacheDB.getGPUOptimization(combinationHash);
}

/**
 * Delete from cache
 * @param {string} combinationHash 
 */
async function deleteFromCacheDB(combinationHash) {
    await initCacheDB();
    await cacheDB.deleteGPUOptimization(combinationHash);
}

/**
 * Get all cached optimizations
 * @returns {Promise<Array>}
 */
async function getAllCached() {
    await initCacheDB();
    return await cacheDB.getAllGPUOptimizations();
}

module.exports = {
    // Core optimization
    optimizeCombination,
    optimizeSingleModel,
    getCachedSettings,
    applyCachedSettings,
    clearCachedSettings,
    setManualGPU,
    
    // Utilities
    calculateInitialGPU,
    estimateModelSize,
    generateCombinationHash,
    runBenchmark,
    
    // Status
    getOptimizationStatus,
    setStatusCallback,
    
    // Cache operations
    getAllCached,
    initCacheDB
};

