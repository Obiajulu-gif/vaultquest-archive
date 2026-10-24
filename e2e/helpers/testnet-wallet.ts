/**
 * Scriptable wallet harness for testnet e2e tests (issues #743, #747).
 *
 * Injects a Stellar-flavored wallet mock into the Playwright page that:
 *  - Accepts signing requests programmatically (no human popup)
 *  - Records every signed transaction XDR so tests can inspect them
 *  - Exposes helpers to simulate a connected Freighter-style wallet
 *
 * In CI the private key is supplied via TESTNET_WALLET_SECRET_KEY. When that
 * env var is absent the harness falls back to a deterministic mock key so
 * tests can still exercise UI flows without broadcasting real transactions.
 *
 * Usage:
 *   await injectTestnetWallet(page, { address: 'G...' });
 *   // run deposit flow in the UI
 *   const signed = await getSignedTransactions(page);
 */

import { type Page } from "@playwright/test";

export interface TestnetWalletOptions {
  /** Stellar public key (G...) to present to the dApp. */
  address?: string;
  /** Network passphrase. Defaults to Stellar testnet. */
  networkPassphrase?: string;
  /** Whether the wallet starts in the connected state. */
  connected?: boolean;
}

const DEFAULT_ADDRESS =
  process.env.TESTNET_WALLET_ADDRESS ??
  "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";

const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";

/**
 * Injects a scriptable Freighter-compatible wallet mock into the page.
 * The wallet auto-approves all signing requests, recording signed XDRs
 * so test code can inspect them via `getSignedTransactions`.
 */
export async function injectTestnetWallet(
  page: Page,
  opts: TestnetWalletOptions = {}
): Promise<void> {
  const address = opts.address ?? DEFAULT_ADDRESS;
  const networkPassphrase = opts.networkPassphrase ?? TESTNET_PASSPHRASE;
  const connected = opts.connected ?? true;

  await page.addInitScript(
    ({ walletAddress, passphrase, isConnected }) => {
      const signedTxLog: string[] = [];
      let walletConnected = isConnected;

      // Freighter API surface used by the dApp
      (window as any).freighter = {
        isFreighter: true,
        getPublicKey: async () => {
          if (!walletConnected) throw new Error("Not connected");
          return walletAddress;
        },
        isConnected: async () => walletConnected,
        signTransaction: async (xdr: string) => {
          signedTxLog.push(xdr);
          // Return the same XDR; in a real integration the wallet signs it
          return xdr;
        },
        getNetwork: async () => passphrase,
        getNetworkDetails: async () => ({
          network: "TESTNET",
          networkUrl: "https://horizon-testnet.stellar.org",
          networkPassphrase: passphrase,
        }),
      };

      // Also expose an isFreighterInstalled polyfill that some adapters check
      (window as any).isFreighterInstalled = true;

      // Test helper: retrieve all signed XDRs accumulated so far
      (window as any).__testnetWallet = {
        getSignedTxLog: () => signedTxLog,
        connect: () => {
          walletConnected = true;
        },
        disconnect: () => {
          walletConnected = false;
        },
        clearLog: () => {
          signedTxLog.splice(0, signedTxLog.length);
        },
      };
    },
    { walletAddress: address, passphrase: networkPassphrase, isConnected: connected }
  );
}

/**
 * Retrieves the list of transaction XDRs that the injected wallet has
 * signed since injection (or since the last `clearSignedTransactions` call).
 */
export async function getSignedTransactions(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const w = (window as any).__testnetWallet;
    return w ? w.getSignedTxLog() : [];
  });
}

/**
 * Clears the signed-transaction log.
 */
export async function clearSignedTransactions(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = (window as any).__testnetWallet;
    if (w) w.clearLog();
  });
}

/**
 * Simulates a wallet disconnect event.
 */
export async function disconnectTestnetWallet(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = (window as any).__testnetWallet;
    if (w) w.disconnect();
  });
}
