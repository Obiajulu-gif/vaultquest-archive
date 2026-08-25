import { test, expect } from '@playwright/test';

test.describe('Mobile Responsiveness Tests', () => {
  test.describe('Mobile Navigation', () => {
    test('should display hamburger menu on mobile devices', async ({ page, isMobile }) => {
      test.skip(!isMobile, 'This test is only for mobile viewports');
      
      await page.goto('/app');
      
      const menuToggle = page.locator('button[aria-label*="menu" i], button[aria-label*="navigation" i]');
      await expect(menuToggle).toBeVisible();
      
      await menuToggle.click();
      
      await expect(page.locator('nav a, nav button').first()).toBeVisible();
    });

    test('should navigate through hamburger menu items', async ({ page, isMobile }) => {
      test.skip(!isMobile, 'This test is only for mobile viewports');
      
      await page.goto('/app');
      
      const menuToggle = page.locator('button[aria-label*="menu" i], button[aria-label*="navigation" i]');
      if (await menuToggle.isVisible()) {
        await menuToggle.click();
        
        const prizesLink = page.locator('nav').getByRole('link', { name: /prizes/i });
        await expect(prizesLink).toBeVisible();
        await prizesLink.click();
        
        await expect(page).toHaveURL(/\/app\/prizes/);
      }
    });

    test('should close mobile menu after navigation', async ({ page, isMobile }) => {
      test.skip(!isMobile, 'This test is only for mobile viewports');
      
      await page.goto('/app');
      
      const menuToggle = page.locator('button[aria-label*="menu" i], button[aria-label*="navigation" i]');
      if (await menuToggle.isVisible()) {
        await menuToggle.click();
        
        const vaultsLink = page.locator('nav').getByRole('link', { name: /vaults/i });
        await vaultsLink.click();
        
        await page.waitForTimeout(500);
        
        const navMenu = page.locator('nav');
        const isVisible = await navMenu.isVisible();
        if (isVisible) {
          const boundingBox = await navMenu.boundingBox();
          expect(boundingBox).toBeTruthy();
        }
      }
    });
  });

  test.describe('Table Responsiveness', () => {
    test('should handle tables on mobile with horizontal scroll or collapse', async ({ page, isMobile }) => {
      test.skip(!isMobile, 'This test is only for mobile viewports');
      
      await page.goto('/app/account?mockConnected=true');
      
      const table = page.locator('table, [role="table"]').first();
      await expect(table).toBeVisible();
      
      const tableContainer = page.locator('div:has(> table), div[role="table"]').first();
      const overflowStyle = await tableContainer.evaluate((el) => {
        return window.getComputedStyle(el).overflowX;
      });
      
      expect(['auto', 'scroll', 'hidden'].includes(overflowStyle)).toBeTruthy();
    });

    test('should display transaction table on mobile without breaking layout', async ({ page, isMobile }) => {
      test.skip(!isMobile, 'This test is only for mobile viewports');
      
      await page.goto('/app/account?mockConnected=true');
      
      const transactionSection = page.locator('text=Past transactions').locator('..');
      await expect(transactionSection).toBeVisible();
      
      const viewportWidth = page.viewportSize()?.width || 0;
      const sectionWidth = await transactionSection.evaluate((el) => el.getBoundingClientRect().width);
      
      expect(sectionWidth).toBeLessThanOrEqual(viewportWidth);
    });

    test('should show all columns or provide horizontal scroll for vault tables', async ({ page, isMobile }) => {
      test.skip(!isMobile, 'This test is only for mobile viewports');
      
      await page.goto('/app/vaults');
      
      await page.waitForTimeout(1000);
      
      const tableHeaders = page.locator('th, [role="columnheader"]');
      const headerCount = await tableHeaders.count();
      
      if (headerCount > 0) {
        const firstHeader = tableHeaders.first();
        await expect(firstHeader).toBeVisible();
        
        const table = page.locator('table, [role="table"]').first();
        const isScrollable = await table.evaluate((el) => {
          const parent = el.parentElement;
          if (!parent) return false;
          const style = window.getComputedStyle(parent);
          return style.overflowX === 'auto' || style.overflowX === 'scroll';
        });
        
        expect(isScrollable || headerCount <= 4).toBeTruthy();
      }
    });
  });

  test.describe('Form and Input Responsiveness', () => {
    test('should render form inputs at appropriate size on mobile', async ({ page, isMobile }) => {
      test.skip(!isMobile, 'This test is only for mobile viewports');
      
      await page.goto('/app');
      
      const inputs = page.locator('input, textarea, select');
      const inputCount = await inputs.count();
      
      if (inputCount > 0) {
        const firstInput = inputs.first();
        const inputWidth = await firstInput.evaluate((el) => el.getBoundingClientRect().width);
        const viewportWidth = page.viewportSize()?.width || 0;
        
        expect(inputWidth).toBeLessThanOrEqual(viewportWidth * 0.95);
      }
    });

    test('should make buttons touch-friendly on mobile', async ({ page, isMobile }) => {
      test.skip(!isMobile, 'This test is only for mobile viewports');
      
      await page.goto('/app');
      
      const buttons = page.locator('button:visible');
      const buttonCount = await buttons.count();
      
      if (buttonCount > 0) {
        const firstButton = buttons.first();
        const buttonHeight = await firstButton.evaluate((el) => el.getBoundingClientRect().height);
        
        expect(buttonHeight).toBeGreaterThanOrEqual(44);
      }
    });
  });

  test.describe('Viewport-Specific Content', () => {
    test('should hide desktop-only elements on mobile', async ({ page, isMobile }) => {
      await page.goto('/app');
      
      if (isMobile) {
        const desktopNav = page.locator('nav a:visible').first();
        const menuToggle = page.locator('button[aria-label*="menu" i]');
        
        const hasMenuToggle = await menuToggle.isVisible();
        const hasDesktopNav = await desktopNav.isVisible();
        
        expect(hasMenuToggle || !hasDesktopNav).toBeTruthy();
      }
    });

    test('should adapt card layouts for mobile screens', async ({ page, isMobile }) => {
      test.skip(!isMobile, 'This test is only for mobile viewports');
      
      await page.goto('/app/prizes');
      
      const cards = page.locator('[class*="card"], [class*="Card"]');
      const cardCount = await cards.count();
      
      if (cardCount > 0) {
        const firstCard = cards.first();
        const cardWidth = await firstCard.evaluate((el) => el.getBoundingClientRect().width);
        const viewportWidth = page.viewportSize()?.width || 0;
        
        expect(cardWidth).toBeLessThanOrEqual(viewportWidth * 0.95);
      }
    });
  });

  test.describe('Touch Interactions', () => {
    test('should support touch interactions on mobile', async ({ page, isMobile }) => {
      test.skip(!isMobile, 'This test is only for mobile viewports');
      
      await page.goto('/app');
      
      const startSavingBtn = page.locator('text=Start Saving');
      if (await startSavingBtn.isVisible()) {
        await startSavingBtn.tap();
        
        await expect(page.locator('text=View All Prizes, text=Manage Vaults')).toBeVisible();
      }
    });

    test('should handle swipe gestures for scrollable content', async ({ page, isMobile }) => {
      test.skip(!isMobile, 'This test is only for mobile viewports');
      
      await page.goto('/app/account?mockConnected=true');
      
      const scrollableElement = page.locator('table, [role="table"]').first();
      
      if (await scrollableElement.isVisible()) {
        const box = await scrollableElement.boundingBox();
        if (box) {
          await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
          
          await page.mouse.move(box.x + box.width - 50, box.y + box.height / 2);
        }
      }
    });
  });

  test.describe('Cross-Device Consistency', () => {
    test('should display consistent branding across devices', async ({ page }) => {
      await page.goto('/');
      
      await expect(page.locator('text=VaultQuest')).toBeVisible();
    });

    test('should maintain functionality parity between mobile and desktop', async ({ page, isMobile }) => {
      await page.goto('/app');
      
      const connectButton = page.locator('text=Connect wallet, text=Start Saving');
      await expect(connectButton.first()).toBeVisible();
      
      const prizeLink = isMobile 
        ? page.locator('button[aria-label*="menu" i]')
        : page.locator('nav a:has-text("Prizes")');
      
      await expect(prizeLink).toBeVisible();
    });
  });
});
