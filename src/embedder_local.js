#!/usr/bin/env node

/**
 * Local CPU embedder using @xenova/transformers.
 * Provides a shared, cached pipeline for embeddings.
 */

const { pipeline } = require('@xenova/transformers');

let embedderPromise = null;

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
    const embedder = await getEmbedder(modelName);
    const output = await embedder(text, {
        pooling: 'mean',
        normalize: true,
    });
    // output is a tensor-like with .data
    const data = output?.data || output;
    return Array.from(data);
}

module.exports = { embedTextLocal };

