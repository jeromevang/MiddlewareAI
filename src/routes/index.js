/**
 * Routes Index
 * Aggregates all route modules
 */

const { createStatusRoutes } = require('./status.routes.js');
const { createConfigRoutes } = require('./config.routes.js');
const { createLMStudioRoutes } = require('./lmstudio.routes.js');
const { createModelsRoutes } = require('./models.routes.js');
const { createSessionsRoutes } = require('./sessions.routes.js');
const { createRagRoutes } = require('./rag.routes.js');

/**
 * Mount all routes on the Express app
 * @param {express.Application} app - Express app
 * @param {Object} deps - Shared dependencies for routes
 */
function mountRoutes(app, deps) {
    // Status routes (no prefix)
    app.use(createStatusRoutes({
        buildStatusPayload: deps.buildStatusPayload,
        buildMetricsPayload: deps.buildMetricsPayload,
        getRecentLogs: deps.getRecentLogs,
        getRecentRequests: deps.getRecentRequests
    }));

    // Config routes (no prefix)
    app.use(createConfigRoutes({
        getRedactedConfig: deps.getRedactedConfig,
        updateConfig: deps.updateConfig,
        getEnginesSnapshot: deps.getEnginesSnapshot,
        updateEngineEnabled: deps.updateEngineEnabled,
        buildTelemetryStatus: deps.buildTelemetryStatus,
        setTelemetryOverride: deps.setTelemetryOverride,
        appendLog: deps.appendLog
    }));

    // LM Studio routes (no prefix - routes include /lmstudio)
    app.use(createLMStudioRoutes({
        listLoadedModels: deps.listLoadedModels,
        unloadModel: deps.unloadModel,
        unloadAllModels: deps.unloadAllModels,
        getServerStatus: deps.getServerStatus,
        checkLMStudioHealth: deps.checkLMStudioHealth,
        startLMStudioServer: deps.startLMStudioServer,
        stopLMStudioServer: deps.stopLMStudioServer,
        ensureRequiredModelsLoaded: deps.ensureRequiredModelsLoaded,
        ensurePresetModelsLoaded: deps.ensurePresetModelsLoaded,
        refreshModelContext: deps.refreshModelContext,
        appendLog: deps.appendLog
    }));

    // Models routes (no prefix - routes include /models)
    app.use(createModelsRoutes({
        getPresets: deps.getPresets,
        getPreset: deps.getPreset,
        getModelSpec: deps.getModelSpec,
        getAllModelSpecs: deps.getAllModelSpecs,
        getLastActiveModel: deps.getLastActiveModel,
        setActiveModel: deps.setActiveModel,
        getSuggestedModels: deps.getSuggestedModels,
        approveModel: deps.approveModel,
        dismissSuggestedModel: deps.dismissSuggestedModel,
        discoverAndAnalyzeModels: deps.discoverAndAnalyzeModels,
        downloadModel: deps.downloadModel,
        getModelAvailability: deps.getModelAvailability,
        getActiveDownloads: deps.getActiveDownloads,
        listLoadedModels: deps.listLoadedModels,
        switchMainModel: deps.switchMainModel,
        checkLMStudioHealth: deps.checkLMStudioHealth,
        startLMStudioServer: deps.startLMStudioServer,
        isLMStudioRunning: deps.isLMStudioRunning,
        getLMStudioConfig: deps.getLMStudioConfig,
        getLMStudioCLIPath: deps.getLMStudioCLIPath,
        runBootstrap: deps.runBootstrap,
        getBootstrapStatus: deps.getBootstrapStatus,
        appendLog: deps.appendLog
    }));

    // Sessions routes (no prefix - routes include paths)
    app.use(createSessionsRoutes({
        sqliteCacheManager: deps.sqliteCacheManager,
        getSessionList: deps.getSessionList,
        decorateSessionMetaRows: deps.decorateSessionMetaRows,
        buildFallbackSessionMeta: deps.buildFallbackSessionMeta,
        recomputeRollingSummary: deps.recomputeRollingSummary,
        getSummaryKeepRecentTurns: deps.getSummaryKeepRecentTurns,
        setSummaryKeepRecentTurns: deps.setSummaryKeepRecentTurns,
        getContextModeDefault: deps.getContextModeDefault,
        setContextModeDefault: deps.setContextModeDefault,
        normalizeContextModeValue: deps.normalizeContextModeValue,
        appendLog: deps.appendLog
    }));

    // RAG routes (no prefix - routes include paths)
    app.use(createRagRoutes({
        ragService: deps.ragService,
        faissIndexManager: deps.faissIndexManager,
        sqliteCacheManager: deps.sqliteCacheManager,
        startIndexer: deps.startIndexer,
        stopActiveIndexer: deps.stopActiveIndexer,
        isIndexingInProgress: deps.isIndexingInProgress,
        appendLog: deps.appendLog
    }));
}

module.exports = { mountRoutes };
