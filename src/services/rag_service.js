#!/usr/bin/env node

const { extractChunkFromFile, generateChunkHash } = require('../chunk_utils.js');

function estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
}

function buildContextWithBudget({
    rollingSummaryText,
    ragResults = [],
    userPrompt,
    budgetTokens
}) {
    let used = 0;
    let rawTokens = 0;
    const parts = [];
    const info = {
        budgetTokens,
        usedTokens: 0,
        trimmed: false,
        keptRag: 0,
        totalRag: ragResults.length,
        rawTokens: 0,
        savedTokens: 0,
        compressionPct: 0
    };

    if (rollingSummaryText) {
        const rsTokens = estimateTokens(rollingSummaryText);
        rawTokens += rsTokens;
        if (used + rsTokens > budgetTokens) {
            const availableChars = Math.max(0, (budgetTokens - used) * 4);
            const trimmedRs = rollingSummaryText.slice(-availableChars);
            parts.push(`Rolling summary (trimmed):\n${trimmedRs}`);
            info.trimmed = true;
            used = budgetTokens;
        } else {
            parts.push(`Rolling summary:\n${rollingSummaryText}`);
            used += rsTokens;
        }
    }

    for (const r of ragResults) {
        const snippet = `- [${r.filePath}] (${r.distance.toFixed(4)}): ${r.summaryText}`;
        const t = estimateTokens(snippet);
        rawTokens += t;
        if (used + t > budgetTokens) {
            info.trimmed = true;
            break;
        }
        parts.push(snippet);
        used += t;
        info.keptRag += 1;
    }

    const promptTokens = estimateTokens(userPrompt);
    rawTokens += promptTokens;
    if (used + promptTokens > budgetTokens) {
        const availableChars = Math.max(0, (budgetTokens - used) * 4);
        const trimmedPrompt = userPrompt.slice(-availableChars);
        parts.push(`User prompt (trimmed):\n${trimmedPrompt}`);
        info.trimmed = true;
        used = budgetTokens;
    } else {
        parts.push(`User prompt:\n${userPrompt}`);
        used += promptTokens;
    }

    info.usedTokens = used;
    info.rawTokens = rawTokens;
    info.savedTokens = Math.max(rawTokens - used, 0);
    info.compressionPct = rawTokens ? Number(((info.savedTokens / rawTokens) * 100).toFixed(1)) : 0;
    return { contextText: parts.join('\n\n'), info };
}

function extractAssistantText(completionPayload) {
    if (!completionPayload) return '';
    if (typeof completionPayload === 'string') return completionPayload;
    const choice = completionPayload.choices?.[0];
    if (choice?.message?.content) {
        return choice.message.content;
    }
    if (choice?.delta?.content) {
        return choice.delta.content;
    }
    return JSON.stringify(completionPayload);
}

function computeFreshChunkHash(cachedEntry) {
    if (!cachedEntry) {
        return { hash: null, status: 'missing-entry' };
    }
    const hasRange = typeof cachedEntry.chunk_start_line === 'number' && typeof cachedEntry.chunk_size === 'number';
    if (!hasRange) {
        return { hash: null, status: 'missing-range' };
    }
    const chunkContent = extractChunkFromFile({
        filePath: cachedEntry.file_path,
        language: cachedEntry.language,
        startLine: cachedEntry.chunk_start_line,
        length: cachedEntry.chunk_size,
    });
    if (chunkContent === null) {
        return { hash: null, status: 'unreadable' };
    }
    return { hash: generateChunkHash(chunkContent), status: 'ok' };
}

function createRagService({ sqliteCacheManager, faissIndexManager, embedText, isRagEnabled, isIndexing }) {
    async function ragSearch(queryText, topK = 5) {
        if (!isRagEnabled()) {
            return [];
        }

        if (isIndexing()) {
            return [];
        }

        try {
            const { embeddingVector } = await embedText(queryText);
            if (!embeddingVector || (!Array.isArray(embeddingVector) && !embeddingVector.length)) {
                return [];
            }

            const similarResults = await faissIndexManager.searchSimilar(embeddingVector, topK);
            const results = [];

            for (const { chunkId, distance } of similarResults) {
                const cachedEntry = await sqliteCacheManager.retrieve(chunkId);
                if (!cachedEntry) continue;

                const { hash: freshHash, status } = computeFreshChunkHash(cachedEntry);
                if (status === 'unreadable') {
                    console.warn(`[RAG] Skipping chunk ${chunkId}; source file missing or unreadable (${cachedEntry.file_path}).`);
                    continue;
                }

                const hashForValidation = freshHash || cachedEntry.chunk_hash;
                const isValid = await sqliteCacheManager.validate(
                    chunkId,
                    hashForValidation,
                    cachedEntry.model_version
                );
                if (!isValid) continue;

                results.push({
                    chunkId,
                    filePath: cachedEntry.file_path,
                    summaryText: cachedEntry.summary,
                    distance
                });
            }

            return results;
        } catch (err) {
            throw err;
        }
    }

    return {
        ragSearch,
        buildContextWithBudget,
        extractAssistantText,
        estimateTokens,
        computeFreshChunkHash
    };
}

module.exports = { createRagService };
