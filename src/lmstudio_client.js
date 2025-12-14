#!/usr/bin/env node

const { embedText: embedTextLMStudio } = require('./lmstudio/embeddings.js');
const { summarize, generateCompletion, proxyChatCompletion } = require('./lmstudio/chat.js');
const { warmModel, warmEmbeddingModel, waitForModelsLoaded, openModel, unloadModel, unloadAllModels, listLoadedModels, getServerStatus, startLMStudioServer, stopLMStudioServer, checkLMStudioHealth, waitForServerReady, ensureRequiredModelsLoaded, initializeLMStudioWithModels } = require('./lmstudio/model_manager.js');
const { embedTextLocal, embedTextCloud } = require('./embedder_local.js');
const { getModelConfig } = require('./config.js');
const { isCloudMode } = require('./runtime.js');

async function embedText(text) {
    const embeddingCfg = getModelConfig('embedding');
    if (embeddingCfg.engine === 'local') {
        try {
            const vector = await embedTextLocal(text, embeddingCfg.model_name);
            return { embeddingVector: vector };
        } catch (error) {
            console.error(`[Local Embedder] Failed to generate embedding:`, error.message || error);
            return { embeddingVector: null, failed: true, error: error.message || String(error) };
        }
    } else if (embeddingCfg.engine === 'cloud') {
        return embedTextCloud(text);
    } else {
        return embedTextLMStudio(text);
    }
}

module.exports = {
    embedText,
    summarize,
    generateCompletion,
    proxyChatCompletion,
    warmModel,
    warmEmbeddingModel,
    waitForModelsLoaded,
    openModel,
    unloadModel,
    unloadAllModels,
    listLoadedModels,
    getServerStatus,
    startLMStudioServer,
    stopLMStudioServer,
    checkLMStudioHealth,
    waitForServerReady,
    ensureRequiredModelsLoaded,
    initializeLMStudioWithModels,
};
