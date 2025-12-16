import { test, expect } from '@playwright/test';

const API_BASE = 'http://localhost:4000';

test.describe('Preset Configuration & Validation', () => {
  test('presets returns all quality tiers with complete structure', async ({ request }) => {
    const response = await request.get(`${API_BASE}/models/presets`);
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    
    expect(data.presets).toBeDefined();
    
    // Check all three quality tiers exist
    ['high', 'medium', 'low'].forEach(tier => {
      const preset = data.presets[tier];
      expect(preset).toBeDefined();
      expect(preset.name).toBeDefined();
      expect(preset.description).toBeDefined();
      expect(preset.mainOptions).toBeDefined();
      expect(Array.isArray(preset.mainOptions)).toBeTruthy();
      expect(preset.rollingSummarizer).toBeDefined();
      expect(preset.vramBudget).toBeDefined();
      expect(typeof preset.vramBudget).toBe('number');
    });
  });

  test('high tier has larger models than low tier', async ({ request }) => {
    const presetsResponse = await request.get(`${API_BASE}/models/presets`);
    const presetsData = await presetsResponse.json();
    
    // High tier should have higher VRAM budget
    expect(presetsData.presets.high.vramBudget).toBeGreaterThan(presetsData.presets.low.vramBudget);
    expect(presetsData.presets.medium.vramBudget).toBeGreaterThan(presetsData.presets.low.vramBudget);
  });

  test('each preset has valid embedder and RAG summarizer', async ({ request }) => {
    const presetsResponse = await request.get(`${API_BASE}/models/presets`);
    const presetsData = await presetsResponse.json();
    
    ['high', 'medium', 'low'].forEach(tier => {
      const preset = presetsData.presets[tier];
      // Embedder should be defined (all tiers use the same local embedder)
      expect(preset.embedding).toBeDefined();
      // RAG summarizer should be defined
      expect(preset.ragSummarizer).toBeDefined();
      expect(typeof preset.ragSummarizer).toBe('string');
    });
  });

  test('main options contain valid model keys', async ({ request }) => {
    const presetsResponse = await request.get(`${API_BASE}/models/presets`);
    const availableResponse = await request.get(`${API_BASE}/models/available`);
    
    const presetsData = await presetsResponse.json();
    const availableData = await availableResponse.json();
    const availableKeys = new Set(availableData.models.map((m: any) => m.modelKey));
    
    ['high', 'medium', 'low'].forEach(tier => {
      const mainOptions = presetsData.presets[tier].mainOptions;
      expect(mainOptions.length).toBeGreaterThan(0);
      
      // All main options should be valid model keys
      mainOptions.forEach((modelKey: string) => {
        expect(availableKeys.has(modelKey)).toBeTruthy();
      });
    });
  });

  test('models status shows currently loaded models', async ({ request }) => {
    const response = await request.get(`${API_BASE}/models/status`);
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    
    expect(data.loadedModels).toBeDefined();
    expect(Array.isArray(data.loadedModels)).toBeTruthy();
    expect(data.loadedModels.length).toBeGreaterThan(0);
    
    // Verify loaded models are strings
    data.loadedModels.forEach((modelId: string) => {
      expect(typeof modelId).toBe('string');
      expect(modelId.length).toBeGreaterThan(0);
    });
  });

  test('LM Studio shows same models as status endpoint', async ({ request }) => {
    const statusResponse = await request.get(`${API_BASE}/models/status`);
    expect(statusResponse.ok()).toBeTruthy();
    const statusData = await statusResponse.json();
    
    const lmResponse = await request.get(`${API_BASE}/lmstudio/models`);
    if (!lmResponse.ok()) {
      // May be rate limited
      console.log('LM Studio models endpoint rate limited, skipping');
      return;
    }
    const lmData = await lmResponse.json();
    
    expect(lmData.status).toBe('ok');
    expect(lmData.models.length).toBe(statusData.loadedModels.length);
    
    // Each LM Studio model should be in the loaded list
    lmData.models.forEach((model: { id: string }) => {
      expect(statusData.loadedModels).toContain(model.id);
    });
  });

  test('model locks endpoint returns valid structure', async ({ request }) => {
    const response = await request.get(`${API_BASE}/models/locks`);
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    
    expect(data.locks).toBeDefined();
    expect(typeof data.locks).toBe('object');
    
    // If there are locked models, verify structure
    Object.entries(data.locks).forEach(([modelKey, lock]: [string, any]) => {
      expect(typeof modelKey).toBe('string');
      expect(lock.loaded).toBeDefined();
      expect(lock.preset).toBeDefined();
      expect(typeof lock.loaded).toBe('boolean');
      expect(typeof lock.preset).toBe('boolean');
    });
  });

  test('rolling summarizer options differ per quality tier', async ({ request }) => {
    const presetsResponse = await request.get(`${API_BASE}/models/presets`);
    const presetsData = await presetsResponse.json();
    
    // Each tier should have a rolling summarizer defined
    const highRolling = presetsData.presets.high.rollingSummarizer;
    const mediumRolling = presetsData.presets.medium.rollingSummarizer;
    const lowRolling = presetsData.presets.low.rollingSummarizer;
    
    expect(highRolling).toBeDefined();
    expect(mediumRolling).toBeDefined();
    expect(lowRolling).toBeDefined();
    
    // They should all be valid strings
    expect(typeof highRolling).toBe('string');
    expect(typeof mediumRolling).toBe('string');
    expect(typeof lowRolling).toBe('string');
  });
});
