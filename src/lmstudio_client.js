#!/usr/bin/env node

const { embedText } = require('./lmstudio/embeddings.js');
const { summarize, generateCompletion, proxyChatCompletion } = require('./lmstudio/chat.js');
const { warmModel, warmEmbeddingModel, waitForModelsLoaded, openModel } = require('./lmstudio/model_manager.js');

module.exports = {
    embedText,
    summarize,
    generateCompletion,
    proxyChatCompletion,
    warmModel,
    warmEmbeddingModel,
    waitForModelsLoaded,
    openModel,
};
