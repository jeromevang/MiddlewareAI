import { test, expect } from '@playwright/test';

const API_BASE = 'http://localhost:4000';

test.describe('Dashboard & System Status', () => {
  test('dashboard page loads with system info', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    const pageContent = await page.textContent('body');
    expect(pageContent?.toLowerCase()).toMatch(/lm studio|middleware/i);
  });

  test('API returns valid system status', async ({ request }) => {
    const response = await request.get(`${API_BASE}/status`);
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    
    // Core status fields
    expect(data.lmstudio).toBeDefined();
    expect(data.lmstudio.healthy).toBe(true);
    expect(data.models).toBeDefined();
    
    // Models config should have main model
    expect(data.models.main).toBeDefined();
    expect(data.models.main.identifier).toBeDefined();
  });

  test('hardware info is available', async ({ request }) => {
    const response = await request.get(`${API_BASE}/hardware`);
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    
    expect(data.status).toBe('ok');
    expect(data.hardware).toBeDefined();
    expect(data.hardware.gpu).toBeDefined();
    expect(data.hardware.ram).toBeDefined();
    
    // GPU should have total and free
    expect(data.hardware.gpu.totalGB).toBeDefined();
    expect(typeof data.hardware.gpu.totalGB).toBe('number');
    expect(data.hardware.gpu.freeGB).toBeDefined();
  });

  test('realtime hardware stats available', async ({ request }) => {
    const response = await request.get(`${API_BASE}/hardware/realtime`);
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    
    expect(data.status).toBe('ok');
    expect(data.cpu).toBeDefined();
    expect(data.cpu.usagePercent).toBeDefined();
    expect(data.ram).toBeDefined();
    expect(data.ram.usedGB).toBeDefined();
    expect(data.ram.totalGB).toBeDefined();
    expect(data.vram).toBeDefined();
    expect(data.vram.usedGB).toBeDefined();
  });

  test('metrics endpoint returns engine info', async ({ request }) => {
    const response = await request.get(`${API_BASE}/metrics`);
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    
    expect(data.totalRequests).toBeDefined();
    expect(data.engines).toBeDefined();
    expect(data.engines.rag).toBeDefined();
    expect(data.engines.summary).toBeDefined();
    expect(data.models).toBeDefined();
  });

  test('page renders without console errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    
    expect(errors.length).toBe(0);
  });
});
