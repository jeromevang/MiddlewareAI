#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { CodeChunkGenerator, logInfo: utilsLogInfo, logWarning: utilsLogWarning, logError: utilsLogError } = require('../utils.js');
const { SQLiteCacheManager } = require('../sqlite_cache.js');
const { FAISSIndexManager } = require('../faiss_storage.js');
const { embedText, summarizeChunk } = require('../lmstudio_client.js');
const { getProcessingConfig, getModelConfig } = require('../config.js');
const { isCloudMode } = require('../runtime.js');
const { generateChunkHash } = require('../chunk_utils.js');

const sqliteCacheManager = new SQLiteCacheManager();
const faissIndexManager = new FAISSIndexManager();
const processingConfig = getProcessingConfig();
const ragSummarizationModel = getModelConfig('ragSummarization');

const MAX_CHUNK_SIZE = Math.min(processingConfig.max_chunk_size || 400, 400);
const CONCURRENCY_LIMIT = 1;
const CACHE_INVALIDATION_DAYS = processingConfig.cache_invalidation_days || 7;

// Global indexing status tracking
let indexingStatus = {
    isActive: false,
    status: 'idle', // 'idle', 'scanning', 'processing', 'embedding', 'saving', 'completed', 'error'
    currentFile: null,
    filesProcessed: 0,
    totalFiles: 0,
    chunksProcessed: 0,
    startTime: null,
    error: null,
    estimatedTimeRemaining: null
};

function updateIndexingStatus(updates) {
    indexingStatus = { ...indexingStatus, ...updates };
}

function getIndexingStatus() {
    return { ...indexingStatus };
}

function resetIndexingStatus() {
    indexingStatus = {
        isActive: false,
        status: 'idle',
        currentFile: null,
        filesProcessed: 0,
        totalFiles: 0,
        chunksProcessed: 0,
        startTime: null,
        error: null,
        estimatedTimeRemaining: null
    };
}

let storesInitialized = false;
async function ensureStoresInitialized() {
    if (storesInitialized) return;
    await sqliteCacheManager.initialize();
    await faissIndexManager.initialize();
    storesInitialized = true;
}

function isAbortError(error) {
    return Boolean(error) && (error.name === 'AbortError' || error.code === 'ABORT_ERR');
}

function toAbortError(message = 'Operation aborted') {
    const abortError = new Error(message);
    abortError.name = 'AbortError';
    abortError.code = 'ABORT_ERR';
    return abortError;
}

function throwIfAborted(signal) {
    if (signal?.aborted) {
        if (signal.reason instanceof Error) {
            throw signal.reason;
        }
        throw toAbortError(typeof signal.reason === 'string' ? signal.reason : undefined);
    }
}

function rethrowIfAbort(error) {
    if (isAbortError(error)) {
        throw error;
    }
}

function fallbackLogInfo(message) {
    (utilsLogInfo || console.log)(`[INFO] ${message}`);
}

function fallbackLogWarning(message) {
    (utilsLogWarning || console.warn)(`[WARNING] ${message}`);
}

function fallbackLogError(message, error = null) {
    if (utilsLogError) {
        utilsLogError(message, error);
        return;
    }
    if (error) {
        console.error(`[ERROR] ${message}:`, error);
    } else {
        console.error(`[ERROR] ${message}`);
    }
}

function walkFiles(rootDir, extensions, ignoreDirs = new Set(['node_modules', '.git', '.cursor']), signal = null) {
    throwIfAborted(signal);
    const results = [];
    const entries = fs.readdirSync(rootDir, { withFileTypes: true });
    for (const entry of entries) {
        throwIfAborted(signal);
        const fullPath = path.join(rootDir, entry.name);
        if (entry.isDirectory()) {
            if (ignoreDirs.has(entry.name)) continue;
            results.push(...walkFiles(fullPath, extensions, ignoreDirs, signal));
        } else if (extensions.some(ext => fullPath.toLowerCase().endsWith(ext))) {
            results.push(fullPath);
        }
    }
    return results;
}

async function processChunk(chunkId, content, filePath, modelVersion, language = null, chunkSize = null, chunkStartLine = null, signal = null) {
    throwIfAborted(signal);
    try {
        fallbackLogInfo(`[Processing] Processing chunk ${chunkId}...`);
        const { embeddingVector, failed, error } = await embedText(content);
        throwIfAborted(signal);
        if (!embeddingVector || failed) {
            fallbackLogError(`[Embedding] Skipping chunk ${chunkId} due to embedding failure: ${error || 'Unknown error'}`);
            return;
        }
        fallbackLogInfo(`[Embedding] Generated for chunk ${chunkId}`);

        const summaryText = await summarizeChunk(content);
        throwIfAborted(signal);
        fallbackLogInfo(`[Summary] Generated for chunk ${chunkId}`);

        await storeEmbeddingAndSummary(
            chunkId,
            filePath,
            content,
            embeddingVector,
            summaryText,
            modelVersion,
            language,
            chunkSize,
            chunkStartLine
        );

        // Update chunk counter
        updateIndexingStatus({
            chunksProcessed: indexingStatus.chunksProcessed + 1
        });

    } catch (e) {
        rethrowIfAbort(e);
        fallbackLogError(`[Processing] Failed to process chunk ${chunkId}:`, e);
        throw new Error(`Chunk processing failed for ${chunkId}. See logs for details.`);
    }
}

async function storeEmbeddingAndSummary(
    chunkId,
    filePath,
    normalizedContent,
    embeddingVector,
    summaryText,
    modelVersion,
    language = null,
    chunkSize = null,
    chunkStartLine = null
) {
    try {
        await faissIndexManager.addEmbedding(chunkId, embeddingVector);
        const currentChunkHash = generateChunkHash(normalizedContent);
        await sqliteCacheManager.store(
            chunkId,
            filePath,
            embeddingVector,
            summaryText,
            modelVersion,
            currentChunkHash,
            language,
            chunkSize,
            chunkStartLine
        );
        fallbackLogInfo(`[CACHE] Embeddings and summaries for chunk ${chunkId} stored successfully.`);
    } catch (error) {
        fallbackLogError('Failed to store embeddings/summaries:', error);
        throw error;
    }
}

async function cleanupDeletedChunks(signal = null) {
    throwIfAborted(signal);
    const allEntries = await sqliteCacheManager.getAllCachedChunks();
    const validEntries = [];

    for (const entry of allEntries) {
        throwIfAborted(signal);
        const exists = fs.existsSync(entry.file_path);
        if (!exists) {
            await sqliteCacheManager.deleteChunk(entry.chunk_id);
            fallbackLogWarning(`[Cleanup] Removed missing file chunk: ${entry.chunk_id} (${entry.file_path})`);
            continue;
        }
        if (entry.embedding) {
            validEntries.push({ chunkId: entry.chunk_id, embedding: entry.embedding });
        }
    }

    throwIfAborted(signal);
    await faissIndexManager.rebuild(validEntries);
}

async function runIndexer({ modelVersion = ragSummarizationModel.identifier, signal = null } = {}) {
    if (isCloudMode()) {
        fallbackLogInfo('[Middleware] Cloud mode active; skipping indexing and FAISS updates.');
        return;
    }

    // Initialize indexing status
    resetIndexingStatus();
    updateIndexingStatus({
        isActive: true,
        status: 'scanning',
        startTime: new Date().toISOString()
    });

    try {
        await ensureStoresInitialized();
        throwIfAborted(signal);
        const resolvedVersion = modelVersion || ragSummarizationModel.identifier;
        fallbackLogInfo(`[Middleware] Processing files using model version: ${resolvedVersion}`);

        await cleanupDeletedChunks(signal);

        const files = walkFiles(path.join(__dirname, '../'), ['.js', '.ts', '.py'], undefined, signal);
        fallbackLogInfo(`[Scanning] Found ${files.length} files to process.`);

        updateIndexingStatus({
            totalFiles: files.length,
            status: 'processing'
        });

    const workers = [];
    for (const filePath of files) {
        throwIfAborted(signal);
        updateIndexingStatus({
            currentFile: filePath,
            status: 'processing'
        });
        try {
            if (workers.length >= CONCURRENCY_LIMIT) {
                fallbackLogInfo('[Scanning] Waiting for active workers to complete...');
                await Promise.all(workers);
                workers.length = 0;
            }

            const content = fs.readFileSync(filePath).toString();
            if (!content) {
                fallbackLogWarning(`[Scanning] Empty file skipped: ${filePath}`);
                continue;
            }

            let language;
            if (/\.js$/i.test(filePath)) { language = 'javascript'; }
            else if (/\.ts$/i.test(filePath)) { language = 'typescript'; }
            else if (/\.py$/i.test(filePath)) { language = 'python'; }

            const normalizedContent = language === 'javascript' || language === 'typescript'
                ? CodeChunkGenerator.preProcess(content)
                : content;

            const lines = normalizedContent.split('\n');
            let startLine = 0;

            while (startLine < lines.length) {
                throwIfAborted(signal);
                const endLine = Math.min(startLine + MAX_CHUNK_SIZE, lines.length);
                const chunkId = generateChunkHash(filePath + ':' + startLine);
                const chunkContent = lines.slice(startLine, endLine).join('\n');
                const cachedEntry = await sqliteCacheManager.retrieve(chunkId);

                let needsRecompute = true;
                if (cachedEntry) {
                    try {
                        const { chunk_hash: oldChunkHash, timestamp } = cachedEntry;
                        const currentChunkHash = generateChunkHash(chunkContent);
                        if (currentChunkHash !== oldChunkHash) {
                            fallbackLogWarning(`[CACHE] Hash mismatch for chunk ${chunkId}. Recomputing.`);
                        } else {
                            const currentTime = Date.now();
                            const entryTime = new Date(timestamp).getTime();
                            const maxAge = CACHE_INVALIDATION_DAYS * 24 * 60 * 60 * 1000;
                            if (Number.isFinite(entryTime) && currentTime - entryTime > maxAge) {
                                fallbackLogWarning(`[CACHE] Chunk ${chunkId} is older than ${CACHE_INVALIDATION_DAYS} days. Recomputing.`);
                            } else {
                                fallbackLogInfo(`[Middleware] Cache validation passed for chunk ${chunkId}. Skipping.`);
                                needsRecompute = false;
                            }
                        }
                    } catch (err) {
                        fallbackLogError(`[Middleware] Cache validation failed for chunk ${chunkId}:`, err);
                    }
                } else {
                    fallbackLogWarning(`[CACHE] No cached entry found for chunk ${chunkId}. Generating new embeddings and summary.`);
                }

                if (needsRecompute) {
                    const currentStartLine = startLine;
                    const currentEndLine = endLine;
                    workers.push(
                        new Promise((resolve, reject) => {
                            setImmediate(() => {
                                const chunkSize = currentEndLine - currentStartLine;
                                const chunkStartLine = currentStartLine;
                                processChunk(chunkId, chunkContent, filePath, resolvedVersion, language, chunkSize, chunkStartLine, signal)
                                    .then(resolve)
                                    .catch(err => {
                                        if (isAbortError(err)) {
                                            reject(err);
                                            return;
                                        }
                                        fallbackLogError(`[Worker] Failed to process chunk ${chunkId}:`, err);
                                        resolve();
                                    });
                            });
                        })
                    );
                }

                startLine = endLine;
            }
        } catch (error) {
            rethrowIfAbort(error);
            fallbackLogError(`[Scanning] Failed to process file ${filePath}:`, error);
        }

        // Update file counter
        updateIndexingStatus({
            filesProcessed: indexingStatus.filesProcessed + 1
        });
    }

    if (workers.length) {
        await Promise.all(workers);
    }

    // Mark indexing as completed
    updateIndexingStatus({
        isActive: false,
        status: 'completed',
        currentFile: null
    });

    fallbackLogInfo('[Middleware] Indexing completed successfully.');
    } catch (error) {
    updateIndexingStatus({
        isActive: false,
        status: 'error',
        error: error.message,
        currentFile: null
    });

    if (isAbortError(error)) {
        fallbackLogInfo('[Middleware] Indexing aborted by user.');
    } else {
        fallbackLogError('[Middleware] Indexing failed:', error);
    }
    throw error;
    }
}

module.exports = { runIndexer, getIndexingStatus };
