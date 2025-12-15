/**
 * Sessions Routes
 * Handles: /sessions/*, /processing/*, /summary/*
 */
const express = require('express');

/**
 * Create sessions routes
 * @param {Object} deps - Dependencies
 * @returns {express.Router}
 */
function createSessionsRoutes(deps) {
    const router = express.Router();
    const {
        sqliteCacheManager,
        getSessionList,
        decorateSessionMetaRows,
        buildFallbackSessionMeta,
        recomputeRollingSummary,
        getSummaryKeepRecentTurns,
        setSummaryKeepRecentTurns,
        getContextModeDefault,
        setContextModeDefault,
        normalizeContextModeValue,
        appendLog
    } = deps;

    /**
     * GET /sessions - List sessions
     */
    router.get('/sessions', async (req, res) => {
        try {
            const limit = parseInt(req.query.limit, 10) || 100;
            const contextMode = req.query.contextMode || null;
            const sessions = await getSessionList({ limit, contextMode });
            res.json({ sessions });
        } catch (error) {
            console.error('[API] Failed to list sessions:', error.message);
            res.status(500).json({ error: 'Failed to list sessions', details: error.message });
        }
    });

    /**
     * GET /sessions/:conversationId/turns - Get session turns
     */
    router.get('/sessions/:conversationId/turns', async (req, res) => {
        try {
            const { conversationId } = req.params;
            const limit = parseInt(req.query.limit, 10) || 50;
            const offset = parseInt(req.query.offset, 10) || 0;
            
            const turns = await sqliteCacheManager.getConversationTurns(conversationId, limit, offset);
            const meta = await sqliteCacheManager.getSessionMeta(conversationId);
            
            res.json({ 
                conversationId, 
                turns, 
                meta: meta || buildFallbackSessionMeta(conversationId),
                total: turns.length 
            });
        } catch (error) {
            console.error('[API] Failed to get session turns:', error.message);
            res.status(500).json({ error: 'Failed to get session turns', details: error.message });
        }
    });

    /**
     * PATCH /sessions/:conversationId/context-mode - Update session context mode
     */
    router.patch('/sessions/:conversationId/context-mode', async (req, res) => {
        try {
            const { conversationId } = req.params;
            const { contextMode } = req.body;
            
            const normalized = normalizeContextModeValue(contextMode);
            if (!normalized) {
                return res.status(400).json({ error: 'Invalid contextMode value' });
            }
            
            await sqliteCacheManager.updateSessionContextMode(conversationId, normalized);
            appendLog(`Session ${conversationId} context mode set to ${normalized}`, 'info');
            
            res.json({ status: 'ok', conversationId, contextMode: normalized });
        } catch (error) {
            console.error('[API] Failed to update session context mode:', error.message);
            res.status(500).json({ error: 'Failed to update context mode', details: error.message });
        }
    });

    /**
     * POST /sessions/purge - Purge sessions
     */
    router.post('/sessions/purge', async (req, res) => {
        try {
            const { conversationId, beforeTs } = req.body || {};
            
            if (conversationId) {
                await sqliteCacheManager.deleteSession(conversationId);
                appendLog(`Session ${conversationId} purged`, 'info');
            } else if (beforeTs) {
                const ts = new Date(beforeTs).getTime();
                await sqliteCacheManager.deleteSessionsBefore(ts);
                appendLog(`Sessions before ${beforeTs} purged`, 'info');
            } else {
                await sqliteCacheManager.deleteAllSessions();
                appendLog('All sessions purged', 'info');
            }
            
            res.json({ status: 'ok' });
        } catch (error) {
            console.error('[API] Failed to purge sessions:', error.message);
            res.status(500).json({ error: 'Failed to purge sessions', details: error.message });
        }
    });

    /**
     * PATCH /processing/summary-keep - Update summary keep recent count
     */
    router.patch('/processing/summary-keep', (req, res) => {
        try {
            const { keepRecentTurns } = req.body;
            
            if (typeof keepRecentTurns !== 'number' || keepRecentTurns < 0) {
                return res.status(400).json({ error: 'keepRecentTurns must be a non-negative number' });
            }
            
            setSummaryKeepRecentTurns(keepRecentTurns);
            appendLog(`Summary keep recent set to ${keepRecentTurns}`, 'info');
            
            res.json({ status: 'ok', keepRecentTurns });
        } catch (error) {
            console.error('[API] Failed to update summary keep:', error.message);
            res.status(500).json({ error: 'Failed to update', details: error.message });
        }
    });

    /**
     * PATCH /processing/context-mode - Update default context mode
     */
    router.patch('/processing/context-mode', (req, res) => {
        try {
            const { contextMode } = req.body;
            
            const normalized = normalizeContextModeValue(contextMode);
            if (!normalized) {
                return res.status(400).json({ error: 'Invalid contextMode value' });
            }
            
            setContextModeDefault(normalized);
            appendLog(`Default context mode set to ${normalized}`, 'info');
            
            res.json({ status: 'ok', contextMode: normalized });
        } catch (error) {
            console.error('[API] Failed to update context mode:', error.message);
            res.status(500).json({ error: 'Failed to update', details: error.message });
        }
    });

    /**
     * POST /summary/reprocess - Reprocess summaries for a session
     */
    router.post('/summary/reprocess', async (req, res) => {
        try {
            const { conversationId } = req.body;
            
            if (!conversationId) {
                return res.status(400).json({ error: 'conversationId is required' });
            }
            
            const keepRecent = getSummaryKeepRecentTurns();
            await recomputeRollingSummary(conversationId, keepRecent);
            appendLog(`Summary reprocessed for ${conversationId}`, 'info');
            
            res.json({ status: 'ok', conversationId });
        } catch (error) {
            console.error('[API] Failed to reprocess summary:', error.message);
            res.status(500).json({ error: 'Failed to reprocess', details: error.message });
        }
    });

    return router;
}

module.exports = { createSessionsRoutes };
