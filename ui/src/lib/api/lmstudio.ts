/**
 * LM Studio API
 * LM Studio server and model management
 */

import { request } from './client';

export interface LMStudioHealth {
  ready: boolean;
  server?: { status: string };
  models_loaded?: number;
  models?: Array<{ id: string; name: string; state: string }>;
  error?: string;
}

export interface LoadPresetResponse {
  status: string;
  message: string;
  loaded: string[];
  kept: string[];
  unloaded: string[];
  failed: string[];
  needsDownload: string[];
}

/**
 * Check LM Studio health
 */
export async function checkLMStudioHealth(): Promise<LMStudioHealth> {
  return request<LMStudioHealth>('/lmstudio/health');
}

/**
 * Start LM Studio server
 */
export async function startLMStudioServer(): Promise<{ status: string }> {
  return request<{ status: string }>('/lmstudio/server/start', {
    method: 'POST',
  });
}

/**
 * Stop LM Studio server
 */
export async function stopLMStudioServer(): Promise<{ status: string }> {
  return request<{ status: string }>('/lmstudio/server/stop', {
    method: 'POST',
  });
}

/**
 * Load required models
 */
export async function loadRequiredModels(): Promise<{ status: string }> {
  return request<{ status: string }>('/lmstudio/models/load-required', {
    method: 'POST',
  });
}

/**
 * Load preset models
 */
export async function loadPresetModels(preset: string): Promise<LoadPresetResponse> {
  return request<LoadPresetResponse>(`/lmstudio/models/load-preset/${preset}`, {
    method: 'POST',
  });
}

/**
 * Unload a model
 */
export async function unloadModel(modelId: string): Promise<{ status: string }> {
  return request<{ status: string }>('/lmstudio/models/unload', {
    method: 'POST',
    body: JSON.stringify({ modelId }),
  });
}

/**
 * Unload all models
 */
export async function unloadAllModels(): Promise<{ status: string }> {
  return request<{ status: string }>('/lmstudio/models/unload-all', {
    method: 'POST',
  });
}

/**
 * Refresh model context
 */
export async function refreshModelContext(): Promise<{ status: string }> {
  return request<{ status: string }>('/lmstudio/context/refresh', {
    method: 'POST',
  });
}
