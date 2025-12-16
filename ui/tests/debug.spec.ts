import { test, expect } from '@playwright/test';

const API_BASE = 'http://localhost:4000';

test.describe('Debug & Diagnostics', () => {
  test('debug page loads', async ({ page }) => {
    await page.goto('/debug');
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('body')).toBeVisible();
  });

  test('RAG system health is available', async ({ request }) => {
    const response = await request.get(`${API_BASE}/rag/tier`);
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    
    expect(data.status).toBe('ok');
    expect(data.currentTier).toBeDefined();
    expect(data.config).toBeDefined();
  });

  test('indexing status provides complete info', async ({ request }) => {
    const response = await request.get(`${API_BASE}/rag/indexing-status`);
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    
    expect(data.isIndexing).toBeDefined();
    expect(data.filesProcessed).toBeDefined();
    expect(data.chunksProcessed).toBeDefined();
    expect(data.status).toBeDefined();
    
    // DB stats should be present
    expect(data.dbStats).toBeDefined();
    expect(data.dbStats.chunkCount).toBeGreaterThanOrEqual(0);
    expect(data.dbStats.fileCount).toBeGreaterThanOrEqual(0);
    
    // FAISS stats should be present
    expect(data.faissStats).toBeDefined();
    expect(data.faissStats.entries).toBeGreaterThanOrEqual(0);
    expect(data.faissStats.dim).toBeDefined();
  });

  test('embedding dimension is correct', async ({ request }) => {
    const response = await request.get(`${API_BASE}/rag/indexing-status`);
    const data = await response.json();
    
    // Standard embedding dimensions (384, 512, 768, 1024, etc.)
    const validDims = [384, 512, 768, 1024, 1536];
    expect(validDims).toContain(data.faissStats.dim);
  });

  test('LM Studio connection is healthy', async ({ request }) => {
    const response = await request.get(`${API_BASE}/lmstudio/health`);
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    
    expect(data.status).toBe('ok');
    expect(data.ready).toBe(true);
    expect(data.models_loaded).toBeGreaterThan(0);
    expect(Array.isArray(data.models)).toBeTruthy();
  });

  test('detailed health includes all components', async ({ request }) => {
    const response = await request.get(`${API_BASE}/health/detailed`);
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    
    expect(data.status).toBeDefined();
    expect(data.uptime).toBeDefined();
    expect(data.components).toBeDefined();
  });

  test('metrics endpoint provides request stats', async ({ request }) => {
    const response = await request.get(`${API_BASE}/metrics`);
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    
    expect(data.totalRequests).toBeDefined();
    expect(data.totalErrors).toBeDefined();
    expect(data.engines).toBeDefined();
    expect(data.models).toBeDefined();
  });

  test('page renders without errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    
    await page.goto('/debug');
    await page.waitForLoadState('domcontentloaded');
    
    expect(errors.length).toBe(0);
  });
});
