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

module.exports = {
    getTokenizer,
    countTokens,
    countTokensPerMessage,
    countTotalTokens,
};

