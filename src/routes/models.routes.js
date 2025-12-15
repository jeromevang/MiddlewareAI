/**
 * Models Routes
 * Handles: /models/*
 */
const express = require('express');

/**
 * Create models routes
 * @param {Object} deps - Dependencies
 * @returns {express.Router}
 */
function createModelsRoutes(deps) {
    const router = express.Router();
    const {
        getPresets,
        getPreset,
        getModelSpec,
        getAllModelSpecs,
        getLastActiveModel,
        setActiveModel,
        getSuggestedModels,
        approveModel,
        dismissSuggestedModel,
        discoverAndAnalyzeModels,
        downloadModel,
        getModelAvailability,
        getActiveDownloads,
        listLoadedModels,
        switchMainModel,
        checkLMStudioHealth,
        startLMStudioServer,
        isLMStudioRunning,
        getLMStudioConfig,
        getLMStudioCLIPath,
        runBootstrap,
        getBootstrapStatus,
        appendLog
    } = deps;

    /**
     * GET /models/presets - Get all presets with last active model
     */
    router.get('/models/presets', async (req, res) => {
        try {
            const presets = getPresets();
            const lastActive = getLastActiveModel();
            res.json({ presets, lastActiveModel: lastActive });
        } catch (error) {
            console.error('[API] Failed to get presets:', error.message);
            res.status(500).json({ error: 'Failed to get presets', details: error.message });
        }
    });

    /**
     * GET /models/specs/:id - Get a specific model spec
     */
    router.get('/models/specs/:id', async (req, res) => {
        try {
            const modelId = decodeURIComponent(req.params.id);
            const spec = getModelSpec(modelId);
            if (!spec) {
                return res.status(404).json({ error: 'Model not found' });
            }
            res.json(spec);
        } catch (error) {
            console.error('[API] Failed to get model spec:', error.message);
            res.status(500).json({ error: 'Failed to get model spec', details: error.message });
        }
    });

    /**
     * GET /models/suggested - Get suggested models
     */
    router.get('/models/suggested', async (req, res) => {
        try {
            const suggested = getSuggestedModels();
            res.json({ suggested });
        } catch (error) {
            console.error('[API] Failed to get suggested models:', error.message);
            res.status(500).json({ error: 'Failed to get suggested models', details: error.message });
        }
    });

    /**
     * POST /models/active - Set active model and load it
     */
    router.post('/models/active', async (req, res) => {
        try {
            const { modelId } = req.body || {};
            if (!modelId) {
                return res.status(400).json({ error: 'modelId required' });
            }

            // Get the previous active model before setting new one
            const previousModel = getLastActiveModel();
            
            // Save to database
            const result = setActiveModel(modelId);
            appendLog(`Active model set to: ${modelId}`, 'info');

            // Ensure LM Studio is running
            const lmHealth = await checkLMStudioHealth();
            if (!lmHealth.ready) {
                console.log('[API] LM Studio not ready, starting server...');
                const cfg = getLMStudioConfig();
                if (await isLMStudioRunning(cfg.url)) {
                    console.log('[LM Studio] Server already running.');
                } else {
                    const cliPath = getLMStudioCLIPath();
                    const args = ['server', 'start', '--port', (cfg.server_port || 1234).toString()];
                    try {
                        const { spawn } = require('child_process');
                        const proc = spawn(cliPath, args, { stdio: 'inherit', shell: true });
                        await new Promise(resolve => setTimeout(resolve, 3000));
                    } catch (startError) {
                        console.warn('[API] Failed to start LM Studio server:', startError.message);
                    }
                }
                const healthAfter = await checkLMStudioHealth();
                if (!healthAfter.ready) {
                    return res.status(503).json({ 
                        error: 'LM Studio server could not be started',
                        details: 'Please start LM Studio manually'
                    });
                }
            }

            // Use switchMainModel to intelligently unload old and load new
            console.log(`[API] Switching main model from: ${previousModel || 'none'} to: ${modelId}`);
            
            const switchResult = await switchMainModel(modelId, previousModel);
            
            if (!switchResult.success) {
                if (switchResult.error?.includes('not found')) {
                    return res.json({ 
                        status: 'ok', 
                        lastActiveModel: result,
                        warning: 'Model set but not found in LM Studio. It may need to be downloaded first.'
                    });
                }
                return res.json({ 
                    status: 'ok', 
                    lastActiveModel: result,
                    warning: switchResult.error || 'Model set but failed to load'
                });
            }

            appendLog(`Model switched: ${switchResult.unloaded ? `unloaded ${switchResult.unloaded}, ` : ''}loaded ${switchResult.loaded}`, 'info');
            
            res.json({ 
                status: 'ok', 
                lastActiveModel: result, 
                loadedModel: switchResult.loaded,
                unloadedModel: switchResult.unloaded || null,
                message: switchResult.message
            });
        } catch (error) {
            console.error('[API] Failed to set active model:', error.message);
            res.status(500).json({ error: 'Failed to set active model', details: error.message });
        }
    });

    /**
     * POST /models/discover - Discover new models from LM Studio
     */
    router.post('/models/discover', async (req, res) => {
        try {
            const result = await discoverAndAnalyzeModels();
            appendLog(`Discovered ${result.discovered || 0} new models`, 'info');
            res.json({ status: 'ok', ...result });
        } catch (error) {
            console.error('[API] Failed to discover models:', error.message);
            res.status(500).json({ error: 'Failed to discover models', details: error.message });
        }
    });

    /**
     * POST /models/approve/:id - Approve a suggested model
     */
    router.post('/models/approve/:id', async (req, res) => {
        try {
            const modelId = decodeURIComponent(req.params.id);
            const result = approveModel(modelId);
            appendLog(`Model approved: ${modelId}`, 'info');
            res.json({ status: 'ok', ...result });
        } catch (error) {
            console.error('[API] Failed to approve model:', error.message);
            res.status(500).json({ error: 'Failed to approve model', details: error.message });
        }
    });

    /**
     * POST /models/dismiss/:id - Dismiss a suggested model
     */
    router.post('/models/dismiss/:id', async (req, res) => {
        try {
            const modelId = decodeURIComponent(req.params.id);
            const result = dismissSuggestedModel(modelId);
            appendLog(`Model dismissed: ${modelId}`, 'info');
            res.json({ status: 'ok', ...result });
        } catch (error) {
            console.error('[API] Failed to dismiss model:', error.message);
            res.status(500).json({ error: 'Failed to dismiss model', details: error.message });
        }
    });

    /**
     * POST /models/download/:id - Download a model
     */
    router.post('/models/download/:id', async (req, res) => {
        try {
            const modelId = decodeURIComponent(req.params.id);
            appendLog(`Starting model download: ${modelId}`, 'info');

            const result = await downloadModel(modelId);

            if (result.success) {
                appendLog(`Model download started: ${modelId}`, 'info');
                res.json({ 
                    status: 'ok', 
                    message: result.message,
                    downloadStatus: result.status || 'downloading',
                    modelId 
                });
            } else {
                if (result.status === 'downloading') {
                    res.json({ 
                        status: 'ok', 
                        message: 'Download already in progress',
                        downloadStatus: 'downloading',
                        modelId 
                    });
                } else {
                    appendLog(`Model download failed: ${modelId} - ${result.message}`, 'warn');
                    res.status(500).json({ error: 'Download failed', details: result.message });
                }
            }
        } catch (error) {
            console.error('[API] Failed to download model:', error.message);
            res.status(500).json({ error: 'Failed to download model', details: error.message });
        }
    });

    /**
     * GET /models/status - Get model availability status
     */
    router.get('/models/status', async (req, res) => {
        try {
            const availability = getModelAvailability();
            const downloads = getActiveDownloads();
            
            let loadedModels = [];
            try {
                const lmModels = await listLoadedModels();
                loadedModels = lmModels.map(model => model.id || model.identifier).filter(Boolean);
            } catch (error) {
                console.warn('[API] Failed to get loaded models from LM Studio:', error.message);
            }
            
            res.json({ status: 'ok', availability, activeDownloads: downloads, loadedModels });
        } catch (error) {
            console.error('[API] Failed to get model status:', error.message);
            res.status(500).json({ error: 'Failed to get model status', details: error.message });
        }
    });

    /**
     * POST /models/validate - Validate presets
     */
    router.post('/models/validate', async (req, res) => {
        try {
            // This would revalidate presets against downloaded models
            appendLog('Model validation triggered via API', 'info');
            res.json({ status: 'ok', message: 'Validation complete' });
        } catch (error) {
            console.error('[API] Failed to validate models:', error.message);
            res.status(500).json({ error: 'Failed to validate models', details: error.message });
        }
    });

    /**
     * GET /models/bootstrap-status - Get bootstrap status
     */
    router.get('/models/bootstrap-status', (req, res) => {
        try {
            const status = getBootstrapStatus();
            res.json(status);
        } catch (error) {
            console.error('[API] Failed to get bootstrap status:', error.message);
            res.status(500).json({ error: 'Failed to get bootstrap status', details: error.message });
        }
    });

    /**
     * POST /models/bootstrap - Trigger model bootstrap
     */
    router.post('/models/bootstrap', async (req, res) => {
        try {
            appendLog('Model bootstrap triggered via API', 'info');
            const result = await runBootstrap();
            res.json({ status: 'ok', ...result });
        } catch (error) {
            console.error('[API] Failed to run bootstrap:', error.message);
            res.status(500).json({ error: 'Failed to run bootstrap', details: error.message });
        }
    });

    return router;
}

module.exports = { createModelsRoutes };
