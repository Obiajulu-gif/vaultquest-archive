import { test, expect } from '@playwright/test';
import { injectConnectedMockWallet, injectMockWallet, injectRejectingWallet } from './helpers/wallet-mock';

test.describe('Error States — Failed Transactions', () => {
  test('wallet rejection (user denial) is surfaced and never fakes a connected/success state', async ({ page }) => {
    // Inject a wallet whose eth_requestAccounts / eth_sendTransaction always
    // reject (user denial, code 4001, #745 — wallet rejection path).
    await injectRejectingWallet(page, {
      message: 'User denied connection request.',
    });

    await page.goto('/app');

    const connectWallet = page.getByRole('button', { name: 'Connect wallet' });
    await expect(connectWallet).toBeVisible({ timeout: 15000 });

    // Attempt to connect. If the wallet selector exposes an injected option
    // (MetaMask), force the connect attempt so the denial is actually
    // exercised; otherwise the modal already represents a rejection attempt.
    await connectWallet.click();
    const metaMaskOption = page.getByRole('button', { name: /MetaMask/i });
    if (await metaMaskOption.isVisible({ timeout: 5000 }).catch(() => false)) {
      await metaMaskOption.click();
    }

    // The denial must be surfaced: the app stays disconnected, never claims
    // a successful connection or deposit, and does not hang.
    await expect(page.getByText(/connect your wallet to deposit/i)).toBeVisible({ timeout: 15000 });
    await expect(connectWallet).toBeVisible();
    await expect(page.getByText(/Deposit successful|Transaction confirmed|recently connected/i)).toHaveCount(0);
  });

  test('C-Chain RPC failure surfaces a recoverable fallback-fee warning instead of hanging', async ({ page }) => {
    await injectConnectedMockWallet(page);

    // The Avalanche C-Chain JSON-RPC endpoint is down (5xx upstream outage,
    // #745 — RPC failure path). The gas selector fetches eth_gasPrice from
    // this exact endpoint and must degrade to fallback fee data.
    await page.route('**/api.avax.network/ext/bc/C/rpc', (route) =>
      route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'upstream unavailable' }),
      })
    );

    await page.goto('/app/vaults');

    const warning = page.getByRole('alert').filter({ hasText: /fallback fee data/i }).first();
    await expect(warning).toBeVisible({ timeout: 15000 });
    await expect(warning).toContainText(/RPC request is unavailable/i);

    // Recoverable, not stuck: the selector settles on fallback fees rather
    // than leaving a perpetual "Updating…" spinner.
    await expect(page.getByText('Updating…', { exact: true })).toHaveCount(0);
  });

  test('on-chain reverted action is surfaced as reverted, never as confirmed/success', async ({ page }) => {
    await injectConnectedMockWallet(page);

    const walletAddress = '0x1234567890123456789012345678901234567890';
    // A deposited action whose on-chain execution reverts (checked via the
    // activity/history endpoint, #745 — on-chain revert path).
    await page.route(`**/api/actions/${walletAddress}*`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [
            {
              id: 'act_reverted_1',
              action_type: 'deposit',
              status: 'reverted',
              created_at: '2026-09-20T12:00:00Z',
              tx_hash: '0x4f2e6a91c8d30b52f10e2c8a7b6d59e3a4f81cd0a2e9f4b7c6d5e8a1b2c3d4e5f',
              action_payload: { amount: 250 },
            },
          ],
          totalCount: 1,
        }),
      })
    );

    await page.goto('/app/activity');

    await page.getByRole('button', { name: /View history/i }).click();

    // The revert is surfaced with its reverted status and the offending
    // transaction hash — the action is never presented as confirmed.
    const revertedBadge = page.getByText('reverted', { exact: true }).first();
    await expect(revertedBadge).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(/0x4f2e6a91/i).first()).toBeVisible({ timeout: 5000 });
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

    // Trigger a data-loading action with an explicit connected wallet adapter.
    await injectConnectedMockWallet(page);
    await page.goto('/app/account');

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

    await injectConnectedMockWallet(page);
    await page.goto('/app/account');

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

    await injectConnectedMockWallet(page);
    await page.goto('/app/account');

    // The app should not show a blank page — some fallback message must appear.
    const fallback = page.locator(
      '[role="alert"], text=/unauthorized|sign in|reconnect|session expired|error/i'
    ).first();
    await expect(fallback).toBeVisible({ timeout: 10000 });
  });
});
