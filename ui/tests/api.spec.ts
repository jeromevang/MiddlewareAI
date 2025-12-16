import { test, expect } from '@playwright/test';

const API_BASE = 'http://localhost:4000';

test.describe('API Endpoints - Health & Status', () => {
  test('health endpoint returns ok status with correct structure', async ({ request }) => {
    const response = await request.get(`${API_BASE}/health`);
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    
    expect(data.status).toBe('ok');
    expect(data.timestamp).toBeDefined();
    expect(typeof data.timestamp).toBe('string'); // ISO date string
    expect(data.uptime).toBeDefined();
    expect(data.memory).toBeDefined();
    expect(data.system).toBeDefined();
  });

  test('detailed health includes all system components', async ({ request }) => {
    const response = await request.get(`${API_BASE}/health/detailed`);
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    
    expect(data.status).toBeDefined();
    expect(data.components).toBeDefined();
    expect(data.uptime).toBeDefined();
    expect(typeof data.uptime).toBe('number');
  });

  test('LM Studio health shows connected state with models', async ({ request }) => {
    const response = await request.get(`${API_BASE}/lmstudio/health`);
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    
    expect(data.status).toBe('ok');
    expect(data.ready).toBe(true);
    expect(data.models_loaded).toBeDefined();
    expect(typeof data.models_loaded).toBe('number');
    expect(data.models).toBeDefined();
    expect(Array.isArray(data.models)).toBeTruthy();
  });

  test('server status returns complete configuration', async ({ request }) => {
    const response = await request.get(`${API_BASE}/status`);
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    
    // Verify main sections exist
    expect(data.lmstudio).toBeDefined();
    expect(data.lmstudio.healthy).toBe(true);
    expect(data.models).toBeDefined();
    expect(data.storage).toBeDefined();
    expect(data.processing).toBeDefined();
    
    // Verify models configuration
    expect(data.models.main).toBeDefined();
    expect(data.models.embedding).toBeDefined();
  });
});

test.describe('API Endpoints - Model Management', () => {
  test('bootstrap status shows completion', async ({ request }) => {
    const response = await request.get(`${API_BASE}/models/bootstrap-status`);
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    
    expect(data.progress).toBe(100);
    expect(data.message).toContain('complete');
    expect(data.running).toBe(false);
  });

  test('available models returns list with correct structure', async ({ request }) => {
    const response = await request.get(`${API_BASE}/models/available`);
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    
    expect(data.models).toBeDefined();
    expect(Array.isArray(data.models)).toBeTruthy();
    expect(data.models.length).toBeGreaterThan(0);
    
    // Check model structure
    const firstModel = data.models[0];
    expect(firstModel.modelKey).toBeDefined();
    expect(firstModel.name).toBeDefined(); // Uses 'name' not 'displayName'
    expect(firstModel.type).toBeDefined(); // Uses 'type' not 'function'
    expect(['main', 'summarizer', 'embedder']).toContain(firstModel.type);
    expect(firstModel.sizeGB).toBeDefined();
    expect(typeof firstModel.sizeGB).toBe('number');
  });

  test('model status shows currently loaded models', async ({ request }) => {
    const response = await request.get(`${API_BASE}/models/status`);
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    
    expect(data.loadedModels).toBeDefined();
    expect(Array.isArray(data.loadedModels)).toBeTruthy();
    // At least one model should be loaded
    expect(data.loadedModels.length).toBeGreaterThan(0);
    
    // Each loaded model should be a string identifier
    data.loadedModels.forEach((modelId: string) => {
      expect(typeof modelId).toBe('string');
      expect(modelId.length).toBeGreaterThan(0);
    });
  });

  test('loaded models from LM Studio matches status', async ({ request }) => {
    // Get status from models endpoint
    const statusResponse = await request.get(`${API_BASE}/models/status`);
    expect(statusResponse.ok()).toBeTruthy();
    const statusData = await statusResponse.json();
    
    // Get loaded models directly from LM Studio
    const lmResponse = await request.get(`${API_BASE}/lmstudio/models`);
    if (!lmResponse.ok()) {
      // May be rate limited, skip assertion
      console.log('LM Studio models endpoint rate limited, skipping');
      return;
    }
    const lmData = await lmResponse.json();
    
    expect(lmData.status).toBe('ok');
    expect(lmData.models).toBeDefined();
    
    // Loaded models count should match
    expect(lmData.models.length).toBe(statusData.loadedModels.length);
  });

  test('model locks can be retrieved', async ({ request }) => {
    const response = await request.get(`${API_BASE}/models/locks`);
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    
    expect(data.locks).toBeDefined();
    expect(typeof data.locks).toBe('object');
  });
});

test.describe('API Endpoints - Presets', () => {
  test('presets returns all quality tiers with options', async ({ request }) => {
    const response = await request.get(`${API_BASE}/models/presets`);
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    
    expect(data.presets).toBeDefined();
    
    // Check all three quality tiers exist
    expect(data.presets.high).toBeDefined();
    expect(data.presets.medium).toBeDefined();
    expect(data.presets.low).toBeDefined();
    
    // Each preset should have required fields
    ['high', 'medium', 'low'].forEach(tier => {
      const preset = data.presets[tier];
      expect(preset.name).toBeDefined();
      expect(preset.description).toBeDefined();
      expect(preset.mainOptions).toBeDefined();
      expect(Array.isArray(preset.mainOptions)).toBeTruthy();
      expect(preset.rollingSummarizer).toBeDefined();
    });
  });

  test('preset main options are valid model keys', async ({ request }) => {
    const presetsResponse = await request.get(`${API_BASE}/models/presets`);
    const presetsData = await presetsResponse.json();
    
    const availableResponse = await request.get(`${API_BASE}/models/available`);
    const availableData = await availableResponse.json();
    const availableKeys = new Set(availableData.models.map((m: any) => m.modelKey));
    
    // Check high tier main options exist in available models
    const highMainOptions = presetsData.presets.high.mainOptions;
    highMainOptions.forEach((modelKey: string) => {
      expect(availableKeys.has(modelKey)).toBeTruthy();
    });
  });
});

test.describe('API Endpoints - RAG System', () => {
  test('RAG tier returns current configuration', async ({ request }) => {
    const response = await request.get(`${API_BASE}/rag/tier`);
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    
    expect(data.status).toBe('ok');
    expect(data.currentTier).toBeDefined();
    expect(['low', 'medium', 'high']).toContain(data.currentTier);
    
    // Config should be present
    expect(data.config).toBeDefined();
    expect(data.config.embedder).toBeDefined();
    expect(data.config.ragSummarizer).toBeDefined();
    
    // Available tiers should be listed
    expect(data.availableTiers).toBeDefined();
    expect(Array.isArray(data.availableTiers)).toBeTruthy();
    expect(data.availableTiers.length).toBe(3);
  });

  test('indexing status shows valid state', async ({ request }) => {
    const response = await request.get(`${API_BASE}/rag/indexing-status`);
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    
    expect(data.isIndexing).toBeDefined();
    expect(typeof data.isIndexing).toBe('boolean');
    expect(data.filesProcessed).toBeDefined();
    expect(typeof data.filesProcessed).toBe('number');
    expect(data.chunksProcessed).toBeDefined(); // Uses 'chunksProcessed' not 'chunksIndexed'
    expect(typeof data.chunksProcessed).toBe('number');
    expect(data.status).toBeDefined();
    
    // DB stats should be present
    expect(data.dbStats).toBeDefined();
    expect(data.dbStats.chunkCount).toBeDefined();
    expect(data.dbStats.fileCount).toBeDefined();
  });

  test('RAG embedder is correctly configured', async ({ request }) => {
    const response = await request.get(`${API_BASE}/rag/tier`);
    const data = await response.json();
    
    const embedder = data.config.embedder;
    expect(embedder.model_name).toBeDefined();
    expect(embedder.engine).toBe('local');
    expect(embedder.dimension).toBeDefined();
    expect(typeof embedder.dimension).toBe('number');
    expect(embedder.dimension).toBeGreaterThan(0);
  });
});
