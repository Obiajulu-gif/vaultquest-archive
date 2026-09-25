/**
 * Wallet session-liveness detection and reconnect recovery (#733).
 *
 * Problem this closes: when a wallet session expires, the extension is
 * unlocked/locked in another tab, or the account is switched underneath the
 * app, nothing previously detected it — the UI kept believing the wallet
 * was still connected until an operation failed, surfacing a confusing
 * error deep inside a flow (e.g. after the user already entered a deposit
 * amount) instead of proactively catching it.
 *
 * Wallet providers don't help uniformly here: some (Freighter) emit an
 * account-changed style signal, most don't, and none of it is exposed
 * consistently through `@creit.tech/stellar-wallets-kit`'s shared
 * interface. So this combines two independent signals, same as the
 * existing network watcher (`walletService.ts` #735) it deliberately
 * mirrors:
 *
 *  - an active heartbeat, silently re-reading the wallet's current address
 *    (`kit.getAddress()` — the same non-prompting read used by the network
 *    watcher) on an exponential-backoff schedule, so a dead session is
 *    caught within a bounded time without hammering the wallet or its
 *    popup once it's known to be unreachable;
 *  - passive listening on window focus / tab visibility — the one signal
 *    available across every wallet, since a user coming back to the tab
 *    after touching the extension elsewhere (unlocking it, switching
 *    accounts) is a strong proxy for "the session may have just changed" —
 *    triggering an immediate re-check instead of waiting for the next
 *    scheduled tick.
 *
 * Recovery never drops in-progress context: nothing here calls the hard
 * `disconnect()` reset. `walletService.reconnectSession()` re-runs the
 * normal `connectWallet` flow for the same provider, which only clears
 * user-scoped state (including the `usePersistedTxState` record in
 * `vault/hooks.ts`) when the reconnected account's public key actually
 * differs from the one that was connected — so resuming the *same*
 * session's in-progress action after a reconnect works for free.
 */
import { kit } from "./kit.js";
import { sessionStatus } from "./store.js";
import type { WalletType } from "../lib/wallets.js";

export class WalletSessionLostError extends Error {
  /** Matches the existing `ContractErrorKind` slot in `vault/contract/types.ts`
   *  and the case `txStateMachine.ts`'s `mapTxError` already handles. */
  readonly kind = "wallet_disconnected";
  constructor(message = "Wallet session is no longer active. Reconnect and try again.") {
    super(message);
    this.name = "WalletSessionLostError";
  }
}

const BASE_INTERVAL_MS = 20_000;
const MAX_INTERVAL_MS = 5 * 60_000;
const BACKOFF_FACTOR = 2;
const PROBE_TIMEOUT_MS = 8_000;
const IMMEDIATE_CHECK_DEBOUNCE_MS = 1_000;

let currentIntervalMs = BASE_INTERVAL_MS;
let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
let listenersAttached = false;
let expectedPublicKey: string | undefined;
let lastImmediateCheckAt = 0;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("wallet liveness probe timed out")), ms);
    p.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Silent probe: re-reads the wallet's current address without prompting
 * the user. Returns null on any failure/timeout — including the wallet
 * being locked, the extension having been removed, or the read simply
 * taking too long — never throws, so callers decide what "unreachable"
 * means for them.
 */
async function probeSession(): Promise<string | null> {
  if (typeof window === "undefined") return null;
  try {
    const { address } = await withTimeout(kit.getAddress(), PROBE_TIMEOUT_MS);
    return address || null;
  } catch {
    return null;
  }
}

function scheduleNext(): void {
  if (typeof window === "undefined" || !expectedPublicKey) return;
  clearTimeout(heartbeatTimer);
  heartbeatTimer = setTimeout(() => {
    void runHeartbeat();
  }, currentIntervalMs);
}

async function runHeartbeat(): Promise<void> {
  if (!expectedPublicKey) return;
  sessionStatus.set("checking");
  const address = await probeSession();

  if (address && address === expectedPublicKey) {
    sessionStatus.set("alive");
    currentIntervalMs = BASE_INTERVAL_MS;
  } else {
    // Either unreachable, or silently switched to a different account —
    // both mean this connection can no longer sign on the user's behalf
    // without them reconnecting/re-authorizing.
    sessionStatus.set("lost");
    currentIntervalMs = Math.min(currentIntervalMs * BACKOFF_FACTOR, MAX_INTERVAL_MS);
  }

  scheduleNext();
}

/** Re-check immediately rather than waiting for the next scheduled tick, debounced so rapid focus/visibility churn can't spam the wallet. */
function checkNow(): void {
  if (typeof window === "undefined" || !expectedPublicKey) return;
  const now = Date.now();
  if (now - lastImmediateCheckAt < IMMEDIATE_CHECK_DEBOUNCE_MS) return;
  lastImmediateCheckAt = now;
  clearTimeout(heartbeatTimer);
  void runHeartbeat();
}

function onVisibilityChange(): void {
  if (typeof document !== "undefined" && document.visibilityState === "visible") {
    checkNow();
  }
}

function attachListeners(): void {
  if (listenersAttached || typeof window === "undefined") return;
  window.addEventListener("focus", checkNow);
  document.addEventListener("visibilitychange", onVisibilityChange);
  listenersAttached = true;
}

function detachListeners(): void {
  if (!listenersAttached || typeof window === "undefined") return;
  window.removeEventListener("focus", checkNow);
  document.removeEventListener("visibilitychange", onVisibilityChange);
  listenersAttached = false;
}

/**
 * Start watching a connected session's liveness. Safe to call repeatedly —
 * each call re-targets `publicKey` and resets the backoff schedule (used
 * on fresh connect, on init-from-storage, and after a successful
 * reconnect).
 */
export function startSessionLivenessWatcher(_provider: WalletType, publicKey: string): void {
  if (typeof window === "undefined") return;
  expectedPublicKey = publicKey;
  currentIntervalMs = BASE_INTERVAL_MS;
  sessionStatus.set("unknown");
  attachListeners();
  clearTimeout(heartbeatTimer);
  heartbeatTimer = setTimeout(() => {
    void runHeartbeat();
  }, currentIntervalMs);
}

/** Stop watching — called from the hard `disconnect()` path. */
export function stopSessionLivenessWatcher(): void {
  clearTimeout(heartbeatTimer);
  heartbeatTimer = undefined;
  detachListeners();
  expectedPublicKey = undefined;
  sessionStatus.set("unknown");
}

/**
 * Fresh, immediate liveness check — a signing preflight mirroring
 * `assertNetworkMatchesBeforeSigning`/`assertNotMultisigBeforeSigning`
 * (`walletService.ts` #735/#736), so a dead session is caught *before* the
 * wallet's signing prompt would even appear, not after. Throws
 * `WalletSessionLostError` (`kind: "wallet_disconnected"`), which
 * `txStateMachine.ts`'s `mapTxError` already classifies as failing at the
 * `awaiting-signature` stage.
 */
export async function assertSessionAliveBeforeSigning(): Promise<void> {
  if (typeof window === "undefined" || !expectedPublicKey) return;
  const address = await probeSession();
  if (address && address === expectedPublicKey) {
    sessionStatus.set("alive");
    currentIntervalMs = BASE_INTERVAL_MS;
    return;
  }
  sessionStatus.set("lost");
  throw new WalletSessionLostError();
}
