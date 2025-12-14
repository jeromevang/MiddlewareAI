#!/usr/bin/env node

/**
 * Local CPU embedder using @xenova/transformers.
 * Provides a shared, cached pipeline for embeddings.
 */

const { pipeline } = require('@xenova/transformers');
const { getModelConfig } = require('./config.js');

let embedderPromise = null;

// Constants for text truncation
const TOKENS_PER_CHAR_APPROX = 0.25;
const MAX_EMBED_CHARS = 4000;

function truncateForEmbedding(text, maxTokens) {
    if (!text || !maxTokens) return text;
    const maxChars = Math.min(Math.floor(maxTokens / TOKENS_PER_CHAR_APPROX), MAX_EMBED_CHARS);
    if (text.length <= maxChars) return text;
    return text.slice(0, maxChars);
}

async function getEmbedder(modelName) {
    if (!embedderPromise) {
        embedderPromise = pipeline('feature-extraction', modelName, {
            device: 'cpu',
        });
    }
    return embedderPromise;
}

/**
 * Generate an embedding vector for the given text.
 * Returns a Float32Array.
 */
async function embedTextLocal(text, modelName) {
    if (!text) return [];
    const embeddingModel = getModelConfig('embedding');
    const maxTokens = Math.min(embeddingModel.context_length || 512, 1024);
    const truncated = truncateForEmbedding(text, maxTokens);
    const embedder = await getEmbedder(modelName);
    const output = await embedder(truncated, {
        pooling: 'mean',
        normalize: true,
    });
    // output is a tensor-like with .data
    const data = output?.data || output;
    const vector = Array.from(data);

    // Validate the vector for non-finite values
    if (!Array.isArray(vector) || vector.length === 0) {
        throw new Error('Embedding vector is empty or invalid');
    }
    if (vector.some(v => !Number.isFinite(v))) {
        throw new Error('Embedding vector contains non-finite values');
    }

    return vector;
}

module.exports = { embedTextLocal };

