#!/usr/bin/env node

/**
 * Local CPU embedder using @xenova/transformers.
 * Provides a shared, cached pipeline for embeddings.
 */

const { pipeline } = require('@xenova/transformers');
const { getModelConfig } = require('./config.js');
const { getCloudConfig } = require('./runtime.js');
const axios = require('axios');

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

/**
 * Generate an embedding vector using Google AI Studio (cloud).
 * Returns a Float32Array.
 */
async function embedTextCloud(text) {
    if (!text) return [];

    const cloudCfg = getCloudConfig();
    const embeddingCfg = getModelConfig('embedding');

    if (!embeddingCfg.api_key) {
        throw new Error('Google AI Studio API key not configured');
    }

    try {
        const response = await axios.post(
            'https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent',
            {
                content: {
                    parts: [{ text: text }]
                }
            },
            {
                params: {
                    key: embeddingCfg.api_key
                },
                headers: {
                    'Content-Type': 'application/json'
                }
            }
        );

        const embedding = response.data.embedding?.values;
        if (!embedding || !Array.isArray(embedding)) {
            throw new Error('Invalid embedding response from Google AI Studio');
        }

        // Validate the vector for non-finite values
        if (embedding.some(v => !Number.isFinite(v))) {
            throw new Error('Embedding vector contains non-finite values');
        }

        return embedding;
    } catch (error) {
        console.error(`[Cloud Embedder] Failed to generate embedding:`, error.message || error);
        throw error;
    }
}

module.exports = { embedTextLocal, embedTextCloud };

