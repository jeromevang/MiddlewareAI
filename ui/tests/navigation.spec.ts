import { test, expect } from '@playwright/test';

test.describe('Navigation & Page Loading', () => {
  test('main dashboard loads and shows LM Studio branding', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('body')).toBeVisible();
    const content = await page.textContent('body');
    expect(content?.toLowerCase()).toMatch(/lm studio|middleware/i);
  });

  test('configuration page accessible via /config', async ({ page }) => {
    await page.goto('/config');
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('body')).toBeVisible();
  });

  test('models management page accessible via /models', async ({ page }) => {
    await page.goto('/models');
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('body')).toBeVisible();
  });

  test('settings page accessible via /settings', async ({ page }) => {
    await page.goto('/settings');
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('body')).toBeVisible();
  });

  test('debug page accessible via /debug', async ({ page }) => {
    await page.goto('/debug');
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('body')).toBeVisible();
  });

  test('summary page accessible via /summary', async ({ page }) => {
    await page.goto('/summary');
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('body')).toBeVisible();
  });

  test('invalid routes are handled gracefully', async ({ page }) => {
    await page.goto('/invalid-route-12345');
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('body')).toBeVisible();
  });

  test('pages render without JavaScript errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    
    expect(errors.length).toBe(0);
  });
});
