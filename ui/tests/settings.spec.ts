import { test, expect } from '@playwright/test';

const API_BASE = 'http://localhost:4000';

test.describe('Settings Page', () => {
  test('settings page loads', async ({ page }) => {
    await page.goto('/settings');
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('body')).toBeVisible();
  });

  test('server status returns valid configuration', async ({ request }) => {
    const response = await request.get(`${API_BASE}/status`);
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    
    // Core configuration should be present
    expect(data.config).toBeDefined();
    expect(data.models).toBeDefined();
    expect(data.storage).toBeDefined();
    expect(data.processing).toBeDefined();
  });

  test('context configuration is present in processing', async ({ request }) => {
    const response = await request.get(`${API_BASE}/status`);
    const data = await response.json();
    
    // Context settings should be present in processing config
    expect(data.processing).toBeDefined();
    expect(data.processing.max_context_tokens).toBeDefined();
    expect(typeof data.processing.max_context_tokens).toBe('number');
    expect(data.processing.max_context_tokens).toBeGreaterThan(0);
    expect(data.processing.context_budget_tokens).toBeDefined();
  });

  test('storage configuration is valid', async ({ request }) => {
    const response = await request.get(`${API_BASE}/status`);
    const data = await response.json();
    
    expect(data.storage).toBeDefined();
    expect(data.storage.embedding_dimension).toBeDefined();
    expect(typeof data.storage.embedding_dimension).toBe('number');
    expect(data.storage.embedding_dimension).toBeGreaterThan(0);
  });

  test('engines configuration is present', async ({ request }) => {
    const response = await request.get(`${API_BASE}/status`);
    const data = await response.json();
    
    expect(data.engines).toBeDefined();
    expect(data.engines.rag).toBeDefined();
    expect(data.engines.summary).toBeDefined();
    expect(typeof data.engines.rag.enabled).toBe('boolean');
    expect(typeof data.engines.summary.enabled).toBe('boolean');
  });

  test('LM Studio config is present', async ({ request }) => {
    const response = await request.get(`${API_BASE}/status`);
    const data = await response.json();
    
    expect(data.lmstudio).toBeDefined();
    expect(data.lmstudio.healthy).toBe(true);
    expect(data.lmstudio.url).toBeDefined();
  });

  test('page renders without errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    
    await page.goto('/settings');
    await page.waitForLoadState('domcontentloaded');
    
    expect(errors.length).toBe(0);
  });
});
