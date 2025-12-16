/**
 * GPU Monitor Service
 * 
 * Interfaces with nvidia-smi to monitor GPU utilization, VRAM usage,
 * and other metrics for the GPU optimization system.
 * 
 * @module gpu_monitor
 */

const { exec } = require('child_process');
const { promisify } = require('util');
const { logger } = require('./logger.js');

const execAsync = promisify(exec);

// Cache for GPU info (doesn't change during runtime)
let cachedGPUInfo = null;

/**
 * Execute nvidia-smi command and parse output
 * @param {string} query - Query string for nvidia-smi
 * @returns {Promise<string>} Raw output from nvidia-smi
 */
async function runNvidiaSmi(query) {
    try {
        const { stdout } = await execAsync(
            `nvidia-smi --query-gpu=${query} --format=csv,noheader,nounits`,
            { timeout: 5000 }
        );
        return stdout.trim();
    } catch (error) {
        logger.error('[GPU Monitor] nvidia-smi failed:', error.message);
        throw new Error(`nvidia-smi not available: ${error.message}`);
    }
}

/**
 * Get static GPU information (name, total VRAM, etc.)
 * Cached after first call since these don't change.
 * @returns {Promise<Object>} GPU info object
 */
async function getGPUInfo() {
    if (cachedGPUInfo) {
        return cachedGPUInfo;
    }

    try {
        const output = await runNvidiaSmi('name,memory.total,driver_version,compute_cap');
        const [name, totalMemory, driverVersion, computeCap] = output.split(', ').map(s => s.trim());
        
        cachedGPUInfo = {
            name,
            totalVRAM: parseFloat(totalMemory) / 1024, // Convert MiB to GB
            totalVRAMMiB: parseFloat(totalMemory),
            driverVersion,
            computeCapability: computeCap,
            available: true
        };
        
        logger.info(`[GPU Monitor] Detected GPU: ${name} with ${cachedGPUInfo.totalVRAM.toFixed(1)}GB VRAM`);
        return cachedGPUInfo;
    } catch (error) {
        cachedGPUInfo = {
            name: 'Unknown',
            totalVRAM: 0,
            totalVRAMMiB: 0,
            driverVersion: 'N/A',
            computeCapability: 'N/A',
            available: false,
            error: error.message
        };
        return cachedGPUInfo;
    }
}

/**
 * Get current GPU utilization percentage
 * @returns {Promise<number>} GPU utilization (0-100)
 */
async function getGPUUtilization() {
    try {
        const output = await runNvidiaSmi('utilization.gpu');
        return parseFloat(output);
    } catch (error) {
        logger.warn('[GPU Monitor] Failed to get GPU utilization:', error.message);
        return -1;
    }
}

/**
 * Get current VRAM usage
 * @returns {Promise<Object>} VRAM usage object with used, free, total in GB
 */
async function getVRAMUsage() {
    try {
        const output = await runNvidiaSmi('memory.used,memory.free,memory.total');
        const [used, free, total] = output.split(', ').map(s => parseFloat(s.trim()));
        
        return {
            usedGB: used / 1024,
            freeGB: free / 1024,
            totalGB: total / 1024,
            usedMiB: used,
            freeMiB: free,
            totalMiB: total,
            usagePercent: (used / total) * 100
        };
    } catch (error) {
        logger.warn('[GPU Monitor] Failed to get VRAM usage:', error.message);
        return {
            usedGB: 0,
            freeGB: 0,
            totalGB: 0,
            usedMiB: 0,
            freeMiB: 0,
            totalMiB: 0,
            usagePercent: 0,
            error: error.message
        };
    }
}

/**
 * Get comprehensive GPU metrics snapshot
 * @returns {Promise<Object>} Full GPU metrics
 */
async function getGPUMetrics() {
    try {
        const output = await runNvidiaSmi(
            'utilization.gpu,utilization.memory,memory.used,memory.free,memory.total,temperature.gpu,power.draw,power.limit'
        );
        const parts = output.split(', ').map(s => s.trim());
        
        return {
            gpuUtilization: parseFloat(parts[0]),
            memoryUtilization: parseFloat(parts[1]),
            vramUsedMiB: parseFloat(parts[2]),
            vramFreeMiB: parseFloat(parts[3]),
            vramTotalMiB: parseFloat(parts[4]),
            vramUsedGB: parseFloat(parts[2]) / 1024,
            vramFreeGB: parseFloat(parts[3]) / 1024,
            vramTotalGB: parseFloat(parts[4]) / 1024,
            temperatureC: parseFloat(parts[5]),
            powerDrawW: parseFloat(parts[6]),
            powerLimitW: parseFloat(parts[7]),
            timestamp: Date.now()
        };
    } catch (error) {
        logger.warn('[GPU Monitor] Failed to get GPU metrics:', error.message);
        return {
            gpuUtilization: -1,
            memoryUtilization: -1,
            vramUsedGB: 0,
            vramFreeGB: 0,
            vramTotalGB: 0,
            error: error.message,
            timestamp: Date.now()
        };
    }
}

/**
 * Monitor GPU metrics during a benchmark operation
 * Samples at regular intervals and returns statistics
 * 
 * @param {number} durationMs - How long to monitor
 * @param {number} intervalMs - Sampling interval (default 100ms)
 * @returns {Promise<Object>} Aggregated metrics with min/max/avg
 */
async function monitorDuringBenchmark(durationMs, intervalMs = 100) {
    const samples = [];
    const startTime = Date.now();
    const endTime = startTime + durationMs;
    
    logger.info(`[GPU Monitor] Starting benchmark monitoring for ${durationMs}ms`);
    
    return new Promise((resolve) => {
        const sampleInterval = setInterval(async () => {
            if (Date.now() >= endTime) {
                clearInterval(sampleInterval);
                
                if (samples.length === 0) {
                    resolve({
                        sampleCount: 0,
                        error: 'No samples collected'
                    });
                    return;
                }
                
                // Calculate statistics
                const gpuUtils = samples.map(s => s.gpuUtilization).filter(v => v >= 0);
                const vramUsed = samples.map(s => s.vramUsedGB).filter(v => v > 0);
                
                const result = {
                    sampleCount: samples.length,
                    durationMs: Date.now() - startTime,
                    gpuUtilization: {
                        min: Math.min(...gpuUtils),
                        max: Math.max(...gpuUtils),
                        avg: gpuUtils.reduce((a, b) => a + b, 0) / gpuUtils.length,
                        samples: gpuUtils
                    },
                    vramUsedGB: {
                        min: Math.min(...vramUsed),
                        max: Math.max(...vramUsed),
                        avg: vramUsed.reduce((a, b) => a + b, 0) / vramUsed.length
                    }
                };
                
                logger.info(`[GPU Monitor] Benchmark complete: ${samples.length} samples, avg GPU: ${result.gpuUtilization.avg.toFixed(1)}%`);
                resolve(result);
                return;
            }
            
            try {
                const metrics = await getGPUMetrics();
                samples.push(metrics);
            } catch (error) {
                // Continue sampling even if one fails
            }
        }, intervalMs);
    });
}

/**
 * Start continuous monitoring with callback
 * Returns a stop function
 * 
 * @param {Function} callback - Called with metrics on each sample
 * @param {number} intervalMs - Sampling interval
 * @returns {Function} Stop function
 */
function startContinuousMonitoring(callback, intervalMs = 500) {
    let running = true;
    
    const monitor = async () => {
        while (running) {
            try {
                const metrics = await getGPUMetrics();
                callback(metrics);
            } catch (error) {
                callback({ error: error.message, timestamp: Date.now() });
            }
            await new Promise(resolve => setTimeout(resolve, intervalMs));
        }
    };
    
    monitor();
    
    return () => {
        running = false;
    };
}

/**
 * Check if NVIDIA GPU monitoring is available
 * @returns {Promise<boolean>}
 */
async function isAvailable() {
    try {
        await runNvidiaSmi('name');
        return true;
    } catch {
        return false;
    }
}

/**
 * Clear the cached GPU info (useful for testing)
 */
function clearCache() {
    cachedGPUInfo = null;
}

module.exports = {
    getGPUInfo,
    getGPUUtilization,
    getVRAMUsage,
    getGPUMetrics,
    monitorDuringBenchmark,
    startContinuousMonitoring,
    isAvailable,
    clearCache
};

