#!/usr/bin/env node

const axios = require('axios');
const { getModelConfig } = require('../config.js');
const { embedTextLocal } = require('../embedder_local.js');
const { ensureModelLoaded } = require('./model_manager.js');
const { LM_STUDIO_URL, LM_STUDIO_TIMEOUT_MS, MAX_RETRIES, TOKENS_PER_CHAR_APPROX, MAX_EMBED_CHARS, withLMStudioLock, generateRequestId } = require('./state.js');

function truncateForEmbedding(text, maxTokens) {
    if (!text || !maxTokens) return text;
    const maxChars = Math.min(Math.floor(maxTokens / TOKENS_PER_CHAR_APPROX), MAX_EMBED_CHARS);
    if (text.length <= maxChars) return text;
    return text.slice(0, maxChars);
}

async function embedText(text) {
    const requestId = generateRequestId();
    let retries = MAX_RETRIES;
    const embeddingModel = getModelConfig('embedding');
    const maxTokens = Math.min(embeddingModel.context_length || 2048, 1024);
    const truncated = truncateForEmbedding(text, maxTokens);

    if (embeddingModel.engine === 'local') {
        try {
            const vector = await embedTextLocal(truncated, embeddingModel.model_name || embeddingModel.identifier);
            return { embeddingVector: vector };
        } catch (error) {
            console.error(`[Local Embedder] ${requestId} - Failed to generate embedding:`, error.message || error);
            return { embeddingVector: null, failed: true, error: error.message || String(error) };
        }
    }

    while (retries > 0) {
        try {
            await ensureModelLoaded(embeddingModel.identifier);
            console.log(`[LM Studio Request] ${requestId} - Generating embeddings for chunk...`);
            const response = await withLMStudioLock(() =>
                axios.post(
                    `${LM_STUDIO_URL}/api/v0/embeddings`,
                    {
                        model: embeddingModel.identifier,
                        input: truncated
                    },
                    {
                        timeout: LM_STUDIO_TIMEOUT_MS,
                        headers: {
                            'Content-Type': 'application/json'
                        }
                    }
                )
            );

            let vector =
                response.data?.data?.[0]?.embedding ||
                response.data?.embedding ||
                response.data?.data;

            if (Array.isArray(vector)) {
                vector = Array.from(vector);
            } else if (vector && typeof vector === 'object') {
                if (Array.isArray(vector.data)) {
                    vector = Array.from(vector.data);
                } else {
                    vector = Array.from(Object.values(vector));
                }
            }

            if (vector && Array.isArray(vector)) {
                console.log(`[LM Studio Success] ${requestId} - Embeddings generated successfully.`);
                return { embeddingVector: vector };
            }

            throw new Error('Invalid embeddings response format.');
        } catch (error) {
            retries--;
            if (retries === 0) {
                console.error(`[LM Studio Request Failed] ${requestId} - Max retries reached. Error:`, error.message);
                return { embeddingVector: null, failed: true, error: error.message };
            }

            const delay = Math.pow(2, MAX_RETRIES - retries) * 1000;
            console.log(`[LM Studio Retry] ${requestId} - Retrying in ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

module.exports = { embedText };
