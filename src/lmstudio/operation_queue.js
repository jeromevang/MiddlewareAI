/**
 * LM Studio Operation Queue
 * 
 * Provides rate-limited, serialized access to LM Studio operations
 * to prevent 429 errors and ensure stable model loading/unloading.
 * 
 * Uses p-queue to ensure only one model operation happens at a time
 * with configurable delays between operations.
 */

const PQueue = require('p-queue').default;

// Create operation queue with strict concurrency limits
// interval: 1000ms (1 second between operations)
// intervalCap: 1 (only 1 operation per interval)
// concurrency: 1 (only 1 concurrent operation)
const modelOperationQueue = new PQueue({
    concurrency: 1,
    interval: 500,     // 500ms minimum between operations
    intervalCap: 1,    // Max 1 operation per interval
    autoStart: true,
    throwOnTimeout: true,
    timeout: 120000    // 2 minute timeout per operation
});

// Separate queue for read operations (status checks, listing)
// These are less rate-limited as they don't affect LM Studio state
const readOperationQueue = new PQueue({
    concurrency: 2,
    interval: 100,
    intervalCap: 2,
    autoStart: true,
    throwOnTimeout: true,
    timeout: 30000     // 30 second timeout for read operations
});

// Queue statistics
let stats = {
    modelOperations: {
        queued: 0,
        completed: 0,
        failed: 0,
        lastOperation: null
    },
    readOperations: {
        queued: 0,
        completed: 0,
        failed: 0
    }
};

/**
 * Queue a model operation (load/unload)
 * These are serialized to prevent rate limiting
 * 
 * @param {Function} operation - Async function to execute
 * @param {Object} options - Options
 * @param {string} options.name - Name of the operation for logging
 * @param {number} options.priority - Priority (higher = sooner)
 * @returns {Promise<any>} - Result of the operation
 */
async function queueModelOperation(operation, options = {}) {
    const { name = 'unknown', priority = 0 } = options;
    
    stats.modelOperations.queued++;
    console.log(`[OpQueue] Queuing model operation: ${name} (queue size: ${modelOperationQueue.size}, pending: ${modelOperationQueue.pending})`);
    
    try {
        const result = await modelOperationQueue.add(operation, { priority });
        stats.modelOperations.completed++;
        stats.modelOperations.lastOperation = { name, timestamp: Date.now(), success: true };
        console.log(`[OpQueue] Completed model operation: ${name}`);
        return result;
    } catch (error) {
        stats.modelOperations.failed++;
        stats.modelOperations.lastOperation = { name, timestamp: Date.now(), success: false, error: error.message };
        console.error(`[OpQueue] Failed model operation: ${name}`, error.message);
        throw error;
    }
}

/**
 * Queue a read operation (status check, model listing)
 * These can run more concurrently
 * 
 * @param {Function} operation - Async function to execute
 * @param {Object} options - Options
 * @param {string} options.name - Name of the operation for logging
 * @returns {Promise<any>} - Result of the operation
 */
async function queueReadOperation(operation, options = {}) {
    const { name = 'unknown' } = options;
    
    stats.readOperations.queued++;
    
    try {
        const result = await readOperationQueue.add(operation);
        stats.readOperations.completed++;
        return result;
    } catch (error) {
        stats.readOperations.failed++;
        console.error(`[OpQueue] Failed read operation: ${name}`, error.message);
        throw error;
    }
}

/**
 * Load a model with queuing
 * @param {Function} loadFn - Function that performs the actual load
 * @param {string} modelId - Model identifier
 * @param {Object} options - Load options
 */
async function queuedLoadModel(loadFn, modelId, options = {}) {
    return queueModelOperation(
        () => loadFn(modelId, options),
        { name: `load:${modelId}`, priority: options.priority || 1 }
    );
}

/**
 * Unload a model with queuing
 * @param {Function} unloadFn - Function that performs the actual unload
 * @param {string} modelId - Model identifier
 */
async function queuedUnloadModel(unloadFn, modelId) {
    return queueModelOperation(
        () => unloadFn(modelId),
        { name: `unload:${modelId}`, priority: 0 }
    );
}

/**
 * Get queue statistics
 */
function getQueueStats() {
    return {
        ...stats,
        modelQueue: {
            size: modelOperationQueue.size,
            pending: modelOperationQueue.pending,
            isPaused: modelOperationQueue.isPaused
        },
        readQueue: {
            size: readOperationQueue.size,
            pending: readOperationQueue.pending,
            isPaused: readOperationQueue.isPaused
        }
    };
}

/**
 * Clear the model operation queue (useful for emergency stops)
 */
function clearModelQueue() {
    modelOperationQueue.clear();
    console.log('[OpQueue] Model operation queue cleared');
}

/**
 * Pause model operations
 */
function pauseModelQueue() {
    modelOperationQueue.pause();
    console.log('[OpQueue] Model operation queue paused');
}

/**
 * Resume model operations
 */
function resumeModelQueue() {
    modelOperationQueue.start();
    console.log('[OpQueue] Model operation queue resumed');
}

/**
 * Wait for all pending model operations to complete
 */
async function waitForModelOperations() {
    await modelOperationQueue.onIdle();
}

module.exports = {
    queueModelOperation,
    queueReadOperation,
    queuedLoadModel,
    queuedUnloadModel,
    getQueueStats,
    clearModelQueue,
    pauseModelQueue,
    resumeModelQueue,
    waitForModelOperations,
    modelOperationQueue,
    readOperationQueue
};

