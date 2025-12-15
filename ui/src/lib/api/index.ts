/**
 * API Module Index
 * Re-exports all API functionality
 */

// Client
export { request } from './client';
export type { RequestOptions } from './client';

// Models API
export {
  getPresets,
  getModelStatus,
  setActiveModel,
  downloadModel,
  triggerBootstrap,
  getBootstrapStatus,
} from './models';
export type {
  PresetsResponse,
  ModelStatusResponse,
  ActiveModelResponse,
  DownloadResponse,
} from './models';

// LM Studio API
export {
  checkLMStudioHealth,
  startLMStudioServer,
  stopLMStudioServer,
  loadRequiredModels,
  loadPresetModels,
  unloadModel,
  unloadAllModels,
  refreshModelContext,
} from './lmstudio';
export type { LMStudioHealth, LoadPresetResponse } from './lmstudio';
