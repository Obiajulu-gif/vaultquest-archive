import { test, expect, type Page } from '@playwright/test';
import { injectMockWallet } from './helpers/wallet-mock';

test.describe('Wallet Disconnect UI Updates', () => {
  /**
   * Helper function to connect the wallet using the mock wallet
   */
  async function connectWallet(page: Page) {
    // Inject mock wallet before navigation
    await injectMockWallet(page);
    
    const connectBtn = page.locator('text=Connect wallet').first();
    if (await connectBtn.isVisible({ timeout: 5000 })) {
      await connectBtn.click();
      
      // Wait for connection to complete
      await page.waitForTimeout(500);
    }
  }

  /**
   * Helper function to disconnect the wallet by clicking the disconnect button
   */
  async function disconnectWallet(page: Page) {
    // Look for the disconnect button (X icon button in header)
    const disconnectBtn = page.locator('button[aria-label*="Disconnect wallet"]');
    
    if (await disconnectBtn.isVisible({ timeout: 5000 })) {
      await disconnectBtn.click();
      // Wait for disconnect to complete
      await page.waitForTimeout(500);
    }
  }

  test('Dashboard shows connect wallet button after disconnect', async ({ page }) => {
    await page.goto('/app');
    
    // Connect wallet first
    await connectWallet(page);
    
    // Verify connected state - should show connected UI buttons
    await expect(page.locator('text=View All Prizes')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=Manage Vaults')).toBeVisible();
    
    // Disconnect wallet
    await disconnectWallet(page);
    
    // Verify disconnected state - should show "Start Saving" or "Connect wallet" button
    const startSavingBtn = page.locator('text=Start Saving');
    const connectWalletBtn = page.locator('text=Connect wallet');
    
    await expect(
      startSavingBtn.or(connectWalletBtn).first()
    ).toBeVisible({ timeout: 10000 });
    
    // Connected UI buttons should be hidden or not visible
    await expect(page.locator('text=View All Prizes')).not.toBeVisible();
    await expect(page.locator('text=Manage Vaults')).not.toBeVisible();
  });

  test('Account page shows connect prompt after disconnect', async ({ page }) => {
    await page.goto('/app/account?mockConnected=true');
    
    // Initially should show account content
    await expect(page.locator('text=Your profile')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=Deposit Allocation')).toBeVisible();
    
    // Disconnect wallet by navigating to account page without mock parameter
    await page.goto('/app/account');
    
    // Should show wallet connection prompt
    await expect(page.locator('text=Connect wallet to view your account')).toBeVisible({ timeout: 10000 });
    
    // Account content should not be visible
    await expect(page.locator('text=Deposit Allocation')).not.toBeVisible();
  });

  test('Activity page shows connect prompt after disconnect', async ({ page }) => {
    await page.goto('/app/activity');
    
    // Should show wallet connection prompt
    await expect(page.locator('text=Connect your wallet to view your account activity')).toBeVisible({ timeout: 10000 });
    
    // Connect wallet button should be visible
    const connectBtn = page.locator('button:has-text("Connect wallet")');
    await expect(connectBtn).toBeVisible();
  });

  test('Vault detail page shows connect prompt when wallet disconnected', async ({ page }) => {
    // Navigate to a vault detail page (using a placeholder ID)
    await page.goto('/app/vaults/1');
    
    // Wait for page to load
    await page.waitForLoadState('networkidle');
    
    // Should show wallet connection prompt
    const connectPrompt = page.locator('text=Connect Wallet to Begin');
    const connectBtn = page.locator('button:has-text("Connect Wallet")');
    
    // Either the prompt or button should be visible (depending on vault state)
    await expect(
      connectPrompt.or(connectBtn).first()
    ).toBeVisible({ timeout: 10000 });
  });

  test('Header wallet status updates on disconnect', async ({ page }) => {
    await page.goto('/app');
    
    // Connect wallet first
    await connectWallet(page);
    
    // Wait for header to update with connected state
    await page.waitForTimeout(1000);
    
    // Disconnect wallet
    await disconnectWallet(page);
    
    // Verify header shows "Connect Wallet" button after disconnect
    const headerConnectBtn = page.locator('button:has-text("Connect Wallet")').first();
    await expect(headerConnectBtn).toBeVisible({ timeout: 10000 });
  });

  test('Multiple navigation after disconnect maintains disconnected state', async ({ page }) => {
    await page.goto('/app');
    
    // Connect wallet first
    await connectWallet(page);
    await expect(page.locator('text=View All Prizes')).toBeVisible({ timeout: 10000 });
    
    // Disconnect wallet
    await disconnectWallet(page);
    
    // Navigate to different pages and verify disconnected state persists
    await page.goto('/app/prizes');
    await expect(page.locator('text=Connect wallet').or(page.locator('text=Start Saving'))).toBeVisible();
    
    await page.goto('/app/vaults');
    await expect(page.locator('text=Connect wallet').or(page.locator('text=Start Saving'))).toBeVisible();
    
    await page.goto('/app/activity');
    await expect(page.locator('text=Connect wallet')).toBeVisible();
  });

  test('Reconnect guidance appears after disconnect', async ({ page }) => {
    await page.goto('/app/account?mockConnected=true');
    
    // Wait for account page to load with connected state
    await expect(page.locator('text=Your profile')).toBeVisible({ timeout: 10000 });
    
    // Simulate disconnect by navigating without mock parameter
    await page.goto('/app/account');
    
    // Wait for the reconnect guidance to appear
    await page.waitForTimeout(1000);
    
    // Look for reconnect guidance or connect wallet button
    const reconnectBtn = page.locator('button:has-text("Reconnect Wallet")');
    const connectBtn = page.locator('button:has-text("Connect wallet")');
    
    await expect(
      reconnectBtn.or(connectBtn).first()
    ).toBeVisible({ timeout: 10000 });
  });

  test('Wallet address is removed from UI after disconnect', async ({ page }) => {
    await page.goto('/app');
    
    // Connect wallet first
    await connectWallet(page);
    
    // Wait for connection
    await page.waitForTimeout(1000);
    
    // Disconnect wallet
    await disconnectWallet(page);
    
    // Verify no wallet address is shown in the header
    // Wallet addresses typically start with "0x" followed by hex characters
    const walletAddressPattern = /0x[a-fA-F0-9]{8,}/;
    const pageContent = await page.content();
    
    // The page should either not contain wallet address or it should be hidden
    const headerText = await page.locator('header').textContent();
    
    if (headerText && walletAddressPattern.test(headerText)) {
      // If address is still in DOM, ensure it's not visible
      const addressElements = page.locator(`text=/0x[a-fA-F0-9]{8,}/`);
      const count = await addressElements.count();
      
      for (let i = 0; i < count; i++) {
        await expect(addressElements.nth(i)).not.toBeVisible();
      }
    }
  });

  test('Balance information is removed after disconnect', async ({ page }) => {
    await page.goto('/app/account?mockConnected=true');
    
    // Wait for account page with balances to load
    await expect(page.locator('text=Your profile')).toBeVisible({ timeout: 10000 });
    
    // Navigate away (simulating disconnect)
    await page.goto('/app/account');
    
    // Verify balance-related content is not visible
    await expect(page.locator('text=Deposit Allocation')).not.toBeVisible();
    await expect(page.locator('text=Savings Progression')).not.toBeVisible();
    await expect(page.locator('text=Past transactions')).not.toBeVisible();
  });

  test('Connect wallet button is clickable after disconnect', async ({ page }) => {
    await page.goto('/app');
    
    // Connect wallet first
    await connectWallet(page);
    await expect(page.locator('text=View All Prizes')).toBeVisible({ timeout: 10000 });
    
    // Disconnect wallet
    await disconnectWallet(page);
    
    // Find and verify connect wallet button is enabled
    const connectBtn = page.locator('button:has-text("Connect wallet")').first();
    await expect(connectBtn).toBeVisible({ timeout: 10000 });
    await expect(connectBtn).toBeEnabled();
    
    // Click the button to ensure it's interactive
    await connectBtn.click();
    
    // Some modal or action should occur (depending on implementation)
    await page.waitForTimeout(500);
  });
});
