/**
 * Model ID Matcher
 * Handles matching preset model IDs to actual LM Studio model IDs
 */

const { getDownloadedModels } = require('./downloader.js');

/**
 * Normalize a model ID for matching
 * Converts "lmstudio-community/Qwen2.5-3B-Instruct-GGUF" -> "qwen2.5-3b-instruct"
 * @param {string} id - Model ID
 * @returns {string} Normalized ID
 */
function normalizeModelIdForMatching(id) {
    if (!id) return '';
    let s = String(id).trim().toLowerCase();
    // Remove path prefixes (lmstudio-community/, etc.) but keep the last segment
    const parts = s.split('/');
    s = parts[parts.length - 1];
    // Also check if it's a full GGUF path like "Mungert/model/file.gguf"
    if (s.endsWith('.gguf')) {
        s = s.replace(/\.gguf$/i, '');
    }
    // Remove common suffixes
    s = s.replace(/-gguf$/i, '');
    s = s.replace(/-q\d.*$/i, '');
    s = s.replace(/@.*$/i, '');
    // Remove quantization markers
    s = s.replace(/_q\d+_\w+$/i, '');
    return s;
}

/**
 * Extract key tokens from a model name for fuzzy matching
 * @param {string} name - Model name
 * @returns {Array<string>} Tokens
 */
function extractModelTokens(name) {
    if (!name) return [];
    const normalized = normalizeModelIdForMatching(name);
    // Split on common separators and filter out common suffixes
    return normalized.split(/[-_.]/)
        .filter(t => t.length > 1)
        .filter(t => !['instruct', 'chat', 'base', 'v1', 'v2', 'v3', 'hf', 'gguf'].includes(t));
}

/**
 * Calculate token overlap score between two model names
 * @param {string} name1 - First model name
 * @param {string} name2 - Second model name
 * @returns {number} Overlap score (0-1)
 */
function tokenOverlapScore(name1, name2) {
    const tokens1 = new Set(extractModelTokens(name1));
    const tokens2 = new Set(extractModelTokens(name2));
    if (tokens1.size === 0 || tokens2.size === 0) return 0;
    
    let overlap = 0;
    for (const t of tokens1) {
        if (tokens2.has(t)) overlap++;
    }
    // Return Jaccard-like similarity
    return overlap / Math.max(tokens1.size, tokens2.size);
}

/**
 * Find the actual LM Studio model ID that best matches a preset model ID
 * @param {string} presetModelId - The preset model ID (e.g., "lmstudio-community/Qwen2.5-3B-Instruct-GGUF")
 * @returns {Promise<string|null>} - The actual LM Studio model ID or null if not found
 */
async function findLMStudioModelId(presetModelId) {
    if (!presetModelId) return null;
    
    try {
        // Get the list of downloaded models from LM Studio
        const downloadedModels = await getDownloadedModels();
        
        if (!downloadedModels || downloadedModels.length === 0) {
            console.warn('[ModelDB] No downloaded models found');
            return null;
        }
        
        // Normalize the preset ID for matching
        const normalizedPreset = normalizeModelIdForMatching(presetModelId);
        console.log(`[ModelDB] Looking for match: "${presetModelId}" -> normalized: "${normalizedPreset}"`);
        
        // Try exact match first (for when user selects from UI with actual ID)
        for (const model of downloadedModels) {
            const modelId = model.id || model.path || model.name;
            if (modelId === presetModelId) {
                console.log(`[ModelDB] Exact match found: ${modelId}`);
                return modelId;
            }
        }
        
        // Try normalized exact matching
        for (const model of downloadedModels) {
            const modelId = model.id || model.path || model.name;
            const normalizedModel = normalizeModelIdForMatching(modelId);
            
            if (normalizedModel === normalizedPreset) {
                console.log(`[ModelDB] Normalized exact match: ${modelId}`);
                return modelId;
            }
        }
        
        // Try substring matching with scoring
        let bestMatch = null;
        let bestScore = 0;
        
        for (const model of downloadedModels) {
            const modelId = model.id || model.path || model.name;
            const normalizedModel = normalizeModelIdForMatching(modelId);
            
            // Check if one contains the other (partial match)
            if (normalizedModel.includes(normalizedPreset) || normalizedPreset.includes(normalizedModel)) {
                const score = Math.min(normalizedModel.length, normalizedPreset.length) /
                             Math.max(normalizedModel.length, normalizedPreset.length);
                if (score > bestScore) {
                    bestScore = score;
                    bestMatch = modelId;
                }
            }
        }
        
        if (bestMatch && bestScore > 0.5) {
            console.log(`[ModelDB] Best partial match: ${bestMatch} (score: ${bestScore.toFixed(2)})`);
            return bestMatch;
        }
        
        // Fallback: Try token-based fuzzy matching
        for (const model of downloadedModels) {
            const modelId = model.id || model.path || model.name;
            const score = tokenOverlapScore(presetModelId, modelId);
            if (score > bestScore && score > 0.6) {
                bestScore = score;
                bestMatch = modelId;
            }
        }
        
        if (bestMatch) {
            console.log(`[ModelDB] Best token match: ${bestMatch} (score: ${bestScore.toFixed(2)})`);
            return bestMatch;
        }
        
        console.warn(`[ModelDB] No match found for: ${presetModelId}`);
        return null;
    } catch (error) {
        console.error(`[ModelDB] Error finding LM Studio model ID:`, error.message);
        return null;
    }
}

module.exports = {
    normalizeModelIdForMatching,
    extractModelTokens,
    tokenOverlapScore,
    findLMStudioModelId
};
