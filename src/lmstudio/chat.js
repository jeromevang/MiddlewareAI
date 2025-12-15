#!/usr/bin/env node

const axios = require('axios');
const { getModelConfig } = require('../config.js');
const { isCloudMode, getCloudMainConfig } = require('../runtime.js');
const { ensureModelLoaded } = require('./model_manager.js');
const { LM_STUDIO_URL, LM_STUDIO_TIMEOUT_MS, MAX_RETRIES, CLOUD_REQUEST_TIMEOUT_MS, withLMStudioLock, generateRequestId } = require('./state.js');

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
    const truncated = text && text.length > 4000 ? text.slice(0, 4000) : text;

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

/**
 * Summarize conversation history for rolling memory.
 * Uses a model optimized for context retention and dialogue understanding.
 */
async function summarizeConversation(text) {
    const requestId = generateRequestId();
    let retries = MAX_RETRIES;
    const rollingModel = getModelConfig('rollingSummarization');
    const truncated = text && text.length > 6000 ? text.slice(0, 6000) : text;

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

async function generateCompletion({ prompt, systemPrompt = null, temperature = 0.2 }) {
    if (isCloudMode()) {
        return cloudCompletion({ prompt, systemPrompt, temperature });
    }

    const requestId = generateRequestId();
    const mainModel = getModelConfig('main');
    let retries = MAX_RETRIES;

    while (retries > 0) {
        try {
            await ensureModelLoaded(mainModel.identifier);
            console.log(`[LM Studio Request] ${requestId} - Generating completion...`);

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
    const mainModel = getModelConfig('main');
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
