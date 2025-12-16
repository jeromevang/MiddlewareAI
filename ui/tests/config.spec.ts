import { test, expect } from '@playwright/test';

const API_BASE = 'http://localhost:4000';

test.describe('Model Configuration Page', () => {
  test('configuration page loads', async ({ page }) => {
    await page.goto('/config');
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('body')).toBeVisible();
  });

  test('API returns current model configuration', async ({ request }) => {
    const response = await request.get(`${API_BASE}/status`);
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    
    expect(data.models).toBeDefined();
    expect(data.models.main).toBeDefined();
    expect(data.models.main.identifier).toBeDefined();
    expect(typeof data.models.main.identifier).toBe('string');
    
    // Embedding config should be present
    expect(data.models.embedding).toBeDefined();
    expect(data.models.embedding.identifier).toBeDefined();
  });

  test('presets are properly configured', async ({ request }) => {
    const response = await request.get(`${API_BASE}/models/presets`);
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    
    // All quality presets must exist
    expect(data.presets.high).toBeDefined();
    expect(data.presets.medium).toBeDefined();
    expect(data.presets.low).toBeDefined();
    
    // Each preset must have mainOptions
    expect(data.presets.high.mainOptions.length).toBeGreaterThan(0);
    expect(data.presets.medium.mainOptions.length).toBeGreaterThan(0);
    expect(data.presets.low.mainOptions.length).toBeGreaterThan(0);
  });

  test('available models list is populated', async ({ request }) => {
    const response = await request.get(`${API_BASE}/models/available`);
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    
    expect(data.models).toBeDefined();
    expect(data.models.length).toBeGreaterThan(0);
    
    // Check at least some are main type
    const mainModels = data.models.filter((m: any) => m.type === 'main');
    expect(mainModels.length).toBeGreaterThan(0);
    
    // Check some are summarizer type
    const summarizers = data.models.filter((m: any) => m.type === 'summarizer');
    expect(summarizers.length).toBeGreaterThan(0);
  });

  test('RAG pipeline tier is configured', async ({ request }) => {
    const response = await request.get(`${API_BASE}/rag/tier`);
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    
    expect(data.currentTier).toBeDefined();
    expect(['low', 'medium', 'high']).toContain(data.currentTier);
    expect(data.config.embedder).toBeDefined();
    expect(data.config.ragSummarizer).toBeDefined();
  });

  test('page renders without errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    
    await page.goto('/config');
    await page.waitForLoadState('domcontentloaded');
    
    expect(errors.length).toBe(0);
  });
});
