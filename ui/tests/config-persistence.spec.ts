import { test, expect } from '@playwright/test';

const API_BASE = 'http://localhost:4000';

test.describe('Configuration - Status Endpoint', () => {
  test.setTimeout(15000);

  test('status endpoint returns complete configuration', async ({ request }) => {
    const response = await request.get(`${API_BASE}/status`);
    expect(response.ok()).toBeTruthy();
    const status = await response.json();
    
    // Required sections
    expect(status.models).toBeDefined();
    expect(status.processing).toBeDefined();
    expect(status.storage).toBeDefined();
    expect(status.engines).toBeDefined();
    expect(status.config).toBeDefined();
    expect(status.config.system).toBeDefined();
  });

  test('models config contains required fields', async ({ request }) => {
    const response = await request.get(`${API_BASE}/status`);
    const status = await response.json();
    
    expect(status.models.main).toBeDefined();
    expect(status.config.models.activePreset).toBeDefined();
    
    // Main model should have identifier
    if (status.models.main) {
      expect(status.models.main.identifier).toBeDefined();
    }
  });

  test('system config has expected settings', async ({ request }) => {
    const response = await request.get(`${API_BASE}/status`);
    const status = await response.json();
    
    expect(status.config.system).toBeDefined();
    expect(typeof status.config.system.autoBootstrapOnStartup).toBe('boolean');
    expect(typeof status.config.system.autoLoadModels).toBe('boolean');
    expect(typeof status.config.system.minMainContextTokens).toBe('number');
  });

  test('storage config has required paths', async ({ request }) => {
    const response = await request.get(`${API_BASE}/status`);
    const status = await response.json();
    
    expect(status.storage.faiss_index_path).toBeDefined();
    expect(status.storage.embedding_dimension).toBeDefined();
  });
});

test.describe('Configuration - Config API', () => {
  test.setTimeout(15000);

  test('config endpoint returns current config', async ({ request }) => {
    const response = await request.get(`${API_BASE}/api/config`);
    expect(response.ok()).toBeTruthy();
    const config = await response.json();
    
    // Config is returned directly (not wrapped)
    expect(config.system).toBeDefined();
    expect(config.models).toBeDefined();
    expect(config.processing).toBeDefined();
  });

  test('system settings endpoint returns settings', async ({ request }) => {
    const response = await request.get(`${API_BASE}/api/system-settings`);
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    
    expect(data.status).toBe('ok');
    expect(data.settings).toBeDefined();
    expect(data.settings.minMainContextTokens).toBeDefined();
    expect(data.settings.summarizerContextTokens).toBeDefined();
    expect(data.settings.autoBootstrapOnStartup).toBeDefined();
  });
});

test.describe('Configuration - Preset Persistence', () => {
  test.setTimeout(60000);

  test('active preset is saved in config', async ({ request }) => {
    const statusResponse = await request.get(`${API_BASE}/status`);
    const status = await statusResponse.json();
    
    const activePreset = status.config.models.activePreset;
    expect(['high', 'medium', 'low', 'custom']).toContain(activePreset);
  });

  test('preset model selections are persisted', async ({ request }) => {
    const statusResponse = await request.get(`${API_BASE}/status`);
    const status = await statusResponse.json();
    
    // Check that per-quality model selections exist
    if (status.models.perQualityMainModels) {
      expect(typeof status.models.perQualityMainModels).toBe('object');
    }
    
    if (status.models.perQualityRollingSummarizers) {
      expect(typeof status.models.perQualityRollingSummarizers).toBe('object');
    }
  });

  test('RAG tier selection is persisted', async ({ request }) => {
    // Get current tier
    const tierResponse = await request.get(`${API_BASE}/rag/tier`);
    const tierData = await tierResponse.json();
    
    const currentTier = tierData.currentTier;
    expect(['low', 'medium', 'high']).toContain(currentTier);
    
    // Verify it matches status
    const statusResponse = await request.get(`${API_BASE}/status`);
    const status = await statusResponse.json();
    
    expect(status.rag?.activeTier || currentTier).toBe(currentTier);
  });
});

test.describe('Configuration - Settings Updates', () => {
  test.setTimeout(30000);

  let originalSettings: any;

  test.beforeAll(async ({ request }) => {
    // Save original settings
    const response = await request.get(`${API_BASE}/api/system-settings`);
    originalSettings = await response.json();
  });

  test.afterAll(async ({ request }) => {
    // Restore original settings
    if (originalSettings) {
      await request.patch(`${API_BASE}/api/system-settings`, {
        data: {
          autoBootstrapOnStartup: originalSettings.autoBootstrapOnStartup,
          autoLoadModels: originalSettings.autoLoadModels,
          autoLoadDelayMs: originalSettings.autoLoadDelayMs
        }
      });
    }
  });

  test('system settings PATCH endpoint accepts updates', async ({ request }) => {
    // Test that PATCH endpoint responds correctly (actual persistence verified elsewhere)
    const updateResponse = await request.patch(`${API_BASE}/api/system-settings`, {
      data: { autoLoadDelayMs: 2000 }
    });
    
    expect(updateResponse.ok()).toBeTruthy();
    const result = await updateResponse.json();
    expect(result.status).toBe('ok');
    expect(result.settings).toBeDefined();
  });

  test('invalid settings are rejected', async ({ request }) => {
    // Try to set invalid value
    const response = await request.patch(`${API_BASE}/api/system-settings`, {
      data: {
        minMainContextTokens: -100 // Invalid
      }
    });
    
    // Should be rejected
    expect(response.status()).toBe(400);
  });
});

test.describe('Configuration - Model Selection Persistence', () => {
  test.setTimeout(60000);

  test('model selection for quality preset is saved', async ({ request }) => {
    // Get available models
    const availableResponse = await request.get(`${API_BASE}/models/available`);
    const available = await availableResponse.json();
    
    const mainModels = available.models.filter((m: any) => 
      m.type === 'main' || m.function === 'main'
    );
    
    if (mainModels.length < 2) {
      console.log('Not enough main models to test selection');
      return;
    }
    
    // Get current preset
    const statusResponse = await request.get(`${API_BASE}/status`);
    const status = await statusResponse.json();
    const currentPreset = status.models.activePreset;
    
    // Try selecting a different model
    const modelToSelect = mainModels[0].modelKey;
    
    const selectResponse = await request.post(`${API_BASE}/presets/quality-model`, {
      data: {
        quality: currentPreset,
        modelId: modelToSelect
      }
    });
    
    if (selectResponse.ok()) {
      // Verify selection was saved
      const verifyResponse = await request.get(`${API_BASE}/status`);
      const verifyStatus = await verifyResponse.json();
      
      const savedSelection = verifyStatus.models.perQualityMainModels?.[currentPreset];
      expect(savedSelection).toBe(modelToSelect);
    }
  });

  test('summarizer selection for quality preset is saved', async ({ request }) => {
    // Get available models
    const availableResponse = await request.get(`${API_BASE}/models/available`);
    const available = await availableResponse.json();
    
    const summarizerModels = available.models.filter((m: any) => 
      m.type === 'summarizer' || m.function === 'summarizer' || m.type === 'main'
    );
    
    if (summarizerModels.length < 1) {
      console.log('No summarizer models available');
      return;
    }
    
    // Get current preset
    const statusResponse = await request.get(`${API_BASE}/status`);
    const status = await statusResponse.json();
    const currentPreset = status.models.activePreset;
    
    // Try selecting a summarizer
    const modelToSelect = summarizerModels[0].modelKey;
    
    const selectResponse = await request.post(`${API_BASE}/presets/quality-summarizer`, {
      data: {
        quality: currentPreset,
        modelId: modelToSelect
      }
    });
    
    if (selectResponse.ok()) {
      // Verify selection was saved
      const verifyResponse = await request.get(`${API_BASE}/status`);
      const verifyStatus = await verifyResponse.json();
      
      const savedSelection = verifyStatus.models.perQualityRollingSummarizers?.[currentPreset];
      expect(savedSelection).toBe(modelToSelect);
    }
  });
});

test.describe('Configuration - Lock Persistence', () => {
  test.setTimeout(30000);

  test('model locks are persisted', async ({ request }) => {
    const locksResponse = await request.get(`${API_BASE}/models/locks`);
    expect(locksResponse.ok()).toBeTruthy();
    const locks = await locksResponse.json();
    
    expect(locks.locks).toBeDefined();
    
    // Lock structure should be correct
    for (const [modelId, lockState] of Object.entries(locks.locks)) {
      const lock = lockState as any;
      expect(typeof lock.loaded).toBe('boolean');
      expect(typeof lock.preset).toBe('boolean');
    }
  });
});

