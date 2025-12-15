/**
 * Hugging Face Model Service
 * 
 * Searches Hugging Face for compatible GGUF models,
 * downloads them via LM Studio CLI, and syncs with the local database.
 */

const axios = require('axios');
const { exec } = require('child_process');
const { promisify } = require('util');
const { getLMStudioCLIPath } = require('./lmstudio_manager.js');
const { syncModels } = require('./lmstudio/model_sync.js');

const execAsync = promisify(exec);

const HF_API_URL = 'https://huggingface.co/api';

// Track active downloads
const activeDownloads = new Map();

/**
 * Search Hugging Face for GGUF models
 * @param {string} query - Search query
 * @param {Object} options - Search options
 * @returns {Promise<Array>} - Array of model results
 */
async function searchModels(query, options = {}) {
    const {
        limit = 20,
        filter = 'gguf',
        sortBy = 'downloads'
    } = options;

    try {
        console.log(`[HuggingFace] Searching for: ${query}`);
        
        // Build search URL
        const params = new URLSearchParams({
            search: query,
            filter: filter,
            sort: sortBy,
            limit: limit.toString()
        });
        
        const response = await axios.get(`${HF_API_URL}/models?${params.toString()}`, {
            timeout: 30000,
            headers: {
                'Accept': 'application/json'
            }
        });
        
        const models = response.data || [];
        
        // Filter and enrich results
        const enriched = models
            .filter(m => m.id && m.modelId)
            .map(m => ({
                id: m.id,
                modelId: m.modelId,
                author: m.author || m.id.split('/')[0],
                name: m.id.split('/')[1] || m.id,
                downloads: m.downloads || 0,
                likes: m.likes || 0,
                tags: m.tags || [],
                lastModified: m.lastModified,
                pipeline_tag: m.pipeline_tag,
                isGGUF: (m.tags || []).some(t => t.toLowerCase().includes('gguf')),
                siblings: m.siblings || [] // Files available
            }));
        
        console.log(`[HuggingFace] Found ${enriched.length} results`);
        return enriched;
        
    } catch (error) {
        console.error('[HuggingFace] Search failed:', error.message);
        throw new Error(`Search failed: ${error.message}`);
    }
}

/**
 * Get available quantizations for a model
 * @param {string} modelId - HuggingFace model ID (e.g., 'lmstudio-community/Qwen2.5-3B-Instruct-GGUF')
 * @returns {Promise<Array>} - Array of quantization files
 */
async function getModelQuantizations(modelId) {
    try {
        const response = await axios.get(`${HF_API_URL}/models/${modelId}`, {
            timeout: 15000
        });
        
        const siblings = response.data?.siblings || [];
        
        // Filter for GGUF files and extract quantization info
        const ggufFiles = siblings
            .filter(f => f.rfilename && f.rfilename.endsWith('.gguf'))
            .map(f => {
                const filename = f.rfilename;
                // Extract quantization from filename (e.g., "Q4_K_M", "Q8_0", etc.)
                const quantMatch = filename.match(/[qQ](\d+)_?([kK]_?[mMsS]?|\d+)?/);
                const quant = quantMatch ? quantMatch[0].toUpperCase() : 'UNKNOWN';
                
                return {
                    filename: f.rfilename,
                    size: f.size,
                    sizeGB: f.size ? f.size / (1024 * 1024 * 1024) : null,
                    quantization: quant,
                    lfs: f.lfs
                };
            })
            .sort((a, b) => (a.sizeGB || 0) - (b.sizeGB || 0));
        
        return ggufFiles;
        
    } catch (error) {
        console.error(`[HuggingFace] Failed to get quantizations for ${modelId}:`, error.message);
        return [];
    }
}

/**
 * Download a model from Hugging Face via LM Studio CLI
 * @param {string} hfModelId - HuggingFace model ID
 * @param {string} quantization - Optional quantization preference
 * @returns {Promise<Object>} - Download result with final modelKey
 */
async function downloadModel(hfModelId, quantization = null) {
    const downloadId = `${hfModelId}${quantization ? `@${quantization}` : ''}`;
    
    if (activeDownloads.has(downloadId)) {
        return { 
            success: false, 
            error: 'Download already in progress',
            downloadId 
        };
    }
    
    activeDownloads.set(downloadId, {
        status: 'downloading',
        startedAt: Date.now(),
        modelId: hfModelId,
        quantization
    });
    
    try {
        console.log(`[HuggingFace] Starting download: ${downloadId}`);
        
        const cliPath = getLMStudioCLIPath();
        const modelSpec = quantization ? `${hfModelId}@${quantization}` : hfModelId;
        
        // Run lms get command
        const { stdout, stderr } = await execAsync(
            `"${cliPath}" get "${modelSpec}"`,
            { timeout: 600000 } // 10 minute timeout for large models
        );
        
        console.log(`[HuggingFace] Download output: ${stdout || stderr}`);
        
        // Wait a bit for LM Studio to register the model
        await new Promise(r => setTimeout(r, 2000));
        
        // Sync models to get the actual modelKey
        const { models } = await syncModels(true);
        
        // Find the newly downloaded model
        const downloadedModel = models.find(m => {
            const key = (m.modelKey || m.id || '').toLowerCase();
            const hfId = hfModelId.toLowerCase();
            return key.includes(hfId.split('/').pop() || '') || 
                   hfId.includes(key.split('/').pop() || '');
        });
        
        const finalModelKey = downloadedModel?.modelKey || downloadedModel?.id || null;
        
        activeDownloads.delete(downloadId);
        
        return {
            success: true,
            downloadId,
            modelKey: finalModelKey,
            message: `Successfully downloaded ${hfModelId}`,
            model: downloadedModel
        };
        
    } catch (error) {
        console.error(`[HuggingFace] Download failed:`, error.message);
        activeDownloads.delete(downloadId);
        
        return {
            success: false,
            downloadId,
            error: error.message
        };
    }
}

/**
 * Search for models suitable for a specific role
 * @param {string} role - 'main', 'summarizer', or 'embedder'
 * @param {Object} options - Search options including VRAM budget
 * @returns {Promise<Array>} - Filtered and ranked results
 */
async function searchModelsForRole(role, options = {}) {
    const {
        vramBudget = 8,
        limit = 10
    } = options;
    
    // Role-specific search queries and filters
    const roleQueries = {
        main: 'instruct gguf',
        summarizer: 'small instruct gguf',
        embedder: 'embedding gguf'
    };
    
    const query = roleQueries[role] || roleQueries.main;
    const results = await searchModels(query, { limit: 30 });
    
    // Filter and rank based on role requirements
    let filtered = results;
    
    if (role === 'main') {
        // Prefer models with 'coder', 'instruct', or 'tool' in name
        filtered = results.sort((a, b) => {
            const aScore = getMainModelScore(a);
            const bScore = getMainModelScore(b);
            return bScore - aScore;
        });
    } else if (role === 'summarizer') {
        // Prefer smaller models
        filtered = results
            .filter(m => {
                // Try to estimate size from downloads/popularity as proxy
                return m.downloads > 100; // At least somewhat validated
            })
            .sort((a, b) => b.downloads - a.downloads);
    } else if (role === 'embedder') {
        // Filter for embedding models
        filtered = results
            .filter(m => m.pipeline_tag === 'feature-extraction' || 
                        m.tags?.includes('sentence-transformers') ||
                        m.name?.toLowerCase().includes('embed'))
            .sort((a, b) => b.downloads - a.downloads);
    }
    
    return filtered.slice(0, limit);
}

/**
 * Score a model for main/coding tasks
 */
function getMainModelScore(model) {
    let score = 0;
    const name = (model.name || model.id || '').toLowerCase();
    const tags = model.tags || [];
    
    // Boost for coding-related
    if (name.includes('coder') || name.includes('code')) score += 30;
    if (tags.includes('code-generation')) score += 20;
    
    // Boost for instruction-following
    if (name.includes('instruct')) score += 20;
    if (name.includes('chat')) score += 10;
    
    // Boost for tool use indicators
    if (name.includes('tool') || name.includes('agent')) score += 25;
    if (name.includes('function')) score += 15;
    
    // Boost for popularity
    score += Math.min(Math.log10(model.downloads + 1) * 5, 30);
    
    // Penalize very large models (too big for most setups)
    if (name.includes('70b') || name.includes('72b')) score -= 20;
    
    return score;
}

/**
 * Get active downloads status
 */
function getActiveDownloads() {
    const downloads = {};
    for (const [id, info] of activeDownloads.entries()) {
        downloads[id] = {
            ...info,
            elapsedMs: Date.now() - info.startedAt
        };
    }
    return downloads;
}

/**
 * Check if a HuggingFace model is already downloaded in LM Studio
 */
async function isModelDownloaded(hfModelId) {
    const { models } = await syncModels();
    
    const hfIdLower = hfModelId.toLowerCase();
    const hfName = hfIdLower.split('/').pop() || '';
    
    return models.some(m => {
        const key = (m.modelKey || m.id || '').toLowerCase();
        return key.includes(hfName) || hfName.includes(key.split('/').pop() || '');
    });
}

module.exports = {
    searchModels,
    getModelQuantizations,
    downloadModel,
    searchModelsForRole,
    getActiveDownloads,
    isModelDownloaded
};

