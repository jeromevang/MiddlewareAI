/**
 * RAG Routes
 * Handles: /search, /query, /reindex, /reset
 */
const express = require('express');

/**
 * Create RAG routes
 * @param {Object} deps - Dependencies
 * @returns {express.Router}
 */
function createRagRoutes(deps) {
    const router = express.Router();
    const {
        ragService,
        faissIndexManager,
        sqliteCacheManager,
        startIndexer,
        stopActiveIndexer,
        isIndexingInProgress,
        appendLog
    } = deps;

    /**
     * POST /search - RAG search
     */
    router.post('/search', async (req, res) => {
        try {
            const { query, topK = 5 } = req.body;
            
            if (!query) {
                return res.status(400).json({ error: 'query is required' });
            }
            
            const results = await ragService.search(query, topK);
            res.json({ results });
        } catch (error) {
            console.error('[API] Search failed:', error.message);
            res.status(500).json({ error: 'Search failed', details: error.message });
        }
    });

    /**
     * POST /query - Full RAG query with LLM response
     */
    router.post('/query', async (req, res) => {
        try {
            const { prompt, topK = 5, temperature = 0.7 } = req.body;
            
            if (!prompt) {
                return res.status(400).json({ error: 'prompt is required' });
            }
            
            const result = await ragService.query(prompt, { topK, temperature });
            res.json(result);
        } catch (error) {
            console.error('[API] Query failed:', error.message);
            res.status(500).json({ error: 'Query failed', details: error.message });
        }
    });

    /**
     * POST /reindex - Trigger reindexing
     */
    router.post('/reindex', async (req, res) => {
        try {
            if (isIndexingInProgress()) {
                return res.status(409).json({ error: 'Indexing already in progress' });
            }
            
            const { background = true, modelVersion = null } = req.body || {};
            
            appendLog('Reindexing triggered via API', 'info');
            
            if (background) {
                // Start in background and return immediately
                startIndexer({ modelVersion, reason: 'api-trigger', background: true });
                res.json({ status: 'ok', message: 'Reindexing started in background' });
            } else {
                // Wait for completion
                const result = await startIndexer({ modelVersion, reason: 'api-trigger', background: false });
                res.json({ status: 'ok', message: 'Reindexing complete', result });
            }
        } catch (error) {
            console.error('[API] Reindex failed:', error.message);
            res.status(500).json({ error: 'Reindex failed', details: error.message });
        }
    });

    /**
     * POST /reset - Reset the system (clear caches, indexes)
     */
    router.post('/reset', async (req, res) => {
        try {
            const { clearIndex = true, clearCache = true, clearSessions = false } = req.body || {};
            
            // Stop any active indexer
            await stopActiveIndexer('reset');
            
            if (clearIndex) {
                await faissIndexManager.clear();
                appendLog('FAISS index cleared', 'info');
            }
            
            if (clearCache) {
                await sqliteCacheManager.clearEmbeddingCache();
                appendLog('Embedding cache cleared', 'info');
            }
            
            if (clearSessions) {
                await sqliteCacheManager.deleteAllSessions();
                appendLog('All sessions cleared', 'info');
            }
            
            appendLog('System reset complete', 'info');
            res.json({ status: 'ok', message: 'Reset complete' });
        } catch (error) {
            console.error('[API] Reset failed:', error.message);
            res.status(500).json({ error: 'Reset failed', details: error.message });
        }
    });

    return router;
}

module.exports = { createRagRoutes };
