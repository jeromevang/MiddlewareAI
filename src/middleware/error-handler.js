/**
 * Error Handler Middleware
 * Centralized error handling for all routes
 */

/**
 * Error handler middleware
 * @param {Error} err - Error object
 * @param {express.Request} req - Request
 * @param {express.Response} res - Response
 * @param {express.NextFunction} next - Next function
 */
function errorHandler(err, req, res, next) {
    console.error(`[Error] ${req.method} ${req.path}:`, err.message);
    
    // Log stack trace in development
    if (process.env.NODE_ENV !== 'production') {
        console.error(err.stack);
    }

    // Handle specific error types
    if (err.name === 'ValidationError') {
        return res.status(400).json({
            error: 'Validation Error',
            code: 'VALIDATION_ERROR',
            details: err.message
        });
    }

    if (err.name === 'UnauthorizedError') {
        return res.status(401).json({
            error: 'Unauthorized',
            code: 'UNAUTHORIZED',
            details: err.message
        });
    }

    if (err.code === 'ECONNREFUSED') {
        return res.status(503).json({
            error: 'Service Unavailable',
            code: 'SERVICE_UNAVAILABLE',
            details: 'LM Studio connection refused'
        });
    }

    // Default error response
    const statusCode = err.statusCode || err.status || 500;
    res.status(statusCode).json({
        error: err.message || 'Internal Server Error',
        code: err.code || 'INTERNAL_ERROR',
        details: process.env.NODE_ENV !== 'production' ? err.stack : undefined
    });
}

/**
 * Not found handler
 * @param {express.Request} req - Request
 * @param {express.Response} res - Response
 */
function notFoundHandler(req, res) {
    res.status(404).json({
        error: 'Not Found',
        code: 'NOT_FOUND',
        path: req.path
    });
}

/**
 * Async handler wrapper
 * Wraps async route handlers to catch errors
 * @param {Function} fn - Async function
 * @returns {Function} Wrapped function
 */
function asyncHandler(fn) {
    return (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
}

module.exports = {
    errorHandler,
    notFoundHandler,
    asyncHandler
};
