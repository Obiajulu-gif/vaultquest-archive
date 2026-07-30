import { Page } from '@playwright/test';

/**
 * Injects a mock Ethereum wallet into the page for testing.
 * @param page - Playwright page object
 * @param address - Mock wallet address (default: 0x1234567890123456789012345678901234567890)
 */
export async function injectMockWallet(page: Page, address: string = '0x1234567890123456789012345678901234567890') {
  await page.addInitScript((mockAddress) => {
    let isConnected = false;
    const listeners: Record<string, Function[]> = {};

    (window as any).ethereum = {
      isMetaMask: true,
      request: async ({ method, params }: { method: string; params?: any[] }) => {
        if (method === 'eth_requestAccounts') {
          isConnected = true;
          return [mockAddress];
        }
        if (method === 'eth_accounts') {
          return isConnected ? [mockAddress] : [];
        }
        if (method === 'eth_chainId') {
          return '0xa869'; // Fuji testnet
        }
        if (method === 'eth_sendTransaction') {
          return '0xmocktxhash1234567890abcdef1234567890abcdef1234567890abcdef123456';
        }
        if (method === 'wallet_switchEthereumChain') {
          return null; // success
        }
        return null;
      },
      on: (event: string, callback: Function) => {
        if (!listeners[event]) {
          listeners[event] = [];
        }
        listeners[event].push(callback);
      },
      removeListener: (event: string, callback: Function) => {
        if (listeners[event]) {
          listeners[event] = listeners[event].filter(cb => cb !== callback);
        }
      },
      // Expose a method to simulate disconnection for testing
      _simulateDisconnect: () => {
        isConnected = false;
        if (listeners['accountsChanged']) {
          listeners['accountsChanged'].forEach(cb => cb([]));
        }
        if (listeners['disconnect']) {
          listeners['disconnect'].forEach(cb => cb());
        }
      },
    };
  }, address);
}

/**
 * Simulates wallet disconnection by triggering wallet events.
 * Call this after injectMockWallet to simulate a disconnect event.
 * @param page - Playwright page object
 */
export async function simulateWalletDisconnect(page: Page) {
  await page.evaluate(() => {
    if ((window as any).ethereum && (window as any).ethereum._simulateDisconnect) {
      (window as any).ethereum._simulateDisconnect();
    }
  });
}
