import { test, expect } from '@playwright/test';
import { injectAxe, checkA11y } from 'axe-playwright';

test.describe('Component Accessibility', () => {
  test('VaultComparisonTable and PoolComparisonDrawer have no a11y violations', async ({ page }) => {
    await page.goto('/app/vaults');
    await injectAxe(page);
    
    // The table should be rendered
    const table = page.locator('table').first();
    await expect(table).toBeVisible();
    
    // Check VaultComparisonTable accessibility
    await checkA11y(page, 'table', {
      axeOptions: {},
      detailedReport: true,
      detailedReportOptions: { html: true },
    });

    // Select 2 pools for comparison to trigger the drawer
    const compareButtons = page.getByTitle('Add to comparison');
    await compareButtons.nth(0).click();
    await compareButtons.nth(1).click();

    // Wait for the drawer to open
    const drawer = page.getByRole('dialog', { name: /Pool Comparison/i });
    await expect(drawer).toBeVisible();

    // Check PoolComparisonDrawer accessibility
    await checkA11y(page, '[role="dialog"]', {
      axeOptions: {},
      detailedReport: true,
      detailedReportOptions: { html: true },
    });
  });
});
