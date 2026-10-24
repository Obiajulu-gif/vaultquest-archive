import { connectedPublicKey, connectedNetwork, isNetworkMismatch, multisigStatus, isWalletInitialized } from "./store.js";
import { checkMultisigStatus, MULTISIG_UNSUPPORTED_MESSAGE } from "./multisig.js";
import {
  startSessionLivenessWatcher,
  stopSessionLivenessWatcher,
  WalletSessionLostError,
} from "./sessionLiveness.js";
import { kit } from "./kit.js";
import { getFrontendEnv } from "./env.js";
import { resolveHorizonUrl } from "./horizonConfig.js";
import type { ISupportedWallet } from "@creit.tech/stellar-wallets-kit";
import {
  EXPECTED_NETWORK,
  STELLAR_NETWORKS,
  type NetworkType,
  type WalletType,
  normalizeStellarNetwork,
} from "../lib/wallets.js";
import { HorizonPool, resolveHorizonNodes } from "./horizonPool.js";
import { vaultQueryClient } from "../vault/data/queryClient.js";
import { HorizonPool } from "./horizonPool.js";
import {
  providerRegistry,
  connectWithProvider,
  disconnectProvider,
  registerDefaultProviders,
  type WalletProvider,
  type ProviderConnectionResult,
  type WalletError,
  type WalletErrorCode,
} from "./provider.js";

export interface WalletConnectionResult {
  address: string;
  publicKey: string;
  network: NetworkType;
  provider: WalletType;
  kitWalletId: string;
}

export interface StoredWalletConnection {
  publicKey: string;
  provider: WalletType;
}

const connectionState: {
  publicKey: string | undefined;
  provider: WalletType | undefined;
} = {
  publicKey: undefined,
  provider: undefined,
};

const walletKitIds: Record<WalletType, string> = {
  freighter: "freighter",
  albedo: "albedo",
  xbull: "xbull",
  rabet: "rabet",
  ledger: "LEDGER",
};

const appWalletTypesByKitId: Record<string, WalletType> = {
  freighter: "freighter",
  albedo: "albedo",
  xbull: "xbull",
  rabet: "rabet",
  LEDGER: "ledger",
  ledger: "ledger",
};

/**
 * Lazily-initialised Horizon connection pool (#rate-limits). Balances on-chain
 * read traffic across the configured public/private nodes, routes to the
 * healthiest endpoint, and retries rate-limited requests with backoff.
 */
let _horizonPool: HorizonPool | undefined;

function getHorizonPool(): HorizonPool {
  if (!_horizonPool) {
    _horizonPool = new HorizonPool({ nodes: resolveHorizonNodes() });
  }
  return _horizonPool;
}

/** Test/SSR seam to inject or reset the pool. */
function setHorizonPool(pool: HorizonPool | undefined): void {
  _horizonPool = pool;
}

function loadedPublicKey(): string | undefined {
  return connectionState.publicKey;
}

function loadedProvider(): WalletType | undefined {
  return connectionState.provider;
}

function toKitWalletId(provider: string): string {
  return walletKitIds[provider as WalletType] || provider;
}

function toAppWalletType(provider: string): WalletType | undefined {
  return appWalletTypesByKitId[provider];
}

function setConnection(publicKey: string, provider: string): void {
  const appProvider = toAppWalletType(provider);

  if (!appProvider) {
    throw new Error(`Unsupported Stellar wallet provider: ${provider}`);
  }

  const previousPublicKey = connectionState.publicKey;

  connectionState.publicKey = publicKey;
  connectionState.provider = appProvider;

  if (previousPublicKey && previousPublicKey !== publicKey) {
    resetUserScopedState();
  }

  if (typeof localStorage !== "undefined") {
    localStorage.setItem("publicKey", publicKey);
    localStorage.setItem("walletProvider", appProvider);
  }

  connectedPublicKey.set(publicKey);
  isWalletInitialized.set(true);

  // Set the network in the background and check for mismatch
  getConnectedNetwork().then((net) => {
    connectedNetwork.set(net);
    isNetworkMismatch.set(net !== EXPECTED_NETWORK);
  }).catch(() => {
    connectedNetwork.set(EXPECTED_NETWORK);
    isNetworkMismatch.set(false);
  });

  startNetworkWatcher();

  // #733: start watching this session's liveness (heartbeat + focus/
  // visibility re-checks) so a dead/switched wallet is caught proactively
  // rather than surfacing as a confusing error mid-signing.
  startSessionLivenessWatcher(appProvider, publicKey);

  // #736: detect multisig/thresholded accounts up front, in the background,
  // so a "not yet supported" state can be shown before the user attempts
  // an action rather than surfacing as a confusing low-level signing error.
  checkMultisigStatus(getHorizonPool(), publicKey)
    .then((status) => multisigStatus.set(status))
    .catch(() => multisigStatus.set(null));
}

function disconnect(): void {
  connectionState.publicKey = undefined;
  connectionState.provider = undefined;

  if (typeof localStorage !== "undefined") {
    localStorage.removeItem("publicKey");
    localStorage.removeItem("walletProvider");
  }

  resetUserScopedState();

  connectedPublicKey.set("");
  connectedNetwork.set(null);
  multisigStatus.set(null);
  isNetworkMismatch.set(false);

  stopNetworkWatcher();
  stopSessionLivenessWatcher();
}

export async function checkAndNotifyFunding(): Promise<void> {
  // The product flow no longer opens the wallet funding modal automatically.
  return;
}

function resetUserScopedState(): void {
  vaultQueryClient.clear();
  if (typeof localStorage !== "undefined") {
    localStorage.removeItem("vaultquest_pending_tx_state");
  }
}

async function getWalletAvailability(provider: WalletType): Promise<{
  wallet: ISupportedWallet | undefined;
  isAvailable: boolean;
}> {
  if (typeof window === "undefined") {
    return { wallet: undefined, isAvailable: false };
  }

  const kitWalletId = toKitWalletId(provider);
  const supportedWallets = await kit.getSupportedWallets();
  const wallet = supportedWallets.find((option) => option.id === kitWalletId);

  return {
    wallet,
    isAvailable: Boolean(wallet?.isAvailable || wallet?.isPlatformWrapper),
  };
}

async function connectWallet(provider: WalletType): Promise<WalletConnectionResult> {
  if (typeof window === "undefined") {
    throw new Error("Wallet connection is only available in the browser");
  }

  const kitWalletId = toKitWalletId(provider);
  const { isAvailable } = await getWalletAvailability(provider);

  if (!isAvailable && provider !== "albedo") {
    throw new Error("Wallet not installed or unavailable");
  }

  kit.setWallet(kitWalletId);

  const { address } = await kit.getAddress(
    provider === "freighter" ? { skipRequestAccess: false } : undefined,
  );

  const network = await getConnectedNetwork();

  setConnection(address, provider);

  return {
    address,
    publicKey: address,
    network,
    provider,
    kitWalletId,
  };
}

async function disconnectWallet(provider?: WalletType): Promise<void> {
  try {
    if (provider && typeof window !== "undefined") {
      kit.setWallet(toKitWalletId(provider));
      await kit.disconnect();
    }
  } finally {
    disconnect();
  }
}

/**
 * Recovery path for a session the liveness watcher/preflight marked
 * `"lost"` (#733). Re-runs the normal `connectWallet` flow for the same
 * provider the session was on — deliberately not `disconnect()` first,
 * since `setConnection` only clears persisted/query-cache state
 * (`resetUserScopedState`, which includes `usePersistedTxState`'s
 * `vaultquest_pending_tx_state` record) when the reconnected public key
 * actually differs from the previous one. Reconnecting to the *same*
 * account therefore resumes any in-progress action for free; reconnecting
 * to a *different* one correctly drops it, same as switching accounts
 * normally does.
 *
 * Throws if there is no known prior provider to reconnect (e.g. called
 * after a hard `disconnect()`).
 */
async function reconnectSession(): Promise<WalletConnectionResult> {
  const provider = loadedProvider();
  if (!provider) {
    throw new WalletSessionLostError("No wallet session to reconnect — connect a wallet first.");
  }
  return connectWallet(provider);
}

async function getConnectedNetwork(): Promise<NetworkType> {
  try {
    const networkResult = await kit.getNetwork();
    return (
      normalizeStellarNetwork(networkResult?.network) ||
      normalizeStellarNetwork(networkResult?.networkPassphrase) ||
      EXPECTED_NETWORK
    );
  } catch {
    return EXPECTED_NETWORK;
  }
}

// ─── Pre-flight network check (#735) ───────────────────────────────────────
//
// `connectedNetwork`/`isNetworkMismatch` are only refreshed on connect/init
// (see setConnection/initializeConnection above) and by the watcher started
// below — neither is guaranteed to have run in the seconds immediately
// before a specific signing request. A funds-moving action re-checks fresh
// every time via `assertNetworkMatchesBeforeSigning`, rather than trusting
// a store value that could be stale by design (background-updated) or by
// timing (a switch that happened between page load and this click).

export class NetworkMismatchError extends Error {
  readonly kind = "network_mismatch";

  constructor(
    public readonly connected: NetworkType | null,
    public readonly expected: NetworkType,
  ) {
    super(
      connected
        ? `Wallet is connected to ${connected}, but this action requires ${expected}. Switch your wallet's network and try again.`
        : `Could not verify the wallet's network before signing. Switch your wallet to ${expected} and try again.`,
    );
    this.name = "NetworkMismatchError";
  }
}

/**
 * Re-queries the wallet's *current* network directly (bypassing the
 * error-swallowing `getConnectedNetwork` above) and throws
 * `NetworkMismatchError` on any mismatch — including when the network
 * can't be determined at all, since silently proceeding on an unknown
 * network is exactly the failure mode this check exists to prevent.
 *
 * Also updates `connectedNetwork`/`isNetworkMismatch` so the
 * `NetworkDiagnostics` banner reflects the same fresh read.
 */
export async function assertNetworkMatchesBeforeSigning(): Promise<void> {
  let network: NetworkType | null = null;
  try {
    const result = await kit.getNetwork();
    network =
      normalizeStellarNetwork(result?.network) ||
      normalizeStellarNetwork(result?.networkPassphrase) ||
      null;
  } catch {
    network = null;
  }

  connectedNetwork.set(network);
  const mismatch = network !== EXPECTED_NETWORK;
  isNetworkMismatch.set(mismatch);

  if (mismatch) {
    throw new NetworkMismatchError(network, EXPECTED_NETWORK);
  }
}

// ─── Multisig block (#736) ──────────────────────────────────────────────────

export class MultisigUnsupportedError extends Error {
  readonly kind = "multisig_unsupported";
  constructor() {
    super(MULTISIG_UNSUPPORTED_MESSAGE);
    this.name = "MultisigUnsupportedError";
  }
}

/**
 * Blocks signing when the connected account was detected as multisig —
 * detection itself runs once in the background on connect (`setConnection`/
 * `initializeConnection` above), and this reads that cached result rather
 * than re-querying Horizon on every signing attempt (unlike the network
 * check, an account's signer configuration changing mid-session is rare
 * enough not to warrant a live re-check on the hot path).
 */
export function assertNotMultisigBeforeSigning(): void {
  if (multisigStatus.get()?.isMultisig) {
    throw new MultisigUnsupportedError();
  }
}

// ─── Passive mid-session network-change watcher (#735) ────────────────────
//
// No wallet provider integrated here exposes a universal "network changed"
// event through the kit's shared interface (Freighter has one, most others
// don't), so this polls the same live check used above at a low frequency
// — proactive enough to catch a mid-session switch well before the user
// attempts a transaction, cheap enough not to matter at this interval.

const NETWORK_WATCH_INTERVAL_MS = 15_000;
let networkWatchTimer: ReturnType<typeof setInterval> | undefined;

function startNetworkWatcher(): void {
  if (networkWatchTimer || typeof window === "undefined") return;
  networkWatchTimer = setInterval(() => {
    if (!connectionState.publicKey) return;
    getConnectedNetwork()
      .then((net) => {
        connectedNetwork.set(net);
        isNetworkMismatch.set(net !== EXPECTED_NETWORK);
      })
      .catch(() => {
        // Transient read failure — leave the store as-is rather than
        // flip-flopping the mismatch banner on a blip.
      });
  }, NETWORK_WATCH_INTERVAL_MS);
}

function stopNetworkWatcher(): void {
  if (networkWatchTimer) {
    clearInterval(networkWatchTimer);
    networkWatchTimer = undefined;
  }
}

function initializeConnection(): StoredWalletConnection | null {
  if (typeof localStorage === "undefined") return null;

  const storedPublicKey = localStorage.getItem("publicKey");
  const storedProvider = localStorage.getItem("walletProvider");
  const appProvider = storedProvider ? toAppWalletType(storedProvider) : undefined;

  if (storedPublicKey && appProvider) {
    connectionState.publicKey = storedPublicKey;
    connectionState.provider = appProvider;
    connectedPublicKey.set(storedPublicKey);

    // Verify network and mismatch in the background
    getConnectedNetwork().then((net) => {
      connectedNetwork.set(net);
      isNetworkMismatch.set(net !== EXPECTED_NETWORK);
    }).catch(() => {
      connectedNetwork.set(EXPECTED_NETWORK);
      isNetworkMismatch.set(false);
    });

    startNetworkWatcher();
    startSessionLivenessWatcher(appProvider, storedPublicKey);

    checkMultisigStatus(getHorizonPool(), storedPublicKey)
      .then((status) => multisigStatus.set(status))
      .catch(() => multisigStatus.set(null));

    return {
      publicKey: storedPublicKey,
      provider: appProvider,
    };
  }

  isWalletInitialized.set(true);
  return null;
}

/**
 * Check if the connected wallet exists and has funds.
 * Returns { exists: boolean, balance: number }.
 */
async function getWalletHealth(): Promise<{
  exists: boolean;
  balances: { XLM: number; USDC: number };
}> {
  const publicKey = loadedPublicKey();
  const env = getFrontendEnv();
  const horizonUrl = resolveHorizonUrl(
    env.NEXT_PUBLIC_HORIZON_URL,
    STELLAR_NETWORKS[EXPECTED_NETWORK].horizonUrl,
  );

  if (!publicKey) return { exists: false, balances: { XLM: 0, USDC: 0 } };

  try {
    // Route through the connection pool: distributes the lookup across the
    // configured Horizon nodes and retries on rate limits / node failures.
    // This balance feeds funding/deposit decisions, so it's a critical read
    // (#626): the pool won't give up just because every node is cooling
    // down the way it would for a best-effort UI refresh.
    const resp = await getHorizonPool().request(`/accounts/${publicKey}`, {
      headers: { Accept: "application/json" },
      criticality: "critical",
    });

    if (resp.status === 404) {
      return { exists: false, balances: { XLM: 0, USDC: 0 } };
    }

    if (!resp.ok) {
      return { exists: false, balances: { XLM: 0, USDC: 0 } };
    }

    const json = await resp.json();

    // Fetch XLM (native)
    const native = (json.balances || []).find(
      (b: any) => b.asset_type === "native",
    );
    const xlmBalance = native ? Number(native.balance) : 0;

    // Fetch USDC (Testnet only)
    const usdcIssuer = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"; // Testnet

    const usdc = (json.balances || []).find(
      (b: any) => b.asset_code === "USDC" && b.issuer === usdcIssuer,
    );
    const usdcBalance = usdc ? Number(usdc.balance) : 0;

    return { exists: true, balances: { XLM: xlmBalance, USDC: usdcBalance } };
  } catch (error) {
    console.error("Error checking wallet health:", error);
    return { exists: false, balances: { XLM: 0, USDC: 0 } };
  }
}

export {
  loadedPublicKey,
  loadedProvider,
  toKitWalletId,
  toAppWalletType,
  getWalletAvailability,
  connectWallet,
  disconnectWallet,
  reconnectSession,
  getConnectedNetwork,
  setConnection,
  disconnect,
  initializeConnection,
  getWalletHealth,
  getHorizonPool,
  setHorizonPool,
  providerRegistry,
  connectWithProvider,
  disconnectProvider,
  registerDefaultProviders,
  type WalletProvider,
  type ProviderConnectionResult,
  type WalletError,
  type WalletErrorCode,
};
