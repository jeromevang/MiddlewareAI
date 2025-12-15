#!/usr/bin/env node

/**
 * Hardware Detection Service
 * 
 * Detects GPU and system RAM to suggest optimal presets
 * and validate model configurations.
 */

const { exec } = require('child_process');
const { promisify } = require('util');
const os = require('os');

const execAsync = promisify(exec);

// Cache for hardware info (doesn't change during runtime)
let hardwareCache = null;

/**
 * Detect NVIDIA GPU information using nvidia-smi
 * @returns {Promise<{name: string, totalGB: number, freeGB: number, usedGB: number} | null>}
 */
async function detectNvidiaGPU() {
    try {
        const { stdout } = await execAsync(
            'nvidia-smi --query-gpu=name,memory.total,memory.free,memory.used --format=csv,noheader,nounits',
            { timeout: 10000 }
        );
        
        const lines = stdout.trim().split('\n');
        if (lines.length === 0) return null;
        
        // Parse first GPU (primary)
        const parts = lines[0].split(',').map(s => s.trim());
        if (parts.length < 4) return null;
        
        const [name, totalMB, freeMB, usedMB] = parts;
        
        return {
            name,
            totalGB: parseFloat(totalMB) / 1024,
            freeGB: parseFloat(freeMB) / 1024,
            usedGB: parseFloat(usedMB) / 1024
        };
    } catch (error) {
        console.warn('[Hardware] nvidia-smi not available or failed:', error.message);
        return null;
    }
}

/**
 * Get system RAM in GB
 * @returns {number}
 */
function getSystemRAM() {
    return os.totalmem() / (1024 * 1024 * 1024);
}

/**
 * Get free system RAM in GB
 * @returns {number}
 */
function getFreeSystemRAM() {
    return os.freemem() / (1024 * 1024 * 1024);
}

/**
 * Detect all hardware information
 * @param {boolean} forceRefresh - Force refresh of cached data
 * @returns {Promise<{gpu: object|null, ram: {totalGB: number, freeGB: number}, suggestedPreset: string}>}
 */
async function detectHardware(forceRefresh = false) {
    if (hardwareCache && !forceRefresh) {
        return hardwareCache;
    }
    
    const gpu = await detectNvidiaGPU();
    const ram = {
        totalGB: getSystemRAM(),
        freeGB: getFreeSystemRAM()
    };
    
    // Suggest preset based on GPU VRAM
    let suggestedPreset = 'low';
    if (gpu) {
        if (gpu.totalGB >= 14) {
            suggestedPreset = 'high';  // RTX 4080/5080 (16GB)
        } else if (gpu.totalGB >= 10) {
            suggestedPreset = 'medium'; // RTX 4070 (12GB)
        } else {
            suggestedPreset = 'low';    // RTX 3060 (8GB) or less
        }
    }
    
    hardwareCache = {
        gpu,
        ram,
        suggestedPreset,
        cpuCores: os.cpus().length,
        platform: os.platform(),
        timestamp: Date.now()
    };
    
    console.log(`[Hardware] Detected: GPU=${gpu?.name || 'None'}, VRAM=${gpu?.totalGB?.toFixed(1) || 0}GB, RAM=${ram.totalGB.toFixed(1)}GB, Suggested=${suggestedPreset}`);
    
    return hardwareCache;
}

/**
 * Get VRAM budget for a given preset
 * @param {string} preset - 'low', 'medium', or 'high'
 * @returns {{budgetGB: number, maxMainModelGB: number, maxSummarizerGB: number}}
 */
function getPresetVRAMBudget(preset) {
    const budgets = {
        low: {
            budgetGB: 6,        // RTX 3060 8GB with 2GB headroom
            maxMainModelGB: 3,
            maxSummarizerGB: 1.5
        },
        medium: {
            budgetGB: 10,       // RTX 4070 12GB with 2GB headroom
            maxMainModelGB: 6,
            maxSummarizerGB: 3
        },
        high: {
            budgetGB: 14,       // RTX 5080 16GB with 2GB headroom
            maxMainModelGB: 10,
            maxSummarizerGB: 5
        }
    };
    
    return budgets[preset] || budgets.low;
}

/**
 * Check if a set of models will fit in available VRAM
 * @param {Array<{sizeGB: number}>} models - Array of models with sizeGB property
 * @param {number} [availableGB] - Available VRAM (auto-detected if not provided)
 * @returns {Promise<{fits: boolean, totalRequired: number, available: number, percentage: number, overflow: number}>}
 */
async function checkModelsWillFit(models, availableGB = null) {
    if (availableGB === null) {
        const hw = await detectHardware();
        availableGB = hw.gpu?.totalGB || 0; // Use total, not free
    }
    
    const totalRequired = models.reduce((sum, m) => sum + (m.sizeGB || 0), 0);
    const fits = totalRequired <= availableGB * 0.9; // 10% safety margin
    const percentage = availableGB > 0 ? (totalRequired / availableGB) * 100 : 0;
    const overflow = Math.max(0, totalRequired - availableGB);
    
    return {
        fits,
        totalRequired,
        available: availableGB,
        percentage: Math.round(percentage * 10) / 10,
        overflow,
        status: percentage <= 80 ? 'good' : percentage <= 100 ? 'warning' : 'overflow'
    };
}

/**
 * Estimate VRAM usage for a model configuration (all roles combined)
 * @param {Object} config - Model configuration with main, summarizer, embedder
 * @param {Array} availableModels - Array of models with sizeGB from model_sync
 * @returns {{main: number, summarizer: number, embedder: number, total: number}}
 */
function estimateConfigVRAM(config, availableModels = []) {
    const findModelSize = (modelId) => {
        if (!modelId) return 0;
        const model = availableModels.find(m => 
            m.modelKey === modelId || 
            m.id === modelId ||
            m.displayName === modelId
        );
        return model?.sizeGB || 0;
    };
    
    const mainSize = findModelSize(config.main);
    const summarizerSize = findModelSize(config.summarizer);
    const embedderSize = findModelSize(config.embedder);
    
    return {
        main: mainSize,
        summarizer: summarizerSize,
        embedder: embedderSize,
        total: mainSize + summarizerSize + embedderSize
    };
}

/**
 * Get star rating (1-5) based on model size
 * @param {number} sizeGB - Model size in GB
 * @returns {{stars: number, label: string}}
 */
function getModelStarRating(sizeGB) {
    if (!sizeGB || sizeGB <= 0) {
        return { stars: 0, label: 'Unknown' };
    }
    
    if (sizeGB < 1) {
        return { stars: 1, label: 'Lightweight' };
    } else if (sizeGB < 3) {
        return { stars: 2, label: 'Fast' };
    } else if (sizeGB < 6) {
        return { stars: 3, label: 'Balanced' };
    } else if (sizeGB < 10) {
        return { stars: 4, label: 'Quality' };
    } else {
        return { stars: 5, label: 'Premium' };
    }
}

/**
 * Get role descriptions for UI display
 * @returns {Object} - Role descriptions
 */
function getRoleDescriptions() {
    return {
        main: {
            name: 'Main Model',
            description: 'Handles chat completions and tool calling. This is the primary AI that responds to your queries.',
            recommended: 'Models with tool use capability (like Qwen, Llama, etc.)'
        },
        summarizer: {
            name: 'Summarizer',
            description: 'Compresses conversation history to maintain context without exceeding token limits.',
            recommended: 'Smaller, fast models (1-3B params) with good instruction following'
        },
        embedder: {
            name: 'Embedder',
            description: 'Creates vector embeddings for semantic search in RAG (Retrieval-Augmented Generation).',
            recommended: 'Embedding models like MiniLM, Nomic, or similar'
        }
    };
}

/**
 * Invalidate the hardware cache (useful after model load/unload)
 */
function invalidateHardwareCache() {
    hardwareCache = null;
}

// ============================================================================
// VRAM-Aware Context Calculation
// ============================================================================

// Minimum context lengths by role
const MIN_CONTEXT = {
    main: 8192,        // 8K minimum for coding tasks
    summarizer: 4096,  // 4K fixed for summarizers
    embedder: 8192     // Model's native (Jina is 8K)
};

// Approximate VRAM per 8K context tokens (varies by model architecture)
const VRAM_PER_8K_CONTEXT = 0.5; // ~0.5GB per 8K tokens

/**
 * Calculate optimal context length based on available VRAM.
 * @param {Object} params - Calculation parameters
 * @param {number} params.modelSizeGB - Model size in GB
 * @param {number} params.modelMaxContext - Model's maximum supported context
 * @param {string} params.role - 'main', 'summarizer', or 'embedder'
 * @param {number} [params.availableVRAM] - Available VRAM in GB (auto-detected if not provided)
 * @returns {Promise<{context: number, fits: boolean, warning?: string}>}
 */
async function calculateOptimalContext({ modelSizeGB, modelMaxContext, role, availableVRAM = null }) {
    // Fixed context for summarizers and embedders
    if (role === 'summarizer') {
        return { context: MIN_CONTEXT.summarizer, fits: true };
    }
    if (role === 'embedder') {
        return { context: modelMaxContext || MIN_CONTEXT.embedder, fits: true };
    }
    
    // Main model: calculate based on VRAM
    if (availableVRAM === null) {
        const hw = await detectHardware();
        availableVRAM = hw.gpu?.totalGB || 0;
    }
    
    // Reserve: 2GB headroom + model size + space for other models
    const reservedVRAM = 2 + modelSizeGB;
    const availableForContext = Math.max(0, availableVRAM - reservedVRAM);
    
    // Calculate how much context we can afford
    const contextChunks = Math.floor(availableForContext / VRAM_PER_8K_CONTEXT);
    const calculatedContext = contextChunks * 8192;
    
    // Apply minimum and maximum bounds
    const minContext = MIN_CONTEXT.main;
    const maxContext = modelMaxContext || 128000;
    
    let finalContext = Math.max(minContext, Math.min(maxContext, calculatedContext));
    let fits = true;
    let warning = null;
    
    // Check if we can't even fit minimum context
    if (calculatedContext < minContext) {
        fits = false;
        warning = `Model (${modelSizeGB.toFixed(1)}GB) is too large for ${availableVRAM.toFixed(1)}GB VRAM with minimum ${minContext} context. Consider a smaller model.`;
        finalContext = minContext; // Still try with minimum
    }
    
    return { context: finalContext, fits, warning };
}

// ============================================================================
// Real-Time Resource Monitoring
// ============================================================================

/**
 * Get current CPU usage percentage.
 * Uses load average on Unix, processor time on Windows.
 * @returns {number} - CPU usage percentage (0-100)
 */
function getCPUUsage() {
    const cpus = os.cpus();
    const numCPUs = cpus.length;
    
    // Calculate average idle time across all CPUs
    let totalIdle = 0;
    let totalTick = 0;
    
    for (const cpu of cpus) {
        for (const type in cpu.times) {
            totalTick += cpu.times[type];
        }
        totalIdle += cpu.times.idle;
    }
    
    const idlePercent = (totalIdle / totalTick) * 100;
    const usagePercent = 100 - idlePercent;
    
    return Math.round(usagePercent * 10) / 10;
}

/**
 * Get real-time resource usage (CPU, RAM, VRAM).
 * @returns {Promise<{cpu: Object, ram: Object, vram: Object}>}
 */
async function getRealtimeResources() {
    // CPU
    const cpuUsage = getCPUUsage();
    const cpuCores = os.cpus().length;
    
    // RAM
    const totalRAM = os.totalmem() / (1024 * 1024 * 1024);
    const freeRAM = os.freemem() / (1024 * 1024 * 1024);
    const usedRAM = totalRAM - freeRAM;
    
    // VRAM (refresh from nvidia-smi)
    const gpu = await detectNvidiaGPU();
    
    return {
        cpu: {
            usagePercent: cpuUsage,
            cores: cpuCores
        },
        ram: {
            totalGB: Math.round(totalRAM * 10) / 10,
            usedGB: Math.round(usedRAM * 10) / 10,
            freeGB: Math.round(freeRAM * 10) / 10,
            usagePercent: Math.round((usedRAM / totalRAM) * 1000) / 10
        },
        vram: gpu ? {
            name: gpu.name,
            totalGB: Math.round(gpu.totalGB * 10) / 10,
            usedGB: Math.round(gpu.usedGB * 10) / 10,
            freeGB: Math.round(gpu.freeGB * 10) / 10,
            usagePercent: Math.round((gpu.usedGB / gpu.totalGB) * 1000) / 10
        } : null,
        timestamp: Date.now()
    };
}

module.exports = {
    detectHardware,
    detectNvidiaGPU,
    getSystemRAM,
    getFreeSystemRAM,
    getPresetVRAMBudget,
    checkModelsWillFit,
    estimateConfigVRAM,
    getModelStarRating,
    getRoleDescriptions,
    invalidateHardwareCache,
    calculateOptimalContext,
    getCPUUsage,
    getRealtimeResources,
    MIN_CONTEXT
};

