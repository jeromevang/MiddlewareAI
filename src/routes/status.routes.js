/**
 * Status Routes
 * Handles: /status, /metrics, /logs, /history
 */
const express = require('express');

/**
 * Create status routes
 * @param {Object} deps - Dependencies
 * @returns {express.Router}
 */
function createStatusRoutes(deps) {
    const router = express.Router();
    const {
        buildStatusPayload,
        buildMetricsPayload,
        getRecentLogs,
        getRecentRequests
    } = deps;

    /**
     * GET /status - Dashboard status payload
     */
    router.get('/status', async (_req, res) => {
        try {
            const status = await buildStatusPayload();
            res.json(status);
        } catch (err) {
            console.error('[API] /status error:', err);
            res.status(500).json({ error: 'Failed to build status', details: err.message });
        }
    });

    /**
     * GET /metrics - Server metrics
     */
    router.get('/metrics', async (_req, res) => {
        try {
            const metricsPayload = buildMetricsPayload();
            res.json(metricsPayload);
        } catch (err) {
            console.error('[API] /metrics error:', err);
            res.status(500).json({ error: 'Failed to get metrics', details: err.message });
        }
    });

    /**
     * GET /logs - Recent server logs
     */
    router.get('/logs', async (req, res) => {
        try {
            const limit = parseInt(req.query.limit, 10) || 50;
            const logs = getRecentLogs().slice(-limit);
            res.json({ logs });
        } catch (err) {
            console.error('[API] /logs error:', err);
            res.status(500).json({ error: 'Failed to get logs', details: err.message });
        }
    });

    /**
     * GET /history - Recent request history
     */
    router.get('/history', async (req, res) => {
        try {
            const limit = parseInt(req.query.limit, 10) || 20;
            const history = getRecentRequests().slice(-limit);
            res.json({ history });
        } catch (err) {
            console.error('[API] /history error:', err);
            res.status(500).json({ error: 'Failed to get history', details: err.message });
        }
    });

    return router;
}

module.exports = { createStatusRoutes };
