/**
 * Logging Middleware
 * Request/response logging
 */

/**
 * Create request logging middleware
 * @param {Function} appendLog - Log function
 * @returns {Function} Middleware
 */
function createLoggingMiddleware(appendLog) {
    return (req, res, next) => {
        const start = Date.now();
        
        // Log request
        const logEntry = {
            method: req.method,
            path: req.path,
            timestamp: new Date().toISOString()
        };

        // Log response on finish
        res.on('finish', () => {
            const duration = Date.now() - start;
            const level = res.statusCode >= 400 ? 'warn' : 'debug';
            
            if (appendLog && typeof appendLog === 'function') {
                appendLog(`${req.method} ${req.path} ${res.statusCode} ${duration}ms`, level);
            }
        });

        next();
    };
}

module.exports = { createLoggingMiddleware };
