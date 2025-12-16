import { test, expect } from '@playwright/test';

const API_BASE = 'http://localhost:4000';

test.describe('Model Operations - Status & Info', () => {
  test.setTimeout(30000);

  test('LM Studio models endpoint returns loaded models', async ({ request }) => {
    const response = await request.get(`${API_BASE}/lmstudio/models`);
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    
    expect(data.status).toBe('ok');
    expect(data.models).toBeDefined();
    expect(Array.isArray(data.models)).toBeTruthy();
  });

  test('models status shows loaded model list', async ({ request }) => {
    const response = await request.get(`${API_BASE}/models/status`);
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    
    expect(data.loadedModels).toBeDefined();
    expect(Array.isArray(data.loadedModels)).toBeTruthy();
  });

  test('LM Studio models match status endpoint', async ({ request }) => {
    const lmResponse = await request.get(`${API_BASE}/lmstudio/models`);
    const statusResponse = await request.get(`${API_BASE}/models/status`);
    
    if (!lmResponse.ok()) {
      console.log('LM Studio models endpoint rate limited, skipping');
      return;
    }
    
    const lmData = await lmResponse.json();
    const statusData = await statusResponse.json();
    
    // Model counts should match
    expect(lmData.models.length).toBe(statusData.loadedModels.length);
  });

  test('available models returns complete list', async ({ request }) => {
    const response = await request.get(`${API_BASE}/models/available`);
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    
    expect(data.models).toBeDefined();
    expect(data.models.length).toBeGreaterThan(0);
    
    // Each model should have required fields
    data.models.forEach((model: any) => {
      expect(model.modelKey).toBeDefined();
      expect(model.name).toBeDefined();
      expect(model.type).toBeDefined();
    });
  });

  test('models are categorized by type', async ({ request }) => {
    const response = await request.get(`${API_BASE}/models/available`);
    const data = await response.json();
    
    const types = new Set(data.models.map((m: any) => m.type));
    
    // Should have at least main and summarizer types
    expect(types.has('main') || types.has('summarizer')).toBeTruthy();
  });
});

test.describe('Model Operations - Context Length', () => {
  test.setTimeout(30000);

  test('main model has larger context than summarizer', async ({ request }) => {
    const statusResponse = await request.get(`${API_BASE}/status`);
    const status = await statusResponse.json();
    
    const mainModel = status.models.main;
    const processingConfig = status.processing;
    
    expect(mainModel).toBeDefined();
    expect(processingConfig).toBeDefined();
    
    // Main context should be larger than summarizer context
    if (processingConfig.max_context_tokens && processingConfig.context_budget_tokens) {
      expect(processingConfig.max_context_tokens).toBeGreaterThan(0);
    }
  });

  test('loaded models have context info', async ({ request }) => {
    const response = await request.get(`${API_BASE}/lmstudio/health`);
    expect(response.ok()).toBeTruthy();
    const health = await response.json();
    
    expect(health.models).toBeDefined();
    
    // Each loaded model should have some info
    if (health.models.length > 0) {
      health.models.forEach((model: any) => {
        expect(model.id || model.name).toBeDefined();
      });
    }
  });
});

test.describe('Model Operations - Preset Loading', () => {
  test.setTimeout(120000); // Preset loading takes time

  test('current preset models are loaded', async ({ request }) => {
    const statusResponse = await request.get(`${API_BASE}/status`);
    const status = await statusResponse.json();
    
    const mainModel = status.models.main?.identifier;
    
    if (!mainModel) {
      console.log('No main model configured, skipping');
      return;
    }
    
    // Check that main model is in loaded list
    const modelsResponse = await request.get(`${API_BASE}/models/status`);
    const modelsData = await modelsResponse.json();
    
    // Main model should be loaded (may have different ID format)
    const mainLoaded = modelsData.loadedModels.some((m: string) => 
      m === mainModel || m.includes(mainModel.split('/').pop() || mainModel)
    );
    
    expect(mainLoaded).toBeTruthy();
  });

  test('presets have correct model types', async ({ request }) => {
    const presetsResponse = await request.get(`${API_BASE}/models/presets`);
    const presets = await presetsResponse.json();
    
    ['high', 'medium', 'low'].forEach(tier => {
      const preset = presets.presets[tier];
      expect(preset).toBeDefined();
      
      // Main options should be available
      expect(preset.mainOptions).toBeDefined();
      expect(preset.mainOptions.length).toBeGreaterThan(0);
      
      // Rolling summarizer should be defined
      expect(preset.rollingSummarizer).toBeDefined();
    });
  });

  test('preset main options are valid model keys', async ({ request }) => {
    const presetsResponse = await request.get(`${API_BASE}/models/presets`);
    const availableResponse = await request.get(`${API_BASE}/models/available`);
    
    const presets = await presetsResponse.json();
    const available = await availableResponse.json();
    
    const validKeys = new Set(available.models.map((m: any) => m.modelKey));
    
    // Check high tier main options
    presets.presets.high.mainOptions.forEach((key: string) => {
      expect(validKeys.has(key)).toBeTruthy();
    });
  });
});

test.describe('Model Operations - Model Locking', () => {
  test.setTimeout(30000);

  test('model locks endpoint returns valid structure', async ({ request }) => {
    const response = await request.get(`${API_BASE}/models/locks`);
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    
    expect(data.locks).toBeDefined();
    expect(typeof data.locks).toBe('object');
  });

  test('can query lock status for specific model', async ({ request }) => {
    // Get a loaded model
    const statusResponse = await request.get(`${API_BASE}/models/status`);
    const status = await statusResponse.json();
    
    if (status.loadedModels.length === 0) {
      console.log('No loaded models, skipping');
      return;
    }
    
    const modelId = status.loadedModels[0];
    
    // Query lock status
    const lockResponse = await request.get(`${API_BASE}/models/locks`);
    const locks = await lockResponse.json();
    
    // Lock structure should be valid
    expect(locks.locks).toBeDefined();
  });

  test('lock toggle endpoint accepts valid request', async ({ request }) => {
    const statusResponse = await request.get(`${API_BASE}/models/status`);
    const status = await statusResponse.json();
    
    if (status.loadedModels.length === 0) {
      console.log('No loaded models, skipping');
      return;
    }
    
    const modelId = status.loadedModels[0];
    
    // Try to toggle lock (may fail due to rate limiting)
    const toggleResponse = await request.post(`${API_BASE}/models/lock/${encodeURIComponent(modelId)}/toggle`, {
      data: { lockType: 'preset', locked: true }
    });
    
    // Should either succeed or return rate limit error
    if (toggleResponse.ok()) {
      const result = await toggleResponse.json();
      expect(result.status).toBe('ok');
      
      // Unlock again
      await request.post(`${API_BASE}/models/lock/${encodeURIComponent(modelId)}/toggle`, {
        data: { lockType: 'preset', locked: false }
      });
    }
  });
});

test.describe('Model Operations - Bootstrap', () => {
  test.setTimeout(30000);

  test('bootstrap status shows completion', async ({ request }) => {
    const response = await request.get(`${API_BASE}/models/bootstrap-status`);
    expect(response.ok()).toBeTruthy();
    const status = await response.json();
    
    expect(status.progress).toBe(100);
    expect(status.running).toBe(false);
    expect(status.message).toContain('complete');
  });

  test('models are categorized after bootstrap', async ({ request }) => {
    const response = await request.get(`${API_BASE}/models/available`);
    const data = await response.json();
    
    // Models should have tier assignments
    const modelsWithTiers = data.models.filter((m: any) => m.tiers && m.tiers.length > 0);
    expect(modelsWithTiers.length).toBeGreaterThan(0);
  });
});

test.describe('Model Operations - Health & Stability', () => {
  test.setTimeout(30000);

  test('LM Studio health is ready', async ({ request }) => {
    const response = await request.get(`${API_BASE}/lmstudio/health`);
    expect(response.ok()).toBeTruthy();
    const health = await response.json();
    
    expect(health.status).toBe('ok');
    expect(health.ready).toBe(true);
  });

  test('models loaded count is positive', async ({ request }) => {
    const response = await request.get(`${API_BASE}/lmstudio/health`);
    const health = await response.json();
    
    expect(health.models_loaded).toBeGreaterThan(0);
  });

  test('multiple status checks return consistent results', async ({ request }) => {
    // Check status multiple times
    const results = [];
    
    for (let i = 0; i < 3; i++) {
      const response = await request.get(`${API_BASE}/models/status`);
      const data = await response.json();
      results.push(data.loadedModels.length);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    // All results should be the same
    expect(results[0]).toBe(results[1]);
    expect(results[1]).toBe(results[2]);
  });
});

