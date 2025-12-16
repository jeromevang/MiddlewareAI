#!/usr/bin/env node

/**
 * Centralized Logging System
 *
 * Uses Winston for structured logging with multiple transports:
 * - Console: Development logs
 * - Daily rotating files: Production logs
 * - Error file: Separate error logging
 *
 * Log levels: error, warn, info, http, verbose, debug, silly
 */

const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');

// Create logs directory if it doesn't exist
const fs = require('fs');
const logsDir = path.join(__dirname, '../logs');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
}

// Custom log format
const customFormat = winston.format.combine(
    winston.format.timestamp({
        format: 'YYYY-MM-DD HH:mm:ss'
    }),
    winston.format.errors({ stack: true }),
    winston.format.json(),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
        const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
        return `${timestamp} [${level.toUpperCase()}]: ${message}${metaStr}`;
    })
);

// Console transport for development
const consoleTransport = new winston.transports.Console({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
    ),
    handleExceptions: true,
    handleRejections: true
});

// Daily rotating file transport for all logs
const allLogsTransport = new DailyRotateFile({
    filename: path.join(logsDir, 'middleware-%DATE%.log'),
    datePattern: 'YYYY-MM-DD',
    maxSize: '20m',
    maxFiles: '14d',
    level: 'info',
    format: customFormat
});

// Daily rotating file transport for errors only
const errorLogsTransport = new DailyRotateFile({
    filename: path.join(logsDir, 'middleware-error-%DATE%.log'),
    datePattern: 'YYYY-MM-DD',
    maxSize: '20m',
    maxFiles: '30d',
    level: 'error',
    format: customFormat
});

// Create logger instance
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: customFormat,
    transports: [
        consoleTransport,
        allLogsTransport,
        errorLogsTransport
    ],
    exceptionHandlers: [
        consoleTransport,
        errorLogsTransport
    ],
    rejectionHandlers: [
        consoleTransport,
        errorLogsTransport
    ],
    exitOnError: false
});

// Add request logging middleware
function requestLogger(req, res, next) {
    const start = Date.now();
    const { method, url, ip } = req;

    // Log request
    logger.http(`${method} ${url}`, {
        ip,
        userAgent: req.get('User-Agent'),
        timestamp: new Date().toISOString()
    });

    // Log response
    res.on('finish', () => {
        const duration = Date.now() - start;
        const { statusCode } = res;

        logger.http(`${method} ${url} ${statusCode}`, {
            ip,
            duration: `${duration}ms`,
            statusCode,
            timestamp: new Date().toISOString()
        });
    });

    next();
}

// Child loggers for different modules
function createChildLogger(moduleName) {
    return logger.child({ module: moduleName });
}

// Export logger and utilities
module.exports = {
    logger,
    requestLogger,
    createChildLogger,

    // Convenience methods
    error: (message, meta) => logger.error(message, meta),
    warn: (message, meta) => logger.warn(message, meta),
    info: (message, meta) => logger.info(message, meta),
    http: (message, meta) => logger.http(message, meta),
    verbose: (message, meta) => logger.verbose(message, meta),
    debug: (message, meta) => logger.debug(message, meta),
    silly: (message, meta) => logger.silly(message, meta)
};
