/**
 * Model Database Client
 * 
 * Fetches model presets and specs from the backend API.
 * The model database is stored in data/models.json on the server.
 */

import { getPresets, getModelSpec as fetchModelSpec, getSuggestedModels } from './api';
import type { ModelSpec, QualityPreset, PresetsResponse } from './api';

// Re-export types from api.ts
export type { ModelSpec, QualityPreset, PresetsResponse };

// Cache for presets
let presetsCache: PresetsResponse | null = null;
let presetsCacheTime: number = 0;
const CACHE_TTL_MS = 30000; // 30 seconds

/**
 * Fetch all quality presets from the API
 */
export async function fetchPresets(forceRefresh = false): Promise<PresetsResponse> {
  const now = Date.now();
  
  // Return cached if still valid
  if (!forceRefresh && presetsCache && (now - presetsCacheTime) < CACHE_TTL_MS) {
    return presetsCache;
  }
  
  try {
    presetsCache = await getPresets();
    presetsCacheTime = now;
    return presetsCache;
  } catch (error) {
    console.error('[Models] Failed to fetch presets:', error);
    // Return cached data if available, even if stale
    if (presetsCache) {
      return presetsCache;
    }
    throw error;
  }
}

/**
 * Get a specific preset by quality tier
 */
export async function getPreset(quality: 'high' | 'medium' | 'low'): Promise<QualityPreset | null> {
  const data = await fetchPresets();
  return data.presets[quality] || null;
}

/**
 * Get main model options for a quality tier
 */
export async function getMainOptionsForTier(quality: 'high' | 'medium' | 'low'): Promise<string[]> {
  const preset = await getPreset(quality);
  return preset?.mainOptions || [];
}

/**
 * Get the last active model
 */
export async function getLastActiveModel(): Promise<string | null> {
  const data = await fetchPresets();
  return data.lastActiveModel;
}

/**
 * Get detailed spec for a model by ID
 */
export async function getModelById(modelId: string): Promise<ModelSpec | null> {
  try {
    return await fetchModelSpec(modelId);
  } catch (error) {
    console.error(`[Models] Failed to fetch model spec for ${modelId}:`, error);
    return null;
  }
}

/**
 * Get suggested models pending approval
 */
export async function fetchSuggestedModels(): Promise<ModelSpec[]> {
  try {
    const data = await getSuggestedModels();
    return data.suggested || [];
  } catch (error) {
    console.error('[Models] Failed to fetch suggested models:', error);
    return [];
  }
}

/**
 * Invalidate the presets cache
 */
export function invalidatePresetsCache(): void {
  presetsCache = null;
  presetsCacheTime = 0;
}

// =============================================================================
// Helper functions for UI
// =============================================================================

/**
 * Get display name for a model ID
 */
export function getModelDisplayName(modelId: string): string {
  // Extract the model name from the full ID
  const parts = modelId.split('/');
  const name = parts[parts.length - 1];
  
  // Remove common suffixes
  return name
    .replace(/-GGUF$/i, '')
    .replace(/@.*$/, '')
    .replace(/-instruct$/i, ' Instruct')
    .replace(/-chat$/i, ' Chat');
}

/**
 * Get performance color for UI
 */
export function getPerformanceColor(level: string): string {
  switch (level) {
    case 'Excellent': return 'text-green-400';
    case 'Good': return 'text-blue-400';
    case 'Fair': return 'text-yellow-400';
    case 'Basic': return 'text-red-400';
    case 'Very Fast': return 'text-green-400';
    case 'Fast': return 'text-blue-400';
    case 'Moderate': return 'text-yellow-400';
    case 'Slow': return 'text-red-400';
    default: return 'text-gray-400';
  }
}

/**
 * Get tier badge color
 */
export function getTierColor(tier: 'high' | 'medium' | 'low'): string {
  switch (tier) {
    case 'high': return 'bg-purple-500/20 text-purple-400';
    case 'medium': return 'bg-blue-500/20 text-blue-400';
    case 'low': return 'bg-green-500/20 text-green-400';
    default: return 'bg-gray-500/20 text-gray-400';
  }
}

/**
 * Get tier display name
 */
export function getTierDisplayName(tier: 'high' | 'medium' | 'low'): string {
  switch (tier) {
    case 'high': return 'High Quality';
    case 'medium': return 'Balanced';
    case 'low': return 'Fast & Lightweight';
    default: return tier;
  }
}

// =============================================================================
// Hardware detection (placeholder for future implementation)
// =============================================================================

export interface HardwareCapabilities {
  gpuMemory: number; // GB
  gpuType: string;
  cpuCores: number;
  ram: number; // GB
}

/**
 * Detect hardware capabilities
 * Note: This is a placeholder. Real implementation would use WebGL or similar.
 */
export function detectHardwareCapabilities(): HardwareCapabilities {
  // For now, return conservative estimates
  return {
    gpuMemory: 8,
    gpuType: 'Unknown GPU',
    cpuCores: 8,
    ram: 32
  };
}

/**
 * Get recommended quality tier based on hardware
 */
export function getRecommendedTier(): 'high' | 'medium' | 'low' {
  const hw = detectHardwareCapabilities();
  
  if (hw.gpuMemory >= 12) {
    return 'high';
  } else if (hw.gpuMemory >= 8) {
    return 'medium';
  } else {
    return 'low';
  }
}
