#!/usr/bin/env node

/**
 * Tokenizer utility for accurate token counting.
 * Uses @xenova/transformers AutoTokenizer for LLM-accurate token estimation.
 */

const { AutoTokenizer } = require('@xenova/transformers');

let tokenizerPromise = null;

/**
 * Get or initialize the tokenizer (cached after first load).
 * Uses Xenova/llama-tokenizer which works well for most LM Studio models.
 */
async function getTokenizer() {
    if (!tokenizerPromise) {
        console.log('[Tokenizer] Initializing llama tokenizer...');
        tokenizerPromise = AutoTokenizer.from_pretrained('Xenova/llama-tokenizer')
            .then(tokenizer => {
                console.log('[Tokenizer] Tokenizer ready');
                return tokenizer;
            })
            .catch(err => {
                console.error('[Tokenizer] Failed to load tokenizer:', err.message);
                tokenizerPromise = null;
                throw err;
            });
    }
    return tokenizerPromise;
}

/**
 * Count tokens in a text string.
 * @param {string} text - Text to tokenize
 * @returns {Promise<number>} - Token count
 */
async function countTokens(text) {
    if (!text) return 0;
    try {
        const tokenizer = await getTokenizer();
        const encoded = tokenizer.encode(text);
        return encoded.length;
    } catch (err) {
        // Fallback to char-based estimation if tokenizer fails
        console.warn('[Tokenizer] Falling back to char estimation:', err.message);
        return Math.ceil(text.length / 4);
    }
}

/**
 * Count tokens for an array of chat messages.
 * Returns an array of token counts, one per message.
 * @param {Array<{role: string, content: string}>} messages - Chat messages
 * @returns {Promise<number[]>} - Array of token counts per message
 */
async function countTokensPerMessage(messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
        return [];
    }
    
    const counts = [];
    for (const msg of messages) {
        const roleTokens = await countTokens(msg.role || '');
        const contentTokens = await countTokens(msg.content || '');
        // Add overhead for message structure (role tokens, separators, etc.)
        counts.push(roleTokens + contentTokens + 4);
    }
    return counts;
}

/**
 * Count total tokens for all messages combined.
 * @param {Array<{role: string, content: string}>} messages - Chat messages
 * @returns {Promise<number>} - Total token count
 */
async function countTotalTokens(messages) {
    const perMessage = await countTokensPerMessage(messages);
    return perMessage.reduce((sum, count) => sum + count, 0);
}

/**
 * Truncate text to fit within a maximum token limit.
 * Uses binary search for efficiency.
 * @param {string} text - Text to truncate
 * @param {number} maxTokens - Maximum number of tokens
 * @returns {Promise<string>} - Truncated text
 */
async function truncateToTokenLimit(text, maxTokens) {
    if (!text || !maxTokens || maxTokens <= 0) return text || '';
    
    const currentTokens = await countTokens(text);
    if (currentTokens <= maxTokens) {
        return text; // Already fits
    }
    
    // Binary search for the optimal cut point
    let low = 0;
    let high = text.length;
    let bestCut = 0;
    
    // Estimate initial cut point based on token ratio
    const ratio = maxTokens / currentTokens;
    let mid = Math.floor(text.length * ratio * 0.9); // Start slightly under
    
    // Refine with binary search (max 10 iterations)
    for (let i = 0; i < 10; i++) {
        mid = Math.floor((low + high) / 2);
        if (mid <= 0) break;
        
        const truncated = text.slice(0, mid);
        const tokens = await countTokens(truncated);
        
        if (tokens <= maxTokens) {
            bestCut = mid;
            low = mid + 1;
        } else {
            high = mid - 1;
        }
        
        // Early exit if we're very close
        if (Math.abs(tokens - maxTokens) <= 5) {
            if (tokens <= maxTokens) bestCut = mid;
            break;
        }
    }
    
    // Try to cut at a natural boundary (newline, period, space)
    const result = text.slice(0, bestCut);
    const lastNewline = result.lastIndexOf('\n');
    const lastPeriod = result.lastIndexOf('. ');
    const lastSpace = result.lastIndexOf(' ');
    
    const cutPoint = Math.max(lastNewline, lastPeriod, lastSpace);
    if (cutPoint > bestCut * 0.8) {
        return text.slice(0, cutPoint + 1);
    }
    
    return result;
}

/**
 * Quick token estimate without full tokenization (for pre-checks).
 * Uses ~4 chars per token heuristic.
 * @param {string} text - Text to estimate
 * @returns {number} - Estimated token count
 */
function estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
}

module.exports = {
    getTokenizer,
    countTokens,
    countTokensPerMessage,
    countTotalTokens,
    truncateToTokenLimit,
    estimateTokens,
};

