/**
 * Models API
 * Model-related API calls
 */

import { request } from './client';
import type { QualityPreset, ModelAvailability } from '../api';

export interface PresetsResponse {
  presets: Record<string, QualityPreset>;
  lastActiveModel: string;
}

export interface ModelStatusResponse {
  status: string;
  availability: Record<string, ModelAvailability>;
  activeDownloads: Record<string, { status: string; startedAt: number }>;
  loadedModels: string[];
}

export interface ActiveModelResponse {
  status: string;
  lastActiveModel: string;
}

export interface DownloadResponse {
  status: string;
  message: string;
  downloadStatus?: string;
  modelId?: string;
}

/**
 * Get all presets and last active model
 */
export async function getPresets(): Promise<PresetsResponse> {
  return request<PresetsResponse>('/models/presets');
}

/**
 * Get model status (availability, downloads, loaded)
 */
export async function getModelStatus(): Promise<ModelStatusResponse> {
  return request<ModelStatusResponse>('/models/status');
}

/**
 * Set the active model
 */
export async function setActiveModel(modelId: string): Promise<ActiveModelResponse> {
  return request<ActiveModelResponse>('/models/active', {
    method: 'POST',
    body: JSON.stringify({ modelId }),
  });
}

/**
 * Download a model
 */
export async function downloadModel(modelId: string): Promise<DownloadResponse> {
  return request<DownloadResponse>(`/models/download/${encodeURIComponent(modelId)}`, {
    method: 'POST',
  });
}

/**
 * Trigger model bootstrap
 */
export async function triggerBootstrap(): Promise<{ status: string }> {
  return request<{ status: string }>('/models/bootstrap', {
    method: 'POST',
  });
}

/**
 * Get bootstrap status
 */
export async function getBootstrapStatus(): Promise<{
  running: boolean;
  progress: number;
  message: string;
}> {
  return request<{
    running: boolean;
    progress: number;
    message: string;
  }>('/models/bootstrap-status');
}
