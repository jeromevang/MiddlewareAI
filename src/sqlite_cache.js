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

                    this.db.run(`
                        CREATE TABLE IF NOT EXISTS conversation_turns (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            conversation_id TEXT NOT NULL,
                            turn_index INTEGER NOT NULL,
                            user_prompt TEXT,
                            assistant_response TEXT,
                            raw_context TEXT,
                            composed_context TEXT,
                            budget_json TEXT,
                            rag_chunks_json TEXT,
                            compression_mode TEXT,
                            llm_payload_kind TEXT,
                            llm_payload_json TEXT,
                            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                        )
                    `);

                    this.db.run(`
                        CREATE TABLE IF NOT EXISTS session_context_modes (
                            conversation_id TEXT PRIMARY KEY,
                            mode TEXT NOT NULL,
                            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                        )
                    `);

                    this.db.run(`
                        CREATE INDEX IF NOT EXISTS idx_session_modes_mode ON session_context_modes(mode)
                    `);

                    // GPU Optimization Cache table
                    this.db.run(`
                        CREATE TABLE IF NOT EXISTS gpu_optimization_cache (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            combination_hash TEXT UNIQUE NOT NULL,
                            models_json TEXT NOT NULL,
                            settings_json TEXT NOT NULL,
                            total_vram_gb REAL,
                            avg_tokens_per_sec REAL,
                            calibrated_at TEXT NOT NULL,
                            gpu_name TEXT,
                            context_tested TEXT
                        )
                    `);

                    this.db.run(`
                        CREATE INDEX IF NOT EXISTS idx_gpu_opt_hash ON gpu_optimization_cache(combination_hash)
                    `);

                    // Agent memory table for persistent storage
                    this.db.run(`
                        CREATE TABLE IF NOT EXISTS agent_memory (
                            key TEXT PRIMARY KEY,
                            value TEXT NOT NULL,
                            category TEXT DEFAULT 'general',
                            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                        )
                    `);

                    this.db.run(`
                        CREATE INDEX IF NOT EXISTS idx_agent_memory_category ON agent_memory(category)
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
                    this.db.run(`
                        CREATE INDEX IF NOT EXISTS idx_turns_conversation ON conversation_turns(conversation_id, turn_index DESC)
                    `);
                    resolve();
                });
            });

            await this.ensureRollingSummaryColumns();
            await this.ensureCachedChunkColumns();
            await this.ensureConversationTurnColumns();

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

    async ensureConversationTurnColumns() {
        const columns = await this.getTableColumns('conversation_turns');
        const ensureColumn = (name, ddl) => new Promise((resolve, reject) => {
            if (columns.includes(name)) return resolve();
            this.db.run(ddl, (err) => {
                if (err) return reject(err);
                resolve();
            });
        });

        await ensureColumn('llm_payload_kind', 'ALTER TABLE conversation_turns ADD COLUMN llm_payload_kind TEXT');
        await ensureColumn('llm_payload_json', 'ALTER TABLE conversation_turns ADD COLUMN llm_payload_json TEXT');
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
                            this.db.run('DELETE FROM conversation_turns', (err3) => {
                                if (err3) return reject(err3);
                                resolve();
                            });
                        });
                    });
                });
            });
            logInfo('SQLite cache cleared (cached_chunks, rolling_summaries, conversation_turns).');
        } catch (error) {
            logError('Failed to clear SQLite cache:', error);
            throw error;
        }
    }

    /**
     * Clear all rolling summaries.
     */
    async clearRollingSummaries() {
        try {
            await new Promise((resolve, reject) => {
                this.db.run('DELETE FROM rolling_summaries', (err) => {
                    if (err) return reject(err);
                    resolve();
                });
            });
            logInfo('Rolling summaries cleared.');
        } catch (error) {
            logError('Failed to clear rolling summaries:', error);
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
                    SELECT ct.conversation_id,
                           MAX(ct.created_at) as last_activity,
                           MAX(ct.turn_index) as turn_count,
                           COUNT(*) as updates,
                           (
                               SELECT mode FROM session_context_modes scm
                               WHERE scm.conversation_id = ct.conversation_id
                           ) as context_mode_override,
                           (
                               SELECT recent.compression_mode
                               FROM conversation_turns recent
                               WHERE recent.conversation_id = ct.conversation_id
                               ORDER BY recent.turn_index DESC
                               LIMIT 1
                           ) as last_context_mode
                    FROM conversation_turns ct
                    GROUP BY ct.conversation_id
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

    async getSessionSummary(conversationId) {
        if (!conversationId) return null;
        try {
            return new Promise((resolve, reject) => {
                this.db.get(`
                    SELECT ct.conversation_id,
                           MAX(ct.created_at) as last_activity,
                           MAX(ct.turn_index) as turn_count,
                           COUNT(*) as updates,
                           (
                               SELECT mode FROM session_context_modes scm
                               WHERE scm.conversation_id = ct.conversation_id
                           ) as context_mode_override,
                           (
                               SELECT recent.compression_mode
                               FROM conversation_turns recent
                               WHERE recent.conversation_id = ct.conversation_id
                               ORDER BY recent.turn_index DESC
                               LIMIT 1
                           ) as last_context_mode
                    FROM conversation_turns ct
                    WHERE ct.conversation_id = ?
                `, [conversationId], (err, row) => {
                    if (err) return reject(err);
                    if (!row) return resolve(null);
                    resolve({
                        conversation_id: row.conversation_id || conversationId,
                        last_activity: row.last_activity || new Date().toISOString(),
                        turn_count: row.turn_count || 0,
                        updates: row.updates || 0,
                        context_mode_override: row.context_mode_override || null,
                        last_context_mode: row.last_context_mode || null,
                    });
                });
            });
        } catch (error) {
            logError('Failed to load session summary:', error);
            throw error;
        }
    }

    async purgeSessions({ conversationId = null, beforeTs = null } = {}) {
        try {
            const summaryClauses = [];
            const summaryParams = [];
            if (conversationId) {
                summaryClauses.push('conversation_id = ?');
                summaryParams.push(conversationId);
            }
            if (beforeTs) {
                summaryClauses.push('timestamp <= ?');
                summaryParams.push(beforeTs);
            }

            const summaryWhere = summaryClauses.length ? `WHERE ${summaryClauses.join(' AND ')}` : '';
            await new Promise((resolve, reject) => {
                this.db.run(`DELETE FROM rolling_summaries ${summaryWhere}`, summaryParams, (err) => {
                    if (err) return reject(err);
                    resolve();
                });
            });

            const turnClauses = [];
            const turnParams = [];
            if (conversationId) {
                turnClauses.push('conversation_id = ?');
                turnParams.push(conversationId);
            }
            if (beforeTs) {
                turnClauses.push('created_at <= ?');
                turnParams.push(beforeTs);
            }
            const turnsWhere = turnClauses.length ? `WHERE ${turnClauses.join(' AND ')}` : '';

            const affectedConversationIds = await new Promise((resolve, reject) => {
                this.db.all(`
                    SELECT DISTINCT conversation_id
                    FROM conversation_turns
                    ${turnsWhere}
                `, turnParams, (err, rows) => {
                    if (err) return reject(err);
                    resolve(rows || []);
                });
            });

            await new Promise((resolve, reject) => {
                this.db.run(`DELETE FROM conversation_turns ${turnsWhere}`, turnParams, (err) => {
                    if (err) return reject(err);
                    resolve();
                });
            });

            for (const row of affectedConversationIds) {
                const targetId = row?.conversation_id;
                if (targetId) {
                    await this.clearSessionContextMode(targetId);
                }
            }
        } catch (error) {
            logError('Failed to purge sessions:', error);
            throw error;
        }
    }

    async setSessionContextMode(conversationId, mode) {
        if (!conversationId) {
            throw new Error('conversationId is required');
        }
        if (!mode) {
            return this.clearSessionContextMode(conversationId);
        }
        return new Promise((resolve, reject) => {
            this.db.run(`
                INSERT INTO session_context_modes (conversation_id, mode, updated_at)
                VALUES (?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(conversation_id)
                DO UPDATE SET mode = excluded.mode, updated_at = CURRENT_TIMESTAMP
            `, [conversationId, mode], (err) => {
                if (err) return reject(err);
                resolve();
            });
        });
    }

    async clearSessionContextMode(conversationId) {
        if (!conversationId) return Promise.resolve();
        return new Promise((resolve, reject) => {
            this.db.run('DELETE FROM session_context_modes WHERE conversation_id = ?', [conversationId], (err) => {
                if (err) return reject(err);
                resolve();
            });
        });
    }

    async getSessionContextMode(conversationId) {
        if (!conversationId) return null;
        return new Promise((resolve, reject) => {
            this.db.get('SELECT mode FROM session_context_modes WHERE conversation_id = ?', [conversationId], (err, row) => {
                if (err) return reject(err);
                resolve(row ? row.mode : null);
            });
        });
    }

    async saveConversationTurn({
        conversationId = GLOBAL_CONVERSATION_ID,
        userPrompt = null,
        assistantResponse = null,
        rawContext = null,
        composedContext = null,
        budgetInfo = null,
        ragChunks = null,
        compressionMode = null,
        llmPayloadKind = null,
        llmPayload = null,
    } = {}) {
        const budgetJson = budgetInfo ? JSON.stringify(budgetInfo) : null;
        const ragChunksJson = ragChunks ? JSON.stringify(ragChunks) : null;
        const llmPayloadJson = llmPayload ? JSON.stringify(llmPayload) : null;

        // Calculate the next turn_index separately to avoid subquery in INSERT
        let nextTurnIndex;
        try {
            nextTurnIndex = await new Promise((resolve, reject) => {
                this.db.get(
                    `SELECT COALESCE(MAX(turn_index) + 1, 1) AS next FROM conversation_turns WHERE conversation_id = ?`,
                    [conversationId],
                    (err, row) => {
                        if (err) return reject(err);
                        resolve(row ? row.next : 1);
                    }
                );
            });
        } catch (err) {
            logError('Failed to calculate next turn_index:', err);
            throw err;
        }

        return new Promise((resolve, reject) => {
            this.db.run(
                `
                INSERT INTO conversation_turns (
                    conversation_id,
                    turn_index,
                    user_prompt,
                    assistant_response,
                    raw_context,
                    composed_context,
                    budget_json,
                    rag_chunks_json,
                    compression_mode,
                    llm_payload_kind,
                    llm_payload_json,
                    created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                `,
                [
                    conversationId,
                    nextTurnIndex,
                    userPrompt,
                    assistantResponse,
                    rawContext,
                    composedContext,
                    budgetJson,
                    ragChunksJson,
                    compressionMode,
                    llmPayloadKind,
                    llmPayloadJson,
                ],
                function (err) {
                    if (err) return reject(err);
                    resolve(this.lastID || null);
                }
            );
        });
    }

    async getRecentTurns(conversationId, limit = 3) {
        if (!conversationId || !limit) return [];
        return new Promise((resolve, reject) => {
            this.db.all(
                `SELECT turn_index, user_prompt, assistant_response
                 FROM conversation_turns
                 WHERE conversation_id = ?
                 ORDER BY turn_index DESC
                 LIMIT ?`,
                [conversationId, limit],
                (err, rows) => {
                    if (err) return reject(err);
                    resolve((rows || []).reverse().map((row) => ({
                        turnIndex: row.turn_index,
                        userPrompt: row.user_prompt || '',
                        assistantResponse: row.assistant_response || '',
                    })));
                }
            );
        });
    }

    async getTurnsForSummary(conversationId, excludeLatest = 0) {
        if (!conversationId) {
            return { eligibleTurns: [], totalTurns: 0 };
        }
        return new Promise((resolve, reject) => {
            this.db.all(
                `SELECT turn_index, user_prompt, assistant_response
                 FROM conversation_turns
                 WHERE conversation_id = ?
                 ORDER BY turn_index ASC`,
                [conversationId],
                (err, rows) => {
                    if (err) return reject(err);
                    const allTurns = (rows || []).map((row) => ({
                        turnIndex: row.turn_index,
                        userPrompt: row.user_prompt || '',
                        assistantResponse: row.assistant_response || '',
                    }));
                    const totalTurns = allTurns.length;
                    const cutoff = Math.max(0, totalTurns - Math.max(0, excludeLatest));
                    resolve({
                        eligibleTurns: allTurns.slice(0, cutoff),
                        totalTurns,
                    });
                }
            );
        });
    }

    async getAllConversationIds() {
        return new Promise((resolve, reject) => {
            this.db.all(
                `SELECT DISTINCT conversation_id AS id FROM conversation_turns`,
                [],
                (err, rows) => {
                    if (err) return reject(err);
                    resolve((rows || []).map((row) => row.id));
                }
            );
        });
    }

    async getConversationTurnById(turnId) {
        if (!turnId) return null;
        return new Promise((resolve, reject) => {
            this.db.get(`
                SELECT id,
                       conversation_id,
                       turn_index,
                       user_prompt,
                       assistant_response,
                       raw_context,
                       composed_context,
                       budget_json,
                       rag_chunks_json,
                      compression_mode,
                      llm_payload_kind,
                      llm_payload_json,
                       created_at
                FROM conversation_turns
                WHERE id = ?
            `, [turnId], (err, row) => {
                if (err) return reject(err);
                resolve(mapConversationTurnRow(row));
            });
        });
    }

    async getConversationTurns(conversationId, { limit = 50, offset = 0 } = {}) {
        if (!conversationId) {
            throw new Error('conversationId is required');
        }
        return new Promise((resolve, reject) => {
            this.db.all(`
                SELECT id,
                       conversation_id,
                       turn_index,
                       user_prompt,
                       assistant_response,
                       raw_context,
                       composed_context,
                       budget_json,
                       rag_chunks_json,
                      compression_mode,
                      llm_payload_kind,
                      llm_payload_json,
                       created_at
                FROM conversation_turns
                WHERE conversation_id = ?
                ORDER BY turn_index DESC
                LIMIT ?
                OFFSET ?
            `, [conversationId, limit, offset], (err, rows) => {
                if (err) return reject(err);
                const mapped = (rows || []).map(mapConversationTurnRow).filter(Boolean);
                resolve(mapped);
            });
        });
    }

    // ==========================================================================
    // DEBUG / DIAGNOSTICS METHODS
    // ==========================================================================

    /**
     * Get chunk by ID for debug purposes.
     */
    async getChunkById(chunkId) {
        return new Promise((resolve, reject) => {
            this.db.get(`
                SELECT chunk_id as id, file_path, chunk_start_line as chunk_index, 
                       embedding, summary, chunk_size as tokens, timestamp as created_at
                FROM cached_chunks WHERE chunk_id = ?
            `, [chunkId], (err, row) => {
                if (err) return reject(err);
                if (!row) return resolve(null);
                
                // Try to get original code from summary or file (simplified for debug)
                resolve({
                    id: row.id,
                    file_path: row.file_path,
                    chunk_index: row.chunk_index || 0,
                    original_code: row.summary ? `[Chunk from ${row.file_path}]` : '',
                    summary: row.summary,
                    tokens: row.tokens || 0,
                    created_at: row.created_at
                });
            });
        });
    }

    /**
     * Get database statistics for debug.
     */
    async getStats() {
        return new Promise((resolve, reject) => {
            this.db.get(`
                SELECT 
                    COUNT(*) as chunkCount,
                    COUNT(DISTINCT file_path) as fileCount,
                    SUM(chunk_size) as totalTokens,
                    AVG(chunk_size) as avgChunkSize,
                    MAX(timestamp) as lastIndexed
                FROM cached_chunks
            `, [], (err, row) => {
                if (err) return reject(err);
                resolve({
                    chunkCount: row?.chunkCount || 0,
                    fileCount: row?.fileCount || 0,
                    totalTokens: row?.totalTokens || 0,
                    avgChunkSize: Math.round(row?.avgChunkSize || 0),
                    lastIndexed: row?.lastIndexed || null
                });
            });
        });
    }

    /**
     * Get list of indexed files with chunk counts.
     */
    async getIndexedFiles() {
        return new Promise((resolve, reject) => {
            this.db.all(`
                SELECT file_path as path, COUNT(*) as chunkCount, SUM(chunk_size) as totalTokens
                FROM cached_chunks
                GROUP BY file_path
                ORDER BY file_path
            `, [], (err, rows) => {
                if (err) return reject(err);
                resolve(rows || []);
            });
        });
    }

    /**
     * Get chunks with optional filtering (for debug explorer).
     */
    async getChunks({ filePath = null, limit = 50, offset = 0 } = {}) {
        let sql = `
            SELECT chunk_id as id, file_path as filePath, chunk_start_line as chunkIndex,
                   summary, chunk_size as tokens, timestamp as createdAt
            FROM cached_chunks
        `;
        const params = [];
        
        if (filePath) {
            sql += ' WHERE file_path = ?';
            params.push(filePath);
        }
        
        sql += ' ORDER BY file_path, chunk_start_line LIMIT ? OFFSET ?';
        params.push(limit, offset);
        
        return new Promise((resolve, reject) => {
            this.db.all(sql, params, (err, rows) => {
                if (err) return reject(err);
                resolve(rows || []);
            });
        });
    }

    /**
     * Clear all chunks (for re-indexing).
     */
    async clearChunks() {
        return new Promise((resolve, reject) => {
            this.db.run('DELETE FROM cached_chunks', [], (err) => {
                if (err) return reject(err);
                logInfo('All cached chunks cleared for re-indexing.');
                resolve();
            });
        });
    }

    // =============================================================================
    // GPU Optimization Cache Methods
    // =============================================================================

    /**
     * Ensure the GPU optimization cache table exists
     */
    async ensureGPUOptimizationTable() {
        return new Promise((resolve, reject) => {
            this.db.run(`
                CREATE TABLE IF NOT EXISTS gpu_optimization_cache (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    combination_hash TEXT UNIQUE NOT NULL,
                    models_json TEXT NOT NULL,
                    settings_json TEXT NOT NULL,
                    total_vram_gb REAL,
                    avg_tokens_per_sec REAL,
                    calibrated_at TEXT NOT NULL,
                    gpu_name TEXT,
                    context_tested TEXT
                )
            `, (err) => {
                if (err) return reject(err);
                this.db.run(`
                    CREATE INDEX IF NOT EXISTS idx_gpu_opt_hash ON gpu_optimization_cache(combination_hash)
                `, (err2) => {
                    if (err2) return reject(err2);
                    resolve();
                });
            });
        });
    }

    /**
     * Save GPU optimization result to cache
     * @param {Object} result - Optimization result
     */
    async saveGPUOptimization(result) {
        const {
            combinationHash,
            models,
            settings,
            totalVRAMUsed,
            calibratedAt,
            gpuName,
            contextTested
        } = result;

        // Calculate average tokens/sec across all models
        const settingsArray = Object.values(settings);
        const avgTokensPerSec = settingsArray.length > 0
            ? settingsArray.reduce((sum, s) => sum + (s.tokensPerSecond || 0), 0) / settingsArray.length
            : 0;

        return new Promise((resolve, reject) => {
            this.db.run(`
                INSERT OR REPLACE INTO gpu_optimization_cache 
                (combination_hash, models_json, settings_json, total_vram_gb, avg_tokens_per_sec, calibrated_at, gpu_name, context_tested)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                combinationHash,
                JSON.stringify(models),
                JSON.stringify(settings),
                totalVRAMUsed || 0,
                avgTokensPerSec,
                calibratedAt,
                gpuName || 'Unknown',
                JSON.stringify(contextTested || {})
            ], function(err) {
                if (err) {
                    logError('Failed to save GPU optimization:', err);
                    return reject(err);
                }
                logInfo(`Saved GPU optimization for ${combinationHash}`);
                resolve({ id: this.lastID, combinationHash });
            });
        });
    }

    /**
     * Get GPU optimization settings by combination hash
     * @param {string} combinationHash 
     * @returns {Promise<Object|null>}
     */
    async getGPUOptimization(combinationHash) {
        return new Promise((resolve, reject) => {
            this.db.get(
                'SELECT * FROM gpu_optimization_cache WHERE combination_hash = ?',
                [combinationHash],
                (err, row) => {
                    if (err) {
                        logError('Failed to get GPU optimization:', err);
                        return reject(err);
                    }
                    if (!row) return resolve(null);
                    
                    resolve({
                        id: row.id,
                        combinationHash: row.combination_hash,
                        models: JSON.parse(row.models_json),
                        settings: JSON.parse(row.settings_json),
                        totalVRAMUsed: row.total_vram_gb,
                        avgTokensPerSec: row.avg_tokens_per_sec,
                        calibratedAt: row.calibrated_at,
                        gpuName: row.gpu_name,
                        contextTested: row.context_tested ? JSON.parse(row.context_tested) : null
                    });
                }
            );
        });
    }

    /**
     * Delete GPU optimization settings by combination hash
     * @param {string} combinationHash 
     */
    async deleteGPUOptimization(combinationHash) {
        return new Promise((resolve, reject) => {
            this.db.run(
                'DELETE FROM gpu_optimization_cache WHERE combination_hash = ?',
                [combinationHash],
                function(err) {
                    if (err) {
                        logError('Failed to delete GPU optimization:', err);
                        return reject(err);
                    }
                    logInfo(`Deleted GPU optimization for ${combinationHash}`);
                    resolve({ changes: this.changes });
                }
            );
        });
    }

    /**
     * Get all GPU optimization entries
     * @returns {Promise<Array>}
     */
    async getAllGPUOptimizations() {
        return new Promise((resolve, reject) => {
            this.db.all(
                'SELECT * FROM gpu_optimization_cache ORDER BY calibrated_at DESC',
                [],
                (err, rows) => {
                    if (err) {
                        logError('Failed to get all GPU optimizations:', err);
                        return reject(err);
                    }
                    resolve((rows || []).map(row => ({
                        id: row.id,
                        combinationHash: row.combination_hash,
                        models: JSON.parse(row.models_json),
                        settings: JSON.parse(row.settings_json),
                        totalVRAMUsed: row.total_vram_gb,
                        avgTokensPerSec: row.avg_tokens_per_sec,
                        calibratedAt: row.calibrated_at,
                        gpuName: row.gpu_name
                    })));
                }
            );
        });
    }

    // =========================
    // Agent Memory Operations
    // =========================

    /**
     * Save a value to agent permanent memory
     * @param {string} key - Unique key
     * @param {string} value - Value to store
     * @param {string} category - Optional category
     */
    async saveAgentMemory(key, value, category = 'general') {
        return new Promise((resolve, reject) => {
            this.db.run(`
                INSERT OR REPLACE INTO agent_memory (key, value, category, updated_at)
                VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            `, [key, value, category], function(err) {
                if (err) {
                    logError('Failed to save agent memory:', err);
                    return reject(err);
                }
                resolve({ key, category, updated: true });
            });
        });
    }

    /**
     * Get a value from agent permanent memory
     * @param {string} key - Key to retrieve
     */
    async getAgentMemory(key) {
        return new Promise((resolve, reject) => {
            this.db.get(
                'SELECT * FROM agent_memory WHERE key = ?',
                [key],
                (err, row) => {
                    if (err) {
                        logError('Failed to get agent memory:', err);
                        return reject(err);
                    }
                    if (!row) {
                        return resolve(null);
                    }
                    resolve({
                        key: row.key,
                        value: row.value,
                        category: row.category,
                        createdAt: row.created_at,
                        updatedAt: row.updated_at
                    });
                }
            );
        });
    }

    /**
     * Delete a value from agent permanent memory
     * @param {string} key - Key to delete
     */
    async deleteAgentMemory(key) {
        return new Promise((resolve, reject) => {
            this.db.run(
                'DELETE FROM agent_memory WHERE key = ?',
                [key],
                function(err) {
                    if (err) {
                        logError('Failed to delete agent memory:', err);
                        return reject(err);
                    }
                    resolve({ deleted: this.changes > 0 });
                }
            );
        });
    }

    /**
     * List all agent memories, optionally filtered by category
     * @param {string} category - Optional category filter
     */
    async listAgentMemories(category = null) {
        return new Promise((resolve, reject) => {
            let query = 'SELECT key, category, updated_at FROM agent_memory';
            let params = [];
            
            if (category) {
                query += ' WHERE category = ?';
                params.push(category);
            }
            
            query += ' ORDER BY updated_at DESC';
            
            this.db.all(query, params, (err, rows) => {
                if (err) {
                    logError('Failed to list agent memories:', err);
                    return reject(err);
                }
                resolve((rows || []).map(row => ({
                    key: row.key,
                    category: row.category,
                    updatedAt: row.updated_at
                })));
            });
        });
    }

    /**
     * Clear all agent memories (dangerous!)
     */
    async clearAgentMemories() {
        return new Promise((resolve, reject) => {
            this.db.run('DELETE FROM agent_memory', function(err) {
                if (err) {
                    logError('Failed to clear agent memories:', err);
                    return reject(err);
                }
                resolve({ cleared: this.changes });
            });
        });
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

function mapConversationTurnRow(row) {
    if (!row) return null;
    const parseJson = (value) => {
        if (!value) return null;
        try {
            return JSON.parse(value);
        } catch (jsonErr) {
            logWarning(`Failed to parse JSON payload for conversation turn: ${jsonErr?.message || jsonErr}`);
            return null;
        }
    };
    return {
        id: row.id,
        conversationId: row.conversation_id,
        turnIndex: row.turn_index,
        userPrompt: row.user_prompt || '',
        assistantResponse: row.assistant_response || '',
        rawContext: row.raw_context || '',
        composedContext: row.composed_context || '',
        budget: parseJson(row.budget_json),
        ragChunks: parseJson(row.rag_chunks_json) || [],
        compressionMode: row.compression_mode || null,
        llmPayloadKind: row.llm_payload_kind || null,
        llmPayload: parseJson(row.llm_payload_json),
        createdAt: row.created_at,
    };
}

module.exports = { SQLiteCacheManager };