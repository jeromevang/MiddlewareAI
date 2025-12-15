/**
 * LM Studio Routes
 * Handles: /lmstudio/*
 */
const express = require('express');

/**
 * Create LM Studio routes
 * @param {Object} deps - Dependencies
 * @returns {express.Router}
 */
function createLMStudioRoutes(deps) {
    const router = express.Router();
    const {
        listLoadedModels,
        unloadModel,
        unloadAllModels,
        getServerStatus,
        checkLMStudioHealth,
        startLMStudioServer,
        stopLMStudioServer,
        ensureRequiredModelsLoaded,
        ensurePresetModelsLoaded,
        refreshModelContext,
        appendLog
    } = deps;

    /**
     * GET /lmstudio/models - List loaded models
     */
    router.get('/lmstudio/models', async (req, res) => {
        try {
            const models = await listLoadedModels();
            res.json({ status: 'ok', models });
        } catch (error) {
            console.error('[API] Failed to list models:', error.message);
            res.status(500).json({ error: 'Failed to list models', details: error.message });
        }
    });

    /**
     * POST /lmstudio/models/unload - Unload a specific model
     */
    router.post('/lmstudio/models/unload', async (req, res) => {
        try {
            const { modelId } = req.body;
            if (!modelId) {
                return res.status(400).json({ error: 'modelId is required' });
            }
            const result = await unloadModel(modelId);
            appendLog(`Model unloaded: ${modelId}`, 'info');
            res.json({ status: 'ok', ...result });
        } catch (error) {
            console.error('[API] Failed to unload model:', error.message);
            res.status(500).json({ error: 'Failed to unload model', details: error.message });
        }
    });

    /**
     * POST /lmstudio/models/unload-all - Unload all models
     */
    router.post('/lmstudio/models/unload-all', async (req, res) => {
        try {
            const result = await unloadAllModels();
            appendLog('All models unloaded', 'info');
            res.json({ status: 'ok', ...result });
        } catch (error) {
            console.error('[API] Failed to unload all models:', error.message);
            res.status(500).json({ error: 'Failed to unload all models', details: error.message });
        }
    });

    /**
     * GET /lmstudio/server/status - Get server status
     */
    router.get('/lmstudio/server/status', async (req, res) => {
        try {
            const status = await getServerStatus();
            res.json({ status: 'ok', ...status });
        } catch (error) {
            console.error('[API] Failed to get server status:', error.message);
            res.status(500).json({ error: 'Failed to get server status', details: error.message });
        }
    });

    /**
     * GET /lmstudio/health - Comprehensive health check
     */
    router.get('/lmstudio/health', async (req, res) => {
        try {
            const health = await checkLMStudioHealth();
            res.json(health);
        } catch (error) {
            console.error('[API] Failed to check health:', error.message);
            res.status(500).json({ error: 'Health check failed', details: error.message });
        }
    });

    /**
     * POST /lmstudio/server/start - Start LM Studio server
     */
    router.post('/lmstudio/server/start', async (req, res) => {
        try {
            const result = await startLMStudioServer();
            appendLog('LM Studio server started via API', 'info');
            res.json({ status: 'ok', ...result });
        } catch (error) {
            console.error('[API] Failed to start server:', error.message);
            res.status(500).json({ error: 'Failed to start server', details: error.message });
        }
    });

    /**
     * POST /lmstudio/server/stop - Stop LM Studio server
     */
    router.post('/lmstudio/server/stop', async (req, res) => {
        try {
            const result = await stopLMStudioServer();
            appendLog('LM Studio server stopped via API', 'info');
            res.json({ status: 'ok', ...result });
        } catch (error) {
            console.error('[API] Failed to stop server:', error.message);
            res.status(500).json({ error: 'Failed to stop server', details: error.message });
        }
    });

    /**
     * POST /lmstudio/models/load-required - Load required models
     */
    router.post('/lmstudio/models/load-required', async (req, res) => {
        try {
            await ensureRequiredModelsLoaded();
            appendLog('Required models loaded via API', 'info');
            res.json({ status: 'ok', message: 'Required models loaded successfully' });
        } catch (error) {
            console.error('[API] Failed to load required models:', error.message);
            res.status(500).json({ error: 'Failed to load required models', details: error.message });
        }
    });

    /**
     * POST /lmstudio/models/load-preset/:preset - Load preset models
     */
    router.post('/lmstudio/models/load-preset/:preset', async (req, res) => {
        try {
            const { preset } = req.params;
            if (!preset || !['high', 'medium', 'low'].includes(preset)) {
                return res.status(400).json({ error: 'Invalid preset. Must be one of: high, medium, low' });
            }

            const result = await ensurePresetModelsLoaded(preset);
            appendLog(`Preset '${preset}' models loaded via API: loaded=${result.loaded.length}, kept=${result.kept.length}, unloaded=${result.unloaded.length}`, 'info');
            
            res.json({ 
                status: 'ok', 
                message: `Preset '${preset}' models loaded successfully`,
                loaded: result.loaded,
                kept: result.kept,
                unloaded: result.unloaded,
                failed: result.failed,
                needsDownload: result.needsDownload
            });
        } catch (error) {
            console.error(`[API] Failed to load preset '${req.params.preset}' models:`, error.message);
            res.status(500).json({ error: 'Failed to load preset models', details: error.message });
        }
    });

    /**
     * POST /lmstudio/context/refresh - Refresh context limits
     */
    router.post('/lmstudio/context/refresh', async (req, res) => {
        try {
            await refreshModelContext();
            appendLog('Model context refreshed via API', 'info');
            res.json({ status: 'ok', message: 'Context refreshed' });
        } catch (error) {
            console.error('[API] Failed to refresh context:', error.message);
            res.status(500).json({ error: 'Failed to refresh context', details: error.message });
        }
    });

    /**
     * POST /lmstudio/restart - Restart LM Studio
     */
    router.post('/lmstudio/restart', async (req, res) => {
        try {
            await stopLMStudioServer();
            await new Promise(resolve => setTimeout(resolve, 2000));
            await startLMStudioServer();
            appendLog('LM Studio restarted via API', 'info');
            res.json({ status: 'ok', message: 'LM Studio restarted' });
        } catch (error) {
            console.error('[API] Failed to restart LM Studio:', error.message);
            res.status(500).json({ error: 'Failed to restart', details: error.message });
        }
    });

    return router;
}

module.exports = { createLMStudioRoutes };
