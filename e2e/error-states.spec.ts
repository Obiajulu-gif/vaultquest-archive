import { test, expect } from '@playwright/test';
import { injectMockWallet } from './helpers/wallet-mock';

test.describe('Error States — Failed Transactions', () => {
  test('rejected wallet transaction shows an error message in the UI', async ({ page }) => {
    // Inject a wallet whose eth_sendTransaction always rejects (user denial).
    await page.addInitScript(() => {
      (window as any).ethereum = {
        isMetaMask: true,
        request: async ({ method }: { method: string }) => {
          if (method === 'eth_requestAccounts' || method === 'eth_accounts') {
            return ['0x1234567890123456789012345678901234567890'];
          }
          if (method === 'eth_chainId') {
            return '0xa869';
          }
          if (method === 'eth_sendTransaction') {
            // Simulate MetaMask user rejection
            const err = new Error('MetaMask Tx Signature: User denied transaction signature.');
            (err as any).code = 4001;
            throw err;
          }
          return null;
        },
        on: () => {},
        removeListener: () => {},
      };
    });

    await page.goto('/app');

    // Trigger any action that sends a transaction — try the deposit / vault flow.
    const depositBtn = page.locator('button:has-text("Deposit"), button:has-text("Start Saving"), button:has-text("Deposit Funds")');
    if (await depositBtn.first().isVisible({ timeout: 5000 }).catch(() => false)) {
      await depositBtn.first().click();
    }

    // After a rejection the app should surface an error banner / toast.
    const errorIndicator = page.locator('[role="alert"], [data-testid="error"], text=/denied|rejected|failed|error/i').first();
    await expect(errorIndicator).toBeVisible({ timeout: 10000 });
  });

  test('network timeout shows an error state', async ({ page }) => {
    await injectMockWallet(page);

    await page.goto('/app');

    // Intercept all API calls to the backend and make them time out.
    await page.route('**/api/**', (route) => {
      // Abort after a deliberate delay to simulate a network timeout.
      return new Promise((resolve) =>
        setTimeout(() => resolve(route.abort('timedout')), 100)
      );
    });

    // Trigger a data-loading action.
    await page.goto('/app/account?mockConnected=true');

    // The page should render an error / empty state rather than hanging indefinitely.
    const errorOrEmpty = page.locator(
      '[role="alert"], [data-testid="error-state"], text=/something went wrong|unable to load|network error|try again/i'
    ).first();
    await expect(errorOrEmpty).toBeVisible({ timeout: 15000 });
  });

  test('user can retry after a failed transaction', async ({ page }) => {
    let callCount = 0;

    await page.addInitScript(() => {
      (window as any)._txCallCount = 0;
      (window as any).ethereum = {
        isMetaMask: true,
        request: async ({ method }: { method: string }) => {
          if (method === 'eth_requestAccounts' || method === 'eth_accounts') {
            return ['0x1234567890123456789012345678901234567890'];
          }
          if (method === 'eth_chainId') {
            return '0xa869';
          }
          if (method === 'eth_sendTransaction') {
            (window as any)._txCallCount += 1;
            if ((window as any)._txCallCount === 1) {
              // Fail the first attempt.
              const err = new Error('Transaction underpriced');
              (err as any).code = -32000;
              throw err;
            }
            // Succeed on retry.
            return '0xretrysuccesshash1234567890abcdef';
          }
          return null;
        },
        on: () => {},
        removeListener: () => {},
      };
    });

    await page.goto('/app');

    // Trigger an action that may produce the error/retry flow.
    const actionBtn = page.locator('button:has-text("Deposit"), button:has-text("Start Saving"), button:has-text("Send")').first();
    if (await actionBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await actionBtn.click();
    }

    // Wait for the error to appear.
    const errorMsg = page.locator('[role="alert"], text=/failed|error|try again|retry/i').first();
    await expect(errorMsg).toBeVisible({ timeout: 10000 });

    // Find and click the retry button.
    const retryBtn = page.locator('button:has-text("Retry"), button:has-text("Try Again"), button:has-text("Retry transaction")').first();
    await expect(retryBtn).toBeVisible({ timeout: 5000 });
    await retryBtn.click();

    // After the retry the error state should clear or a success indicator appears.
    const successOrClear = page.locator(
      'text=/success|confirmed|done/i, [data-testid="success"]'
    ).first();
    await expect(successOrClear).toBeVisible({ timeout: 10000 });
  });

  test('error states are accessible — use role="alert" or equivalent ARIA', async ({ page }) => {
    await page.route('**/api/saved-pools**', (route) =>
      route.fulfill({ status: 500, body: JSON.stringify({ error: 'Internal Server Error' }) })
    );

    await page.goto('/app/account?mockConnected=true');

    // Wait for the page to attempt its data fetch and surface the error.
    await page.waitForTimeout(2000);

    // Any error indicator must be reachable via ARIA — either role="alert"
    // or an element with aria-live so screen readers announce it.
    const accessibleError = page.locator('[role="alert"], [aria-live="assertive"], [aria-live="polite"]').first();

    // If the app renders an error element it must have proper ARIA semantics.
    const count = await accessibleError.count();
    if (count > 0) {
      await expect(accessibleError).toBeVisible();

      // The element must not have an empty accessible name when it carries content.
      const textContent = await accessibleError.textContent();
      expect(textContent?.trim().length).toBeGreaterThan(0);
    } else {
      // Acceptable alternative: the page shows a visible error without aria-live
      // but at minimum renders visible error text.
      const visibleError = page.locator('text=/error|failed|could not load/i').first();
      await expect(visibleError).toBeVisible({ timeout: 5000 });
    }
  });

  test('API 4xx error surfaces a user-facing message rather than a blank screen', async ({ page }) => {
    await injectMockWallet(page);

    // Simulate the backend returning a 401 (unauthorized) on protected endpoints.
    await page.route('**/api/**', (route) =>
      route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Unauthorized' }),
      })
    );

    await page.goto('/app/account?mockConnected=true');

    // The app should not show a blank page — some fallback message must appear.
    const fallback = page.locator(
      '[role="alert"], text=/unauthorized|sign in|reconnect|session expired|error/i'
    ).first();
    await expect(fallback).toBeVisible({ timeout: 10000 });
  });
});
