#!/usr/bin/env node

/**
 * SQLite Cache Utilities for Rolling Summaries + Mini-RAG Middleware
 *
 * Handles:
 * - Initialization of SQLite database.
 * - Storing and retrieving cached embeddings/summaries metadata.
 * - Cache validation logic based on chunk_hash, model_version, and timestamps.
 */

const fs = require('fs');
const path = require('path');
const { Database } = require('sqlite3').verbose();
const crypto = require('crypto');
const { getStorageConfig, getProcessingConfig } = require('./config.js');

// Configuration
const storageConfig = getStorageConfig();
const processingConfig = getProcessingConfig();
const CACHE_DB_PATH = storageConfig.sqlite_db_path || './data/summaries.db';
const MAX_CACHE_AGE_DAYS = processingConfig.cache_invalidation_days || storageConfig.cache_invalidation_days || 7; // Cache invalidation threshold
const GLOBAL_CONVERSATION_ID = 'global';

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

// SQLite Cache Manager
class SQLiteCacheManager {
    constructor() {
        this.db = new Database(CACHE_DB_PATH);
    }

    /**
     * Initialize the SQLite database with required schema.
     */
    async initialize() {
        try {
            // Ensure directory exists for SQLite storage
            const targetDir = path.dirname(CACHE_DB_PATH);
            if (!fs.existsSync(targetDir)) {
                fs.mkdirSync(targetDir, { recursive: true });
            }

            logInfo('Initializing SQLite cache database...');

            await new Promise((resolve, reject) => {
                this.db.serialize(() => {
                    this.db.run(`
                        CREATE TABLE IF NOT EXISTS cached_chunks (
                            chunk_id TEXT PRIMARY KEY,
                            file_path TEXT NOT NULL,
                            embedding BLOB,
                            summary TEXT,
                            model_version TEXT NOT NULL,
                            chunk_hash TEXT NOT NULL,
                            chunk_start_line INTEGER,
                            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                            language TEXT,
                            chunk_size INTEGER
                        )
                    `);

                    this.db.run(`
                        CREATE TABLE IF NOT EXISTS rolling_summaries (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            conversation_id TEXT DEFAULT '${GLOBAL_CONVERSATION_ID}',
                            summary TEXT NOT NULL,
                            model_version TEXT NOT NULL,
                            turn_count INTEGER DEFAULT 0,
                            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
                        )
                    `);

                    // Create indexes for faster queries
                    this.db.run(`
                        CREATE INDEX IF NOT EXISTS idx_file_path ON cached_chunks(file_path)
                    `);
                    this.db.run(`
                        CREATE INDEX IF NOT EXISTS idx_chunk_hash ON cached_chunks(chunk_hash)
                    `);
                    this.db.run(`
                        CREATE INDEX IF NOT EXISTS idx_rolling_conversation ON rolling_summaries(conversation_id, timestamp DESC)
                    `);
                    resolve();
                });
            });

            await this.ensureRollingSummaryColumns();
            await this.ensureCachedChunkColumns();

            logInfo('SQLite cache database initialized successfully.');
        } catch (error) {
            logError('Failed to initialize SQLite cache database:', error);
            throw error;
        }
    }

    async ensureRollingSummaryColumns() {
        const columns = await this.getTableColumns('rolling_summaries');
        const ensureColumn = (name, ddl) => new Promise((resolve, reject) => {
            if (columns.includes(name)) return resolve();
            this.db.run(ddl, (err) => {
                if (err) return reject(err);
                resolve();
            });
        });

        await ensureColumn('conversation_id', `ALTER TABLE rolling_summaries ADD COLUMN conversation_id TEXT DEFAULT '${GLOBAL_CONVERSATION_ID}'`);
        await ensureColumn('turn_count', 'ALTER TABLE rolling_summaries ADD COLUMN turn_count INTEGER DEFAULT 0');
    }

    async ensureCachedChunkColumns() {
        const columns = await this.getTableColumns('cached_chunks');
        const ensureColumn = (name, ddl) => new Promise((resolve, reject) => {
            if (columns.includes(name)) return resolve();
            this.db.run(ddl, (err) => {
                if (err) return reject(err);
                resolve();
            });
        });

        await ensureColumn('chunk_start_line', 'ALTER TABLE cached_chunks ADD COLUMN chunk_start_line INTEGER');
    }

    async getTableColumns(tableName) {
        return new Promise((resolve, reject) => {
            this.db.all(`PRAGMA table_info(${tableName})`, [], (err, rows) => {
                if (err) return reject(err);
                resolve(rows.map((row) => row.name));
            });
        });
    }

    /**
     * Store embeddings and summaries metadata in the SQLite cache.
     */
    async store(chunkId, filePath, embeddingVector, summaryText, modelVersion, chunkHash, language = null, chunkSize = null, chunkStartLine = null) {
        try {
            logInfo(`Storing embeddings/summaries for chunk ${chunkId}...`);

            await new Promise((resolve, reject) => {
                this.db.run(`
                    INSERT OR REPLACE INTO cached_chunks (
                        chunk_id,
                        file_path,
                        embedding,
                        summary,
                        model_version,
                        chunk_hash,
                        chunk_start_line,
                        language,
                        chunk_size,
                        timestamp
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                `, [
                    chunkId,
                    filePath,
                    Buffer.from(Float32Array.from(embeddingVector).buffer),
                    summaryText,
                    modelVersion,
                    chunkHash,
                    typeof chunkStartLine === 'number' ? chunkStartLine : null,
                    language || null,
                    typeof chunkSize === 'number' ? chunkSize : null
                ], (err) => {
                    if (err) return reject(err);
                    resolve();
                });
            });

            logInfo(`Embeddings/summaries for chunk ${chunkId} stored successfully.`);
        } catch (error) {
            logError('Failed to store embeddings/summaries in SQLite cache:', error);
            throw error;
        }
    }

    /**
     * Retrieve cached embeddings and summaries metadata from the SQLite cache.
     */
    async retrieve(chunkId) {
        try {
            logInfo(`Retrieving cached embeddings/summaries for chunk ${chunkId}...`);

            return new Promise((resolve, reject) => {
                this.db.get(`
                    SELECT * FROM cached_chunks WHERE chunk_id = ?
                `, [chunkId], (err, row) => {
                    if (err) {
                        logError('Failed to retrieve embeddings/summaries from SQLite cache:', err);
                        return reject(err);
                    }

                    if (!row) {
                        resolve(null);
                    } else {
                        const cachedEntry = {
                            chunk_id: row.chunk_id,
                            file_path: row.file_path,
                            embedding: row.embedding ? Buffer.from(row.embedding) : null,
                            summary: row.summary,
                            model_version: row.model_version,
                            chunk_hash: row.chunk_hash,
                            chunk_start_line: typeof row.chunk_start_line === 'number' ? row.chunk_start_line : null,
                            timestamp: row.timestamp,
                            language: row.language || null,
                            chunk_size: typeof row.chunk_size === 'number' ? row.chunk_size : null
                        };
                        resolve(cachedEntry);
                    }
                });
            });
        } catch (error) {
            logError('Failed to retrieve embeddings/summaries from SQLite cache:', error);
            throw error;
        }
    }

    /**
     * Clear all cached data (chunks and rolling summaries).
     */
    async clearAll() {
        try {
            await new Promise((resolve, reject) => {
                this.db.serialize(() => {
                    this.db.run('DELETE FROM cached_chunks', (err) => {
                        if (err) return reject(err);
                        this.db.run('DELETE FROM rolling_summaries', (err2) => {
                            if (err2) return reject(err2);
                            resolve();
                        });
                    });
                });
            });
            logInfo('SQLite cache cleared (cached_chunks, rolling_summaries).');
        } catch (error) {
            logError('Failed to clear SQLite cache:', error);
            throw error;
        }
    }

    /**
     * Validate a cached entry based on chunk_hash, model_version, and timestamp.
     */
    async validate(chunkId, chunkHash, modelVersion) {
        try {
            const cachedEntry = await this.retrieve(chunkId);

            if (!cachedEntry) return false;

            // Check for hash mismatch
            if (cachedEntry.chunk_hash !== chunkHash) {
                logWarning(`Cache validation failed: Hash mismatch for chunk ${chunkId}`);
                return false;
            }

            // Check for model version mismatch
            if (cachedEntry.model_version !== modelVersion) {
                logWarning(`Cache validation failed: Model version mismatch for chunk ${chunkId}`);
                return false;
            }

            // Check for outdated timestamp
            const cacheAgeMs = Date.now() - new Date(cachedEntry.timestamp).getTime();
            const maxCacheAgeMs = MAX_CACHE_AGE_DAYS * 24 * 60 * 60 * 1000;

            if (cacheAgeMs > maxCacheAgeMs) {
                logWarning(`Cache validation failed: Cache entry for chunk ${chunkId} is older than ${MAX_CACHE_AGE_DAYS} days`);
                return false;
            }

            return true;
        } catch (error) {
            logError('Failed to validate cached entry:', error);
            throw error;
        }
    }

    /**
     * Retrieve all chunks associated with a specific file.
     */
    async retrieveAllChunksForFile(filePath) {
        try {
            logInfo(`Retrieving all chunks for file: ${filePath}...`);

            return new Promise((resolve, reject) => {
                this.db.all(`
                    SELECT chunk_id FROM cached_chunks WHERE file_path = ?
                `, [filePath], (err, rows) => {
                    if (err) {
                        logError('Failed to retrieve chunks for file:', err);
                        return reject(err);
                    }

                    resolve(rows.map(row => row.chunk_id));
                });
            });
        } catch (error) {
            logError('Failed to retrieve chunks for file:', error);
            throw error;
        }
    }

    /**
     * Retrieve all cached chunks (with embeddings as Float32Array).
     */
    async getAllCachedChunks() {
        try {
            logInfo('Retrieving all cached chunks...');
            return new Promise((resolve, reject) => {
                this.db.all(`
                    SELECT * FROM cached_chunks
                `, [], (err, rows) => {
                    if (err) {
                        // Gracefully handle missing table on fresh DB
                        if (err.message && err.message.includes('no such table')) {
                            logWarning('cached_chunks table missing; returning empty set.');
                            return resolve([]);
                        }
                        logError('Failed to retrieve cached chunks:', err);
                        return reject(err);
                    }
                    const entries = rows.map(row => ({
                        chunk_id: row.chunk_id,
                        file_path: row.file_path,
                        embedding: row.embedding ? new Float32Array(Buffer.from(row.embedding).buffer) : null,
                        summary: row.summary,
                        model_version: row.model_version,
                        chunk_hash: row.chunk_hash,
                        chunk_start_line: typeof row.chunk_start_line === 'number' ? row.chunk_start_line : null,
                        timestamp: row.timestamp,
                        language: row.language || null,
                        chunk_size: typeof row.chunk_size === 'number' ? row.chunk_size : null
                    }));
                    resolve(entries);
                });
            });
        } catch (error) {
            logError('Failed to retrieve all cached chunks:', error);
            throw error;
        }
    }

    /**
     * Delete a chunk by ID.
     */
    async deleteChunk(chunkId) {
        try {
            await new Promise((resolve, reject) => {
                this.db.run(`DELETE FROM cached_chunks WHERE chunk_id = ?`, [chunkId], (err) => {
                    if (err) return reject(err);
                    resolve();
                });
            });
            logInfo(`Deleted chunk ${chunkId} from cache.`);
        } catch (error) {
            logError(`Failed to delete chunk ${chunkId}:`, error);
            throw error;
        }
    }

    /**
     * Save rolling summary.
     */
    async saveRollingSummary(summary, modelVersion, conversationId = GLOBAL_CONVERSATION_ID, turnCount = 0) {
        try {
            await new Promise((resolve, reject) => {
                this.db.run(`
                    INSERT INTO rolling_summaries (conversation_id, summary, model_version, turn_count, timestamp)
                    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
                `, [conversationId, summary, modelVersion, turnCount], (err) => {
                    if (err) return reject(err);
                    resolve();
                });
            });
            logInfo(`Rolling summary saved for ${conversationId}.`);
        } catch (error) {
            logError('Failed to save rolling summary:', error);
            throw error;
        }
    }

    async getLatestRollingSummary(conversationId = GLOBAL_CONVERSATION_ID) {
        try {
            return new Promise((resolve, reject) => {
                this.db.get(`
                    SELECT summary, model_version, timestamp, turn_count, conversation_id
                    FROM rolling_summaries
                    WHERE conversation_id = ?
                    ORDER BY timestamp DESC
                    LIMIT 1
                `, [conversationId], (err, row) => {
                    if (err) {
                        if (err.message && err.message.includes('no such table')) {
                            logWarning('rolling_summaries table missing; returning null.');
                            return resolve(null);
                        }
                        return reject(err);
                    }
                    resolve(row || null);
                });
            });
        } catch (error) {
            logError('Failed to get latest rolling summary:', error);
            throw error;
        }
    }

    async getSessionSummaries(limit = 50) {
        try {
            return new Promise((resolve, reject) => {
                this.db.all(`
                    SELECT conversation_id,
                           MAX(timestamp) as last_activity,
                           MAX(turn_count) as turn_count,
                           COUNT(*) as updates
                    FROM rolling_summaries
                    GROUP BY conversation_id
                    ORDER BY last_activity DESC
                    LIMIT ?
                `, [limit], (err, rows) => {
                    if (err) return reject(err);
                    resolve(rows || []);
                });
            });
        } catch (error) {
            logError('Failed to list session summaries:', error);
            throw error;
        }
    }

    async purgeSessions({ conversationId = null, beforeTs = null } = {}) {
        try {
            const clauses = [];
            const params = [];
            if (conversationId) {
                clauses.push('conversation_id = ?');
                params.push(conversationId);
            }
            if (beforeTs) {
                clauses.push('timestamp <= ?');
                params.push(beforeTs);
            }

            const whereClause = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
            await new Promise((resolve, reject) => {
                this.db.run(`DELETE FROM rolling_summaries ${whereClause}`, params, (err) => {
                    if (err) return reject(err);
                    resolve();
                });
            });
        } catch (error) {
            logError('Failed to purge sessions:', error);
            throw error;
        }
    }

    /**
     * Close the SQLite database connection.
     */
    async close() {
        try {
            await new Promise((resolve, reject) => {
                this.db.close(resolve);
            });
            logInfo('SQLite cache database connection closed successfully.');
        } catch (error) {
            logError('Failed to close SQLite cache database:', error);
            throw error;
        }
    }
}

module.exports = { SQLiteCacheManager };