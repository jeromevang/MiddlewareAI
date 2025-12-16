import { test, expect } from '@playwright/test';

const API_BASE = 'http://localhost:4000';

test.describe('Models Management', () => {
  test('models page loads', async ({ page }) => {
    await page.goto('/models');
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('body')).toBeVisible();
  });

  test('available models endpoint returns complete list', async ({ request }) => {
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
      expect(model.sizeGB).toBeDefined();
    });
  });

  test('model status shows loaded models', async ({ request }) => {
    const response = await request.get(`${API_BASE}/models/status`);
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    
    expect(data.loadedModels).toBeDefined();
    expect(Array.isArray(data.loadedModels)).toBeTruthy();
    expect(data.loadedModels.length).toBeGreaterThan(0);
  });

  test('LM Studio models match loaded status', async ({ request }) => {
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
  });

  test('model locks can be queried', async ({ request }) => {
    const response = await request.get(`${API_BASE}/models/locks`);
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    
    expect(data.locks).toBeDefined();
    expect(typeof data.locks).toBe('object');
  });

  test('bootstrap status shows completed state', async ({ request }) => {
    const response = await request.get(`${API_BASE}/models/bootstrap-status`);
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    
    expect(data.progress).toBe(100);
    expect(data.running).toBe(false);
    expect(data.message).toContain('complete');
  });

  test('models have valid context lengths', async ({ request }) => {
    const response = await request.get(`${API_BASE}/models/available`);
    const data = await response.json();
    
    // Main models should have reasonable context lengths
    const mainModels = data.models.filter((m: any) => m.type === 'main');
    mainModels.forEach((model: any) => {
      if (model.maxContextLength) {
        expect(model.maxContextLength).toBeGreaterThan(0);
        expect(model.maxContextLength).toBeLessThan(5000000); // Sanity check
      }
    });
  });

  test('page renders without errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    
    await page.goto('/models');
    await page.waitForLoadState('domcontentloaded');
    
    expect(errors.length).toBe(0);
  });
});
