#!/usr/bin/env node

/**
 * Utility Functions for Rolling Summaries + Mini-RAG Middleware
 *
 * Includes:
 * - Chunking logic.
 * - Parallel processing helpers.
 * - Logging utilities.
 */

const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);
const mkdir = promisify(fs.mkdir);
const readdir = promisify(fs.readdir);

// Logging utilities
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

// Chunking logic
class CodeChunkGenerator {
    /**
     * Split file content into chunks of 100-300 lines.
     */
    static async generateChunks(filePath) {
        const content = await readFile(filePath, 'utf8');
        return this._splitContentIntoChunks(content);
    }

    /**
     * Split raw text content into chunks of 100-300 lines.
     */
    static _splitContentIntoChunks(content) {
        const lines = content.split('\n');
        let chunks = [];
        let currentChunk = [];

        for (const line of lines) {
            if (!line.trim()) continue; // Skip empty lines

            currentChunk.push(line);

            // Check chunk size constraints
            if ((currentChunk.length >= 100 && currentChunk.length < 300) ||
                (currentChunk.length === lines.length)) { // Last line of file
                chunks.push(currentChunk.join('\n'));
                currentChunk = [];
            }
        }

        return chunks;
    }

    /**
     * Pre-process chunk content by removing comments and normalizing whitespace.
     */
    static preProcess(chunkContent) {
        const normalized = chunkContent.replace(/(\/\/.*|\/\*[\s\S]*?\*\/)/g, '');
        return normalized.trim();
    }
}

// Parallel processing utilities
class ParallelProcessor {
    /**
     * Process chunks in parallel with controlled concurrency.
     */
    static async processWithConcurrency(chunks, processorFn, concurrency = 8) {
        const queue = [];
        let activeWorkers = 0;

        // Create a worker for each chunk (up to concurrency limit)
        for (const i in chunks) {
            if (activeWorkers >= concurrency) {
                await Promise.all(queue);
                queue.length = 0;
                activeWorkers = 0;
            }

            const chunkIndex = parseInt(i, 10);
            queue.push(processorFn(chunkIndex));
            activeWorkers++;
        }

        // Wait for remaining workers to finish
        if (queue.length > 0) {
            await Promise.all(queue);
        }
    }
}

// File system utilities
class FSUtils {
    /**
     * Ensure directory exists, create if not.
     */
    static async ensureDirectory(dirPath) {
        try {
            await mkdir(dirPath, { recursive: true });
            logInfo(`Directory created or confirmed: ${dirPath}`);
        } catch (error) {
            logError(`Failed to create directory: ${dirPath}`, error);
            throw error;
        }
    }

    /**
     * Read all files recursively from a directory.
     */
    static async readFilesRecursively(dirPath, fileExtensions = ['js', 'ts', 'py']) {
        try {
            const files = await readdir(dirPath, { recursive: true });
            return files.filter(file => {
                const ext = path.extname(file).slice(1);
                return fileExtensions.includes(ext.toLowerCase());
            });
        } catch (error) {
            logError(`Failed to read files from directory: ${dirPath}`, error);
            throw error;
        }
    }

    /**
     * Write embeddings and summaries to disk.
     */
    static async writeEmbeddingAndSummary(filePath, chunkId, embeddingVector, summaryText) {
        const dir = path.dirname(filePath);
        await this.ensureDirectory(dir);

        try {
            // Store embeddings in FAISS format
            await writeFile(
                `${dir}/embeddings/${chunkId}.json`,
                JSON.stringify({ vector: embeddingVector })
            );

            // Store summaries in text format
            await writeFile(
                `${dir}/summaries/${chunkId}.txt`,
                summaryText
            );
        } catch (error) {
            logError(`Failed to store embeddings/summaries for chunk ${chunkId}`, error);
            throw error;
        }
    }
}

module.exports = { CodeChunkGenerator, ParallelProcessor, FSUtils };