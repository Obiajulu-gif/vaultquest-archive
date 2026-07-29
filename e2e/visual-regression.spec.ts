import { test, expect } from '@playwright/test';

test.describe('Visual Regression Tests', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      const style = document.createElement('style');
      style.textContent = `
        *, *::before, *::after {
          animation-duration: 0s !important;
          animation-delay: 0s !important;
          transition-duration: 0s !important;
          transition-delay: 0s !important;
        }
      `;
      document.head.appendChild(style);
    });
  });

  test.describe('Landing Page', () => {
    test('should match landing page screenshot', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(500);
      
      await expect(page).toHaveScreenshot('landing-page.png', {
        fullPage: true,
        animations: 'disabled',
      });
    });

    test('should match landing page hero section', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');
      
      const heroSection = page.locator('text=VaultQuest').locator('..').first();
      await expect(heroSection).toHaveScreenshot('landing-hero.png', {
        animations: 'disabled',
      });
    });
  });

  test.describe('App Dashboard', () => {
    test('should match dashboard disconnected state', async ({ page }) => {
      await page.goto('/app');
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(500);
      
      await expect(page).toHaveScreenshot('dashboard-disconnected.png', {
        fullPage: true,
        animations: 'disabled',
      });
    });

    test('should match dashboard header', async ({ page }) => {
      await page.goto('/app');
      await page.waitForLoadState('networkidle');
      
      const header = page.locator('header, nav').first();
      await expect(header).toHaveScreenshot('dashboard-header.png', {
        animations: 'disabled',
      });
    });

    test('should match start saving section', async ({ page }) => {
      await page.goto('/app');
      await page.waitForLoadState('networkidle');
      
      const startSavingSection = page.locator('text=Start Saving').locator('..').first();
      await expect(startSavingSection).toHaveScreenshot('start-saving-section.png', {
        animations: 'disabled',
      });
    });
  });

  test.describe('Prizes Page', () => {
    test('should match prizes page layout', async ({ page }) => {
      await page.goto('/app/prizes');
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(500);
      
      await expect(page).toHaveScreenshot('prizes-page.png', {
        fullPage: true,
        animations: 'disabled',
      });
    });

    test('should match prize card component', async ({ page }) => {
      await page.goto('/app/prizes');
      await page.waitForLoadState('networkidle');
      
      const prizeCard = page.locator('[class*="card"], [class*="Card"]').first();
      if (await prizeCard.isVisible()) {
        await expect(prizeCard).toHaveScreenshot('prize-card.png', {
          animations: 'disabled',
        });
      }
    });
  });

  test.describe('Vaults Page', () => {
    test('should match vaults page layout', async ({ page }) => {
      await page.goto('/app/vaults');
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(500);
      
      await expect(page).toHaveScreenshot('vaults-page.png', {
        fullPage: true,
        animations: 'disabled',
      });
    });

    test('should match vaults table header', async ({ page }) => {
      await page.goto('/app/vaults');
      await page.waitForLoadState('networkidle');
      
      const tableHeader = page.locator('thead, [role="rowgroup"]').first();
      if (await tableHeader.isVisible()) {
        await expect(tableHeader).toHaveScreenshot('vaults-table-header.png', {
          animations: 'disabled',
        });
      }
    });
  });

  test.describe('Account Page', () => {
    test('should match account page with mock data', async ({ page }) => {
      await page.goto('/app/account?mockConnected=true');
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(500);
      
      await expect(page).toHaveScreenshot('account-page.png', {
        fullPage: true,
        animations: 'disabled',
      });
    });

    test('should match deposit allocation chart', async ({ page }) => {
      await page.goto('/app/account?mockConnected=true');
      await page.waitForLoadState('networkidle');
      
      const allocationChart = page.locator('text=Deposit Allocation').locator('..').first();
      await expect(allocationChart).toHaveScreenshot('deposit-allocation-chart.png', {
        animations: 'disabled',
      });
    });

    test('should match savings progression chart', async ({ page }) => {
      await page.goto('/app/account?mockConnected=true');
      await page.waitForLoadState('networkidle');
      
      const progressionChart = page.locator('text=Savings Progression').locator('..').first();
      await expect(progressionChart).toHaveScreenshot('savings-progression-chart.png', {
        animations: 'disabled',
      });
    });

    test('should match transaction table', async ({ page }) => {
      await page.goto('/app/account?mockConnected=true');
      await page.waitForLoadState('networkidle');
      
      const transactionTable = page.locator('text=Past transactions').locator('..').first();
      await expect(transactionTable).toHaveScreenshot('transaction-table.png', {
        animations: 'disabled',
      });
    });
  });

  test.describe('Component States', () => {
    test('should match button hover state', async ({ page }) => {
      await page.goto('/app');
      await page.waitForLoadState('networkidle');
      
      const button = page.locator('button:has-text("Start Saving")');
      await button.hover();
      await page.waitForTimeout(200);
      
      await expect(button).toHaveScreenshot('button-hover.png', {
        animations: 'disabled',
      });
    });

    test('should match empty state placeholders', async ({ page }) => {
      await page.goto('/app/vaults');
      await page.waitForLoadState('networkidle');
      
      const emptyState = page.locator('text=/no vaults|empty|no data/i').first();
      if (await emptyState.isVisible()) {
        await expect(emptyState.locator('..')).toHaveScreenshot('empty-state.png', {
          animations: 'disabled',
        });
      }
    });
  });

  test.describe('Responsive Layouts', () => {
    test('should match mobile layout', async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 667 });
      await page.goto('/app');
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(500);
      
      await expect(page).toHaveScreenshot('mobile-dashboard.png', {
        fullPage: true,
        animations: 'disabled',
      });
    });

    test('should match tablet layout', async ({ page }) => {
      await page.setViewportSize({ width: 768, height: 1024 });
      await page.goto('/app');
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(500);
      
      await expect(page).toHaveScreenshot('tablet-dashboard.png', {
        fullPage: true,
        animations: 'disabled',
      });
    });

    test('should match desktop layout', async ({ page }) => {
      await page.setViewportSize({ width: 1920, height: 1080 });
      await page.goto('/app');
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(500);
      
      await expect(page).toHaveScreenshot('desktop-dashboard.png', {
        fullPage: true,
        animations: 'disabled',
      });
    });
  });

  test.describe('Dark Mode', () => {
    test('should match dark mode theme', async ({ page }) => {
      await page.goto('/app');
      
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(500);
      
      await expect(page).toHaveScreenshot('dark-mode-dashboard.png', {
        fullPage: true,
        animations: 'disabled',
      });
    });

    test('should match light mode theme', async ({ page }) => {
      await page.goto('/app');
      
      await page.emulateMedia({ colorScheme: 'light' });
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(500);
      
      await expect(page).toHaveScreenshot('light-mode-dashboard.png', {
        fullPage: true,
        animations: 'disabled',
      });
    });
  });

  test.describe('Critical User Flows', () => {
    test('should match wallet connection flow', async ({ page }) => {
      await page.goto('/app');
      await page.waitForLoadState('networkidle');
      
      const connectButton = page.locator('text=Connect wallet');
      if (await connectButton.isVisible()) {
        await connectButton.click();
        await page.waitForTimeout(300);
        
        const modal = page.locator('[role="dialog"], [class*="modal"]').first();
        if (await modal.isVisible()) {
          await expect(modal).toHaveScreenshot('wallet-connect-modal.png', {
            animations: 'disabled',
          });
        }
      }
    });

    test('should match filter interaction on account page', async ({ page }) => {
      await page.goto('/app/account?mockConnected=true');
      await page.waitForLoadState('networkidle');
      
      const usdcButton = page.locator('button:has-text("USDC")');
      if (await usdcButton.isVisible()) {
        await usdcButton.click();
        await page.waitForTimeout(300);
        
        const filteredTable = page.locator('text=Past transactions').locator('..').first();
        await expect(filteredTable).toHaveScreenshot('filtered-transactions.png', {
          animations: 'disabled',
        });
      }
    });
  });
});
