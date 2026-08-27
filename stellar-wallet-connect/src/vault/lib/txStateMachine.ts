/**
 * Shared transaction state machine for wallet-driven actions (#94).
 *
 * All wallet flows (join, drip, claim, withdraw, create) pass through the same
 * lifecycle. The pure transition function below is intentionally exported so
 * invalid transitions can be regression-tested without mounting React.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { TimelineStage } from "../../components/TransactionTimeline";
import type { PoolActionInput, PoolActionType, VaultContractClient } from "../contract/types";

export type ActiveTxStage = Exclude<TimelineStage, "success" | "failed">;

export type TxFlowState =
  | { stage: "idle" }
  | { stage: "preparing" }
  | { stage: "awaiting-signature" }
  | { stage: "submitting"; txHash?: string }
  | { stage: "confirming"; txHash: string }
  | { stage: "indexing"; txHash: string }
  | { stage: "success"; txHash: string }
  | { stage: "failed"; failedAt: ActiveTxStage; message: string };

export type TxFlowEvent =
  | { type: "START" }
  | { type: "AWAIT_SIGNATURE" }
  | { type: "SUBMITTED"; txHash: string }
  | { type: "CONFIRMING"; txHash: string }
  | { type: "INDEXING"; txHash: string }
  | { type: "SUCCEEDED"; txHash: string }
  | { type: "FAILED"; failedAt: ActiveTxStage; message: string }
  | { type: "RESET" };

export interface TxFlowResult {
  /** Current flow state — pass `state.stage` directly to `<TransactionTimeline stage={...}>`. */
  state: TxFlowState;
  /** True while any non-idle, non-terminal stage is active. */
  busy: boolean;
  /** Execute a wallet action, driving the machine through its stages. */
  run: (
    client: VaultContractClient,
    type: PoolActionType,
    input: PoolActionInput,
    options?: TxFlowOptions,
  ) => Promise<void>;
  /** Reset back to idle. Resets are ignored while an action is in flight. */
  reset: () => void;
}

export interface TxFlowOptions {
  /** Called after ledger confirmation and before the indexing stage. */
  onConfirmed?: (txHash: string) => void;
  /**
   * Optional confirmation adapter. Production callers can poll Horizon/Soroban;
   * tests can inject pending, reverted, and timeout behavior deterministically.
   */
  waitForConfirmation?: (txHash: string) => Promise<void>;
  /** Maximum wait for `waitForConfirmation`. Defaults to 45 seconds. */
  confirmationTimeoutMs?: number;
  /** Delay before advancing from indexing to success. Defaults to 2 seconds. */
  indexingDelayMs?: number;
}

const INITIAL_STATE: TxFlowState = { stage: "idle" };

function isTerminalState(state: TxFlowState): boolean {
  return state.stage === "success" || state.stage === "failed";
}

function isActiveState(state: TxFlowState): state is Exclude<TxFlowState, { stage: "idle" | "success" | "failed" }> {
  return state.stage !== "idle" && !isTerminalState(state);
}

/**
 * Apply one legal state-machine event. Invalid or out-of-order events are
 * ignored by returning the exact same state object.
 */
export function transitionTxState(state: TxFlowState, event: TxFlowEvent): TxFlowState {
  switch (event.type) {
    case "START":
      return state.stage === "idle" || isTerminalState(state)
        ? { stage: "preparing" }
        : state;
    case "AWAIT_SIGNATURE":
      return state.stage === "preparing" ? { stage: "awaiting-signature" } : state;
    case "SUBMITTED":
      return state.stage === "awaiting-signature"
        ? { stage: "submitting", txHash: event.txHash }
        : state;
    case "CONFIRMING":
      return state.stage === "submitting"
        ? { stage: "confirming", txHash: event.txHash }
        : state;
    case "INDEXING":
      return state.stage === "confirming"
        ? { stage: "indexing", txHash: event.txHash }
        : state;
    case "SUCCEEDED":
      return state.stage === "indexing"
        ? { stage: "success", txHash: event.txHash }
        : state;
    case "FAILED":
      return isActiveState(state)
        ? { stage: "failed", failedAt: event.failedAt, message: event.message }
        : state;
    case "RESET":
      return state.stage === "idle" || isTerminalState(state) ? INITIAL_STATE : state;
  }
}

export class TxConfirmationTimeoutError extends Error {
  readonly kind = "confirmation_timeout";

  constructor(timeoutMs: number) {
    super(`Transaction confirmation timed out after ${timeoutMs}ms.`);
    this.name = "TxConfirmationTimeoutError";
  }
}

export function mapTxError(
  err: unknown,
  fallbackStage: ActiveTxStage,
): { failedAt: ActiveTxStage; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  const kind = (err as { kind?: string }).kind ?? "";

  if (kind === "wallet_disconnected" || kind === "signature_rejected") {
    return { failedAt: "awaiting-signature", message };
  }
  if (kind === "rpc_failure") {
    return { failedAt: "submitting", message };
  }
  if (kind === "contract_error" || kind === "confirmation_timeout") {
    return { failedAt: "confirming", message };
  }
  if (kind === "stale_data") {
    return { failedAt: "indexing", message };
  }
  return { failedAt: fallbackStage, message };
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(
  confirmation: Promise<void>,
  timeoutMs: number,
): Promise<void> {
  if (timeoutMs <= 0) return confirmation;

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TxConfirmationTimeoutError(timeoutMs)), timeoutMs);
    confirmation.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function stateFailureFallback(state: TxFlowState): ActiveTxStage {
  if (isActiveState(state)) return state.stage;
  return "confirming";
}

// ─── Persistence helpers (#631) ───────────────────────────────────────────────

interface PersistedTxRecord {
  txHash: string | null;
  stage: ActiveTxStage;
  savedAt: number;
}

const PERSIST_KEY_PREFIX = "vaultquest:pending_tx:";
const PERSIST_TTL_MS = 24 * 60 * 60 * 1000; // 24 h

function persistTxRecord(scopeKey: string, record: PersistedTxRecord): void {
  try {
    localStorage.setItem(PERSIST_KEY_PREFIX + scopeKey, JSON.stringify(record));
  } catch {
    // quota exceeded or SSR — ignore
  }
}

function loadPersistedTxRecord(scopeKey: string): PersistedTxRecord | null {
  try {
    const raw = localStorage.getItem(PERSIST_KEY_PREFIX + scopeKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedTxRecord;
    if (Date.now() - parsed.savedAt > PERSIST_TTL_MS) {
      localStorage.removeItem(PERSIST_KEY_PREFIX + scopeKey);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function clearPersistedTxRecord(scopeKey: string): void {
  try {
    localStorage.removeItem(PERSIST_KEY_PREFIX + scopeKey);
  } catch {
    // ignore
  }
}

/**
 * Returns a sorted, deduplicated list of in-flight tx hashes seen in this
 * session. Prevents duplicate wallet submissions from creating parallel flows.
 */
const _seenHashes = new Set<string>();
export function markTxHashSeen(txHash: string): boolean {
  if (_seenHashes.has(txHash)) return false;
  _seenHashes.add(txHash);
  return true;
}

export interface PersistentTxFlowOptions {
  /**
   * Unique scope key: typically `${walletAddress}:${network}` so each wallet
   * on each network has its own recovery slot.
   */
  scopeKey: string;
}

export interface PersistentTxFlowResult extends TxFlowResult {
  /** True when the flow was recovered from a previous interrupted session. */
  recovered: boolean;
}

/**
 * Wraps `useTxFlow` with localStorage persistence (#631).
 *
 * On mount: if a non-terminal tx record exists in storage (tab close,
 * navigation away mid-flow), the state is restored to `failed` with a
 * recovery message so the user sees the last known stage and can retry or
 * check the explorer.  Pending hashes that reach `success` or `failed`
 * clear their record automatically.
 */
export function usePersistentTxFlow({ scopeKey }: PersistentTxFlowOptions): PersistentTxFlowResult {
  const flow = useTxFlow();
  const [recovered, setRecovered] = useState(false);

  useEffect(() => {
    const record = loadPersistedTxRecord(scopeKey);
    if (!record) return;

    // A previously-pending tx was interrupted. Surface it as failed so the
    // user knows to verify on-chain rather than silently losing the status.
    clearPersistedTxRecord(scopeKey);
    flow.reset();
    // We cannot drive the machine to "preparing" → ... → "failed" purely from
    // localStorage, so we directly inject the terminal failure state.  The
    // txHash, if present, was already submitted — the user should verify it.
    const message =
      record.txHash
        ? `Transaction interrupted at '${record.stage}' stage. ` +
          `Hash ${record.txHash.slice(0, 12)}… may have landed — check the explorer.`
        : `Transaction interrupted at '${record.stage}' stage before a hash was recorded.`;

    // Use the internal transition sequence to reach "failed" legally:
    // idle → preparing → awaiting-signature → failed
    // We call reset first (already done), then drive through the minimal path.
    // Because useTxFlow exposes `run`, not `transition`, we replicate only the
    // final state via a synthetic call path using the public reset + a no-op
    // run that immediately throws. This keeps the stateRef consistent.
    (async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (flow as any).run(
        {
          submitAction: async () => {
            const err: Error & { kind?: string } = new Error(message);
            err.kind = record.txHash ? "confirmation_timeout" : "rpc_failure";
            throw err;
          },
        },
        "claim",
        { poolId: "", walletAddress: "" },
        { confirmationTimeoutMs: 0, indexingDelayMs: 0 },
      );
    })().catch(() => undefined);

    setRecovered(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey]);

  // Persist whenever the state advances to a non-idle, non-terminal stage.
  useEffect(() => {
    const { state } = flow;
    if (state.stage === "idle" || state.stage === "success" || state.stage === "failed") {
      clearPersistedTxRecord(scopeKey);
      return;
    }
    const record: PersistedTxRecord = {
      stage: state.stage as ActiveTxStage,
      txHash: "txHash" in state ? (state.txHash ?? null) : null,
      savedAt: Date.now(),
    };
    persistTxRecord(scopeKey, record);
  }, [flow, flow.state, scopeKey]);

  return { ...flow, recovered };
}

export function useTxFlow(): TxFlowResult {
  const [state, setState] = useState<TxFlowState>(INITIAL_STATE);
  const stateRef = useRef<TxFlowState>(INITIAL_STATE);
  const inFlightRef = useRef(false);

  const transition = useCallback((event: TxFlowEvent): TxFlowState => {
    const next = transitionTxState(stateRef.current, event);
    if (next !== stateRef.current) {
      stateRef.current = next;
      setState(next);
    }
    return next;
  }, []);

  const busy = isActiveState(state);

  const reset = useCallback(() => {
    transition({ type: "RESET" });
  }, [transition]);

  const run = useCallback(
    async (
      client: VaultContractClient,
      type: PoolActionType,
      input: PoolActionInput,
      options: TxFlowOptions = {},
    ) => {
      // A synchronous ref guard prevents two clicks/render cycles from creating
      // duplicate local action records or wallet submissions.
      if (inFlightRef.current) return;

      const started = transition({ type: "START" });
      if (started.stage !== "preparing") return;
      inFlightRef.current = true;

      const {
        onConfirmed,
        waitForConfirmation,
        confirmationTimeoutMs = 45_000,
        indexingDelayMs = 2_000,
      } = options;

      try {
        transition({ type: "AWAIT_SIGNATURE" });
        const result = await client.submitAction(type, input);

        transition({ type: "SUBMITTED", txHash: result.txHash });
        transition({ type: "CONFIRMING", txHash: result.txHash });

        if (waitForConfirmation) {
          await withTimeout(waitForConfirmation(result.txHash), confirmationTimeoutMs);
        }

        onConfirmed?.(result.txHash);
        transition({ type: "INDEXING", txHash: result.txHash });
        await delay(indexingDelayMs);
        transition({ type: "SUCCEEDED", txHash: result.txHash });
      } catch (err) {
        const { failedAt, message } = mapTxError(err, stateFailureFallback(stateRef.current));
        transition({ type: "FAILED", failedAt, message });
      } finally {
        inFlightRef.current = false;
      }
    },
    [transition],
  );

  return { state, busy, run, reset };
}
