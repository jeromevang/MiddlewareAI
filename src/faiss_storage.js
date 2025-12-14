#!/usr/bin/env node

/**
 * FAISS Storage Utilities for Rolling Summaries + Mini-RAG Middleware
 *
 * Handles:
 * - Initialization of FAISS index.
 * - Adding embeddings to the index.
 * - Persisting and loading the index from disk.
 */

const fs = require('fs');
const path = require('path');
const faiss = require('faiss-node');
const { Index, writeIndex, writeIndexSync } = faiss;
const readIndex = Index.read;
const crypto = require('crypto');
const { getStorageConfig } = require('./config.js');

// Configuration
const storageConfig = getStorageConfig();
const FAISS_INDEX_PATH = storageConfig.faiss_index_path || './vector_db/embeddings.faiss';
const FAISS_IDS_PATH = `${FAISS_INDEX_PATH}.ids.json`;
const EMBEDDING_DIMENSION = storageConfig.embedding_dimension || 384;

function ensureDirectoryFor(filePath) {
    const targetDir = path.dirname(filePath);
    if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
    }
}

// Logging utilities (imported from utils.js)
function logInfo(message) {
    console.log(`[INFO] ${message}`);
}

function logWarning(message) {
    console.warn(`[WARNING] ${message}`);
}

function logError(message, error = null) {
    if (error) {
        console.error(`[ERROR] ${message}`, error);
    } else {
        console.error(`[ERROR] ${message}`);
    }
}

// FAISS Index Manager
class FAISSIndexManager {
    constructor() {
        this.index = null;
        this.loaded = false;
        this.idMap = [];
        this.dim = null;
        this.writeFn = writeIndex || writeIndexSync || null;
        this.lock = Promise.resolve(); // serialize FAISS access
    }

    async clear() {
        return this.withLock(async () => {
            await this.resetIndex('manual clear');
        });
    }

    async withLock(fn) {
        const run = this.lock.then(fn, fn);
        this.lock = run.catch(() => {});
        return run;
    }

    /**
     * Initialize or load the FAISS index.
     */
    async initialize() {
        try {
            ensureDirectoryFor(FAISS_INDEX_PATH);
            logInfo('Initializing FAISS index...');

            if (typeof readIndex === 'function' && fs.existsSync(FAISS_INDEX_PATH)) {
                const loadedIndex = readIndex(FAISS_INDEX_PATH);
                this.index = loadedIndex;
                this.loaded = true;
                this.dim = this.index?.d || EMBEDDING_DIMENSION;

                if (this.dim !== EMBEDDING_DIMENSION) {
                    logWarning(`FAISS index dimension ${this.dim} disagrees with configured ${EMBEDDING_DIMENSION}; rebuilding.`);
                    await this.resetIndex('dimension mismatch');
                    return;
                }

                if (fs.existsSync(FAISS_IDS_PATH)) {
                    const rawIds = fs.readFileSync(FAISS_IDS_PATH, 'utf8');
                    this.idMap = JSON.parse(rawIds);
                    logInfo(`Successfully loaded FAISS index and id map (${this.idMap.length} entries).`);
                } else {
                    this.idMap = [];
                    logWarning('FAISS id map not found; searches may return numeric indices.');
                }

                logInfo(`Successfully loaded FAISS index from ${FAISS_INDEX_PATH}`);
            } else {
                logWarning('FAISS readIndex not available or index file missing; creating new index.');
                await this.resetIndex('readIndex unavailable or no file');
            }
        } catch (error) {
            logWarning(`FAISS load failed (${error?.message || error}); creating new index.`);
            await this.resetIndex('load failure');
        }
    }

    /**
     * Normalize an embedding vector to a Float32Array and validate.
     */
    static normalizeEmbeddingVector(embeddingVector) {
        if (!embeddingVector) {
            throw new Error('Embedding vector is empty or undefined');
        }
        const arr = Array.from(embeddingVector).map((v) => Number(v));
        if (arr.length === 0) {
            throw new Error('Embedding vector has zero length');
        }
        if (arr.some((n) => !Number.isFinite(n))) {
            throw new Error('Embedding vector contains non-finite values');
        }
        return new Float32Array(arr);
    }

    /**
     * Add embeddings to the FAISS index.
     */
    async addEmbedding(chunkId, embeddingVector) {
        await this.withLock(async () => {
            if (!this.index) {
                await this.initialize();
            }

            // Safe lengths for logging in case normalization fails early
            const inputLen = embeddingVector?.length ?? 'n/a';
            let normalizedLen = 'n/a';

            try {
                logInfo(`Adding embedding for chunk ID: ${chunkId}`);

                let faissVector = FAISSIndexManager.normalizeEmbeddingVector(embeddingVector);
                normalizedLen = faissVector.length;

                const targetDim = EMBEDDING_DIMENSION;
                faissVector = this.alignVectorToDim(faissVector, targetDim);

                if (!this.index || this.dim !== targetDim) {
                    await this.resetIndex('dimension alignment');
                }

                const vectorForFaiss = Array.from(faissVector);
                if (vectorForFaiss.length !== this.dim) {
                    throw new Error(`FAISS add: vector length ${vectorForFaiss.length} != index dim ${this.dim}`);
                }
                this.index.add(vectorForFaiss);

                // Track the order for reverse lookup
                this.idMap.push(chunkId);

                // Persist the updated index
                await this.persistIndex();

                logInfo(`Embedding for chunk ${chunkId} added successfully.`);
            } catch (error) {
                logError(
                    `Failed to add embedding to FAISS index (origLen=${inputLen}, normalizedLen=${normalizedLen}, targetDim=${this.dim || EMBEDDING_DIMENSION}):`,
                    error
                );
                // Swallow the error to avoid crashing indexing; caller can choose to continue.
                return;
            }
        });
    }

    /**
     * Rebuild the FAISS index from provided entries.
     * entries: Array<{ chunkId, embedding }>
     */
    async rebuild(entries) {
        try {
            ensureDirectoryFor(FAISS_INDEX_PATH);
            const dim = EMBEDDING_DIMENSION;
            this.index = new Index(dim, 'float');
            this.dim = dim;
            this.idMap = [];

            let skipped = 0;
            for (const entry of entries) {
                if (!entry.embedding) {
                    skipped += 1;
                    logWarning(`Rebuild skipped entry ${entry.chunkId}: missing embedding.`);
                    continue;
                }
                try {
                    const aligned = this.alignVectorToDim(entry.embedding, dim);
                    this.index.add(Array.from(aligned));
                    this.idMap.push(entry.chunkId);
                } catch (err) {
                    skipped += 1;
                    logWarning(`Rebuild skipped entry ${entry.chunkId}: add failed: ${err?.message || err}`);
                }
            }

            await this.persistIndex();
            logInfo(`Rebuilt FAISS index with ${this.idMap.length} entries. Skipped ${skipped}.`);
        } catch (error) {
            logError('Failed to rebuild FAISS index:', error);
            throw error;
        }
    }

    /**
     * Search the FAISS index for similar embeddings.
     */
    async searchSimilar(embeddingVector, topK = 5) {
        return this.withLock(async () => {
            try {
                if (!this.index) {
                    await this.initialize();
                }


                logInfo(`Searching for ${topK} most similar chunks...`);

                // Convert vector to Float32Array
                const faissVector = this.alignVectorToDim(embeddingVector, EMBEDDING_DIMENSION);
                if (this.dim !== EMBEDDING_DIMENSION) {
                    await this.resetIndex('query dimension alignment');
                }

                const ntotal = (typeof this.index.ntotal === 'function' ? this.index.ntotal() : this.index.ntotal) || 0;
                if (ntotal === 0 || this.idMap.length === 0 || ntotal !== this.idMap.length) {
                                        return [];
                }

                const k = Math.min(topK, ntotal);
                // faiss-node expects a flat array for a single query
                const searchResult = this.index.search(Array.from(faissVector), k);
                const distances = searchResult?.distances || [];
                const indices = searchResult?.labels || searchResult?.indices || [];

                const results = [];
                for (let i = 0; i < indices.length; i++) {
                    const idx = indices[i];
                    const chunkId = this.idMap[idx] || idx?.toString?.() || `${idx}`;
                    results.push({ chunkId, distance: distances[i] });
                }


                return results;
            } catch (error) {
                logError('Failed to search FAISS index, returning empty array:', error);
                                return [];
            }
        });
    }
    /**
     * Get all embeddings from the FAISS index.
     */
    async getAllEmbeddings() {
        if (!this.index) {
            await this.initialize();
        }

        try {
            const allVectors = {};
            logInfo('Retrieving all embeddings from FAISS index...');

            // Iterate through all vectors in the index
            const totalCount = (typeof this.index.ntotal === 'function' ? this.index.ntotal() : this.index.ntotal) || 0;
            for (let i = 0; i < totalCount; i++) {
                const vector = new Float32Array(this.index.reconstructN(i, 1));
                const chunkId = this.idMap[i] || crypto.randomBytes(4).toString('hex');

                allVectors[chunkId] = Array.from(vector);
            }

            return allVectors;
        } catch (error) {
            logError('Failed to retrieve embeddings from FAISS index:', error);
            throw error;
        }
    }

    alignVectorToDim(vector, targetDim) {
        const normalized = FAISSIndexManager.normalizeEmbeddingVector(vector);
        if (normalized.length === targetDim) {
            return normalized;
        }
        if (normalized.length > targetDim) {
            logWarning(`Embedding length ${normalized.length} exceeds target ${targetDim}; truncating.`);
            return normalized.slice(0, targetDim);
        }
        const padded = new Float32Array(targetDim);
        padded.set(normalized);
        return padded;
    }

    async resetIndex(reason = 'reset') {
        ensureDirectoryFor(FAISS_INDEX_PATH);
        this.index = new Index(EMBEDDING_DIMENSION, 'float');
        this.idMap = [];
        this.dim = EMBEDDING_DIMENSION;
        await this.persistIndex();
        logInfo(`FAISS index reset (${reason}).`);
    }

    async persistIndex() {
        if (!this.index) {
            return;
        }
        if (this.writeFn) {
            await this.writeFn(this.index, FAISS_INDEX_PATH);
        } else if (this.index.write) {
            this.index.write(FAISS_INDEX_PATH);
        }
        ensureDirectoryFor(FAISS_IDS_PATH);
        fs.writeFileSync(FAISS_IDS_PATH, JSON.stringify(this.idMap, null, 2));
    }
}

module.exports = { FAISSIndexManager };