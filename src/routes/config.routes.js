/**
 * Config Routes
 * Handles: /api/config, /engines/:engine, /telemetry
 */
const express = require('express');

/**
 * Create config routes
 * @param {Object} deps - Dependencies
 * @returns {express.Router}
 */
function createConfigRoutes(deps) {
    const router = express.Router();
    const {
        getRedactedConfig,
        updateConfig,
        getEnginesSnapshot,
        updateEngineEnabled,
        buildTelemetryStatus,
        setTelemetryOverride,
        appendLog
    } = deps;

    /**
     * GET /api/config - Get redacted configuration
     */
    router.get('/api/config', async (_req, res) => {
        try {
            const cfg = getRedactedConfig();
            res.json(cfg);
        } catch (err) {
            console.error('[API] /api/config GET error:', err);
            res.status(500).json({ error: 'Failed to get config', details: err.message });
        }
    });

    /**
     * PATCH /api/config - Update configuration
     */
    router.patch('/api/config', async (req, res) => {
        try {
            await updateConfig(req.body);
            appendLog('Config updated via API', 'info');
            res.json({ status: 'ok' });
        } catch (err) {
            console.error('[API] /api/config PATCH error:', err);
            res.status(500).json({ error: 'Failed to update config', details: err.message });
        }
    });

    /**
     * PATCH /engines/:engine - Update engine enabled state
     */
    router.patch('/engines/:engine', async (req, res) => {
        try {
            const { engine } = req.params;
            const { enabled } = req.body;
            
            if (typeof enabled !== 'boolean') {
                return res.status(400).json({ error: 'enabled must be a boolean' });
            }
            
            updateEngineEnabled(engine, enabled);
            appendLog(`Engine '${engine}' ${enabled ? 'enabled' : 'disabled'}`, 'info');
            
            res.json({ 
                status: 'ok', 
                engines: getEnginesSnapshot() 
            });
        } catch (err) {
            console.error('[API] /engines/:engine error:', err);
            res.status(500).json({ error: 'Failed to update engine', details: err.message });
        }
    });

    /**
     * GET /telemetry - Get telemetry status
     */
    router.get('/telemetry', (_req, res) => {
        try {
            res.json(buildTelemetryStatus());
        } catch (err) {
            console.error('[API] /telemetry GET error:', err);
            res.status(500).json({ error: 'Failed to get telemetry', details: err.message });
        }
    });

    /**
     * POST /telemetry - Update telemetry settings
     */
    router.post('/telemetry', (req, res) => {
        try {
            const { enabled } = req.body;
            if (typeof enabled === 'boolean') {
                setTelemetryOverride(enabled);
                appendLog(`Telemetry ${enabled ? 'enabled' : 'disabled'}`, 'info');
            }
            res.json(buildTelemetryStatus());
        } catch (err) {
            console.error('[API] /telemetry POST error:', err);
            res.status(500).json({ error: 'Failed to update telemetry', details: err.message });
        }
    });

    return router;
}

module.exports = { createConfigRoutes };
