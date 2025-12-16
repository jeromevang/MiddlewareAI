#!/usr/bin/env node

const axios = require('axios');
const { getModelConfig } = require('../config.js');
const { isCloudMode, getCloudMainConfig } = require('../runtime.js');
const { ensureModelLoaded } = require('./model_manager.js');
const { LM_STUDIO_URL, LM_STUDIO_TIMEOUT_MS, MAX_RETRIES, CLOUD_REQUEST_TIMEOUT_MS, withLMStudioLock, generateRequestId } = require('./state.js');
const { truncateToTokenLimit, estimateTokens } = require('../tokenizer.js');

// Reserve tokens for system prompt and model output
const SYSTEM_PROMPT_RESERVE = 200;
const OUTPUT_RESERVE = 500;

function getCloudChatEndpoint() {
    const cfg = getCloudMainConfig();
    const base = (cfg.base_url || '').trim().replace(/\/$/, '');
    if (!base) {
        throw new Error('Cloud main base_url is not configured');
    }
    return `${base}/chat/completions`;
}

function getCloudHeaders() {
    const cfg = getCloudMainConfig();
    if (!cfg.api_key) {
        throw new Error('Cloud main api_key is not configured');
    }
    return {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cfg.api_key}`
    };
}

/**
 * Summarize a code chunk for RAG indexing.
 * Uses a model optimized for code understanding.
 */
async function summarizeChunk(text) {
    const requestId = generateRequestId();
    let retries = MAX_RETRIES;
    const ragModel = getModelConfig('ragSummarization');
    
    // Use model's configured context length, default to 4096
    const modelContext = ragModel.context_length || 4096;
    const maxInputTokens = modelContext - SYSTEM_PROMPT_RESERVE - OUTPUT_RESERVE;
    
    // Token-based truncation (not character-based!)
    const truncated = await truncateToTokenLimit(text, maxInputTokens);
    
    if (estimateTokens(text) > maxInputTokens) {
        console.log(`[RAG Summary] ${requestId} - Truncated input from ~${estimateTokens(text)} to ${maxInputTokens} tokens`);
    }

    while (retries > 0) {
        try {
            await ensureModelLoaded(ragModel.identifier);
            console.log(`[LM Studio Request] ${requestId} - Generating RAG chunk summary...`);
            const response = await withLMStudioLock(() =>
                axios.post(
                    `${LM_STUDIO_URL}/v1/chat/completions`,
                    {
                        model: ragModel.identifier,
                        messages: [
                            { role: 'system', content: 'You are a code documentation expert. Summarize this code chunk concisely, focusing on its purpose, key functions, and important implementation details. Be technical and precise.' },
                            { role: 'user', content: truncated }
                        ],
                        temperature: 0.1,
                        stream: false
                    },
                    {
                        timeout: LM_STUDIO_TIMEOUT_MS,
                        headers: { 'Content-Type': 'application/json' },
                    }
                )
            );

            const summary =
                response.data?.choices?.[0]?.message?.content ||
                response.data?.summary;

            if (summary) {
                console.log(`[LM Studio Success] ${requestId} - RAG chunk summary generated.`);
                return summary;
            }

            throw new Error('Invalid summary response format.');
        } catch (error) {
            retries--;
            if (retries === 0) {
                console.error(`[LM Studio Request Failed] ${requestId} - Max retries reached. Error:`, error.message);
                throw error;
            }

            const delay = Math.pow(2, MAX_RETRIES - retries) * 1000;
            console.log(`[LM Studio Retry] ${requestId} - Retrying in ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

// Blacklisted models that should never be used for summarization
const SUMMARIZER_BLACKLIST = ['tinyllama', 'phi-1', 'orca-mini'];
const SAFE_FALLBACK_SUMMARIZER = 'qwen2.5-coder-0.5b-instruct';

/**
 * Check if a model is blacklisted for summarization
 */
function isSummarizerBlacklisted(modelId) {
    if (!modelId) return true;
    const lower = modelId.toLowerCase();
    return SUMMARIZER_BLACKLIST.some(pattern => lower.includes(pattern));
}

/**
 * Get the rolling summarizer model based on active preset
 * Priority: perQualityRollingSummarizers[activePreset] > customPreset > safe fallback
 * NEVER falls back to blacklisted models like TinyLlama
 */
function getRollingSummarizerForPreset() {
    const { getConfig } = require('../config.js');
    const config = getConfig();
    const activePreset = config.models?.activePreset;
    
    // Try to get preset-specific rolling summarizer
    if (activePreset && activePreset !== 'custom') {
        const presetSummarizer = config.models?.perQualityRollingSummarizers?.[activePreset];
        if (presetSummarizer && !isSummarizerBlacklisted(presetSummarizer)) {
            console.log(`[Rolling Summary] Using preset '${activePreset}' summarizer: ${presetSummarizer}`);
            const baseConfig = getModelConfig('rollingSummarization');
            return { ...baseConfig, identifier: presetSummarizer, model_name: presetSummarizer };
        } else if (presetSummarizer && isSummarizerBlacklisted(presetSummarizer)) {
            console.warn(`[Rolling Summary] Preset '${activePreset}' summarizer '${presetSummarizer}' is blacklisted, using safe fallback`);
        }
    } else if (activePreset === 'custom') {
        const customSummarizer = config.customPreset?.rollingSummarizer;
        if (customSummarizer && !isSummarizerBlacklisted(customSummarizer)) {
            console.log(`[Rolling Summary] Using custom preset summarizer: ${customSummarizer}`);
            const baseConfig = getModelConfig('rollingSummarization');
            return { ...baseConfig, identifier: customSummarizer, model_name: customSummarizer };
        } else if (customSummarizer && isSummarizerBlacklisted(customSummarizer)) {
            console.warn(`[Rolling Summary] Custom summarizer '${customSummarizer}' is blacklisted, using safe fallback`);
        }
    }
    
    // Check if base config has a blacklisted model
    const baseConfig = getModelConfig('rollingSummarization');
    if (baseConfig?.identifier && !isSummarizerBlacklisted(baseConfig.identifier)) {
        console.log(`[Rolling Summary] Using base config summarizer: ${baseConfig.identifier}`);
        return baseConfig;
    }
    
    // Use safe fallback - never use blacklisted models
    console.warn(`[Rolling Summary] Base config uses blacklisted model, falling back to: ${SAFE_FALLBACK_SUMMARIZER}`);
    return {
        ...baseConfig,
        identifier: SAFE_FALLBACK_SUMMARIZER,
        model_name: SAFE_FALLBACK_SUMMARIZER,
        context_length: 4096
    };
}

/**
 * Summarize conversation history for rolling memory.
 * Uses a model optimized for context retention and dialogue understanding.
 */
async function summarizeConversation(text) {
    const requestId = generateRequestId();
    let retries = MAX_RETRIES;
    const rollingModel = getRollingSummarizerForPreset();
    
    // Use model's configured context length, default to 4096
    const modelContext = rollingModel.context_length || 4096;
    const maxInputTokens = modelContext - SYSTEM_PROMPT_RESERVE - OUTPUT_RESERVE;
    
    // Token-based truncation (not character-based!)
    const truncated = await truncateToTokenLimit(text, maxInputTokens);
    
    if (estimateTokens(text) > maxInputTokens) {
        console.log(`[Rolling Summary] ${requestId} - Truncated input from ~${estimateTokens(text)} to ${maxInputTokens} tokens`);
    }

    while (retries > 0) {
        try {
            await ensureModelLoaded(rollingModel.identifier);
            console.log(`[LM Studio Request] ${requestId} - Generating rolling conversation summary...`);
            const response = await withLMStudioLock(() =>
                axios.post(
                    `${LM_STUDIO_URL}/v1/chat/completions`,
                    {
                        model: rollingModel.identifier,
                        messages: [
                            { role: 'system', content: 'You are a conversation memory assistant. Summarize this conversation history, preserving key decisions, code changes discussed, user preferences, and important context. Focus on information that would be useful for continuing the conversation.' },
                            { role: 'user', content: truncated }
                        ],
                        temperature: 0.2,
                        stream: false
                    },
                    {
                        timeout: LM_STUDIO_TIMEOUT_MS,
                        headers: { 'Content-Type': 'application/json' },
                    }
                )
            );

            const summary =
                response.data?.choices?.[0]?.message?.content ||
                response.data?.summary;

            if (summary) {
                console.log(`[LM Studio Success] ${requestId} - Rolling summary generated.`);
                return summary;
            }

            throw new Error('Invalid summary response format.');
        } catch (error) {
            retries--;
            if (retries === 0) {
                console.error(`[LM Studio Request Failed] ${requestId} - Max retries reached. Error:`, error.message);
                throw error;
            }

            const delay = Math.pow(2, MAX_RETRIES - retries) * 1000;
            console.log(`[LM Studio Retry] ${requestId} - Retrying in ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

// Legacy alias for backwards compatibility
const summarize = summarizeConversation;

async function cloudCompletion({ prompt, systemPrompt = null, temperature = 0.2 }) {
    const cfg = getCloudMainConfig();
    const requestId = generateRequestId();
    const messages = [];
    if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    const body = {
        model: cfg.model,
        messages,
        temperature,
        stream: false,
    };

    const response = await axios.post(
        getCloudChatEndpoint(),
        body,
        {
            timeout: CLOUD_REQUEST_TIMEOUT_MS,
            headers: getCloudHeaders(),
        }
    );
    console.log(`[Cloud Chat] ${requestId} - Completion generated.`);
    return response.data;
}

/**
 * Get the main model based on active preset
 * Priority: perQualityMainModels[activePreset] > config.main
 */
function getMainModelForPreset() {
    const { getConfig } = require('../config.js');
    const config = getConfig();
    const activePreset = config.models?.activePreset;
    
    // Try to get preset-specific main model
    if (activePreset && activePreset !== 'custom') {
        const presetMain = config.models?.perQualityMainModels?.[activePreset];
        if (presetMain) {
            console.log(`[Main Model] Using preset '${activePreset}' model: ${presetMain}`);
            const baseConfig = getModelConfig('main');
            return { ...baseConfig, identifier: presetMain, model_name: presetMain };
        }
    } else if (activePreset === 'custom') {
        const customMain = config.customPreset?.main;
        if (customMain) {
            console.log(`[Main Model] Using custom preset model: ${customMain}`);
            const baseConfig = getModelConfig('main');
            return { ...baseConfig, identifier: customMain, model_name: customMain };
        }
    }
    
    // Fall back to default config
    return getModelConfig('main');
}

async function generateCompletion({ prompt, systemPrompt = null, temperature = 0.2, model = null }) {
    if (isCloudMode()) {
        return cloudCompletion({ prompt, systemPrompt, temperature });
    }

    const requestId = generateRequestId();
    // Use provided model or get from preset
    const mainModel = model ? { identifier: model } : getMainModelForPreset();
    let retries = MAX_RETRIES;

    while (retries > 0) {
        try {
            await ensureModelLoaded(mainModel.identifier);
            console.log(`[LM Studio Request] ${requestId} - Generating completion with ${mainModel.identifier}...`);

            const messages = [];
            if (systemPrompt) {
                messages.push({ role: 'system', content: systemPrompt });
            }
            messages.push({ role: 'user', content: prompt });

            const response = await withLMStudioLock(() =>
                axios.post(
                    `${LM_STUDIO_URL}/v1/chat/completions`,
                    {
                        model: mainModel.identifier,
                        messages,
                        temperature,
                        stream: false,
                    },
                    {
                        timeout: LM_STUDIO_TIMEOUT_MS,
                        headers: { 'Content-Type': 'application/json' },
                    }
                )
            );

            console.log(`[LM Studio Success] ${requestId} - Completion generated.`);
            return response.data;
        } catch (error) {
            if (error.response) {
                console.error(`[LM Studio Error] ${requestId} - status ${error.response.status}:`, error.response.data);
            } else {
                console.error(`[LM Studio Error] ${requestId}:`, error.message);
            }
            retries--;
            if (retries === 0) {
                console.error(`[LM Studio Request Failed] ${requestId} - Max retries reached. Error:`, error.message);
                throw error;
            }

            const delay = Math.pow(2, MAX_RETRIES - retries) * 1000;
            console.log(`[LM Studio Retry] ${requestId} - Retrying in ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

function normalizeStreamingResponse(data, model) {
    if (data && typeof data === 'object' && Array.isArray(data.choices)) {
        return data;
    }
    if (typeof data === 'string' && data.includes('data:')) {
        const lines = data.split('\n').map(l => l.trim()).filter(Boolean);
        let content = '';
        for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            const chunkRaw = line.slice('data:'.length).trim();
            if (chunkRaw === '[DONE]') break;
            try {
                const chunk = JSON.parse(chunkRaw);
                const delta = chunk?.choices?.[0]?.delta;
                if (delta?.content) content += delta.content;
            } catch (_err) {
                // ignore parse errors on individual chunks
            }
        }
        return {
            id: `chatcmpl-${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [
                {
                    index: 0,
                    message: { role: 'assistant', content },
                    finish_reason: 'stop'
                }
            ],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
        };
    }
    return {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
            {
                index: 0,
                message: { role: 'assistant', content: typeof data === 'string' ? data : JSON.stringify(data) },
                finish_reason: 'stop'
            }
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    };
}

async function cloudProxyCompletion(payload, resStream = null) {
    const requestId = generateRequestId();
    const cfg = getCloudMainConfig();
    const body = {
        model: payload.model || cfg.model,
        messages: payload.messages || [],
        temperature: payload.temperature ?? 0.2,
        stream: payload.stream ?? false,
        ...payload,
    };

    const axiosOptions = {
        timeout: CLOUD_REQUEST_TIMEOUT_MS,
        headers: getCloudHeaders(),
    };
    if (body.stream && resStream) {
        axiosOptions.responseType = 'stream';
    }

    const response = await axios.post(getCloudChatEndpoint(), body, axiosOptions);

    if (body.stream && resStream) {
        const stream = response.data;
        let collectedContent = '';
        let sawDone = false;

        await new Promise((resolve, reject) => {
            stream.on('data', (chunk) => {
                const text = chunk.toString();
                if (!resStream.writableEnded) {
                    resStream.write(text);
                }
                const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
                for (const line of lines) {
                    if (!line.startsWith('data:')) continue;
                    const raw = line.slice('data:'.length).trim();
                    if (raw === '[DONE]') {
                        sawDone = true;
                        continue;
                    }
                    try {
                        const chunkObj = JSON.parse(raw);
                        const delta = chunkObj?.choices?.[0]?.delta;
                        if (delta?.content) {
                            collectedContent += delta.content;
                        }
                    } catch (_) {
                        // ignore
                    }
                }
            });
            stream.on('end', () => {
                if (!sawDone && !resStream.writableEnded) {
                    resStream.write('data: [DONE]\n\n');
                }
                if (!resStream.writableEnded) resStream.end();
                resolve();
            });
            stream.on('error', (err) => {
                if (!resStream.writableEnded) resStream.end();
                reject(err);
            });
        });

        console.log(`[Cloud Chat] ${requestId} - Streaming completion forwarded.`);
        return collectedContent;
    }

    console.log(`[Cloud Chat] ${requestId} - Completion generated.`);
    return response.data;
}

async function proxyChatCompletion(payload, resStream = null) {
    if (isCloudMode()) {
        return cloudProxyCompletion(payload, resStream);
    }

    const requestId = generateRequestId();
    // Use preset-aware model resolution as fallback
    const mainModel = getMainModelForPreset();
    const body = {
        model: payload.model || mainModel.identifier,
        messages: payload.messages || [],
        temperature: payload.temperature ?? 0.2,
        stream: payload.stream ?? false,
        ...payload
    };

    let retries = MAX_RETRIES;
    while (retries > 0) {
        try {
            await ensureModelLoaded(body.model);
            console.log(`[LM Studio Request] ${requestId} - Proxy chat completion...`);
            const response = await withLMStudioLock(() => {
                const axiosOptions = {
                    timeout: LM_STUDIO_TIMEOUT_MS,
                    headers: { 'Content-Type': 'application/json' },
                };
                if (body.stream && resStream) {
                    axiosOptions.responseType = 'stream';
                }
                return axios.post(
                    `${LM_STUDIO_URL}/v1/chat/completions`,
                    body,
                    axiosOptions
                );
            });

            if (body.stream && resStream) {
                const stream = response.data;
                let collectedContent = '';
                let sawDone = false;

                await new Promise((resolve, reject) => {
                    stream.on('data', (chunk) => {
                        const text = chunk.toString();
                        if (!resStream.writableEnded) {
                            resStream.write(text);
                        }
                        const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
                        for (const line of lines) {
                            if (!line.startsWith('data:')) continue;
                            const raw = line.slice('data:'.length).trim();
                            if (raw === '[DONE]') {
                                sawDone = true;
                                continue;
                            }
                            try {
                                const chunkObj = JSON.parse(raw);
                                const delta = chunkObj?.choices?.[0]?.delta;
                                if (delta?.content) {
                                    collectedContent += delta.content;
                                }
                            } catch (_) {
                                // Ignore malformed chunk parsing
                            }
                        }
                    });
                    stream.on('end', () => {
                        if (!sawDone && !resStream.writableEnded) {
                            resStream.write('data: [DONE]\n\n');
                        }
                        if (!resStream.writableEnded) resStream.end();
                        resolve();
                    });
                    stream.on('error', (err) => {
                        if (!resStream.writableEnded) resStream.end();
                        reject(err);
                    });
                });

                console.log(`[LM Studio Success] ${requestId} - Proxy streaming completion forwarded.`);
                return collectedContent;
            }

            console.log(`[LM Studio Success] ${requestId} - Proxy completion generated.`);
            return normalizeStreamingResponse(response.data, body.model);
        } catch (error) {
            if (error.response) {
                console.error(`[LM Studio Error] ${requestId} - status ${error.response.status}:`, error.response.data);
            } else {
                console.error(`[LM Studio Error] ${requestId}:`, error.message);
            }
            retries--;
            if (retries === 0) {
                console.error(`[LM Studio Request Failed] ${requestId} - Max retries reached. Error:`, error.message);
                throw error;
            }
            const delay = Math.pow(2, MAX_RETRIES - retries) * 1000;
            console.log(`[LM Studio Retry] ${requestId} - Retrying in ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

module.exports = {
    summarize,
    summarizeChunk,
    summarizeConversation,
    generateCompletion,
    proxyChatCompletion,
    cloudCompletion,
    cloudProxyCompletion,
};

