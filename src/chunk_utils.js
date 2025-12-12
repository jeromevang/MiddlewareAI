#!/usr/bin/env node

/**
 * Chunk helpers shared by the middleware and server layers.
 *
 * Responsibilities:
 * - Normalize file content per language before chunking.
 * - Reconstruct a stored chunk from the original source file.
 * - Generate deterministic hashes for chunk contents.
 */

const fs = require('fs');
const crypto = require('crypto');
const { CodeChunkGenerator } = require('./utils.js');

function normalizeContentByLanguage(language, rawContent) {
    if (!rawContent) return '';
    if (language === 'javascript' || language === 'typescript') {
        return CodeChunkGenerator.preProcess(rawContent);
    }
    return rawContent;
}

function extractChunkFromFile({ filePath, language, startLine, length }) {
    if (!filePath || typeof startLine !== 'number' || typeof length !== 'number') {
        return null;
    }

    try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const normalized = normalizeContentByLanguage(language, raw);
        const lines = normalized.split('\n');
        if (!lines.length) {
            return '';
        }
        const safeStart = Math.max(0, Math.min(startLine, lines.length));
        const safeEnd = Math.max(safeStart, Math.min(safeStart + length, lines.length));
        if (safeStart >= safeEnd) {
            return '';
        }
        return lines.slice(safeStart, safeEnd).join('\n');
    } catch (err) {
        return null;
    }
}

function generateChunkHash(content) {
    return crypto.createHash('sha256').update(content || '').digest('hex');
}

module.exports = {
    extractChunkFromFile,
    generateChunkHash,
    normalizeContentByLanguage,
};
