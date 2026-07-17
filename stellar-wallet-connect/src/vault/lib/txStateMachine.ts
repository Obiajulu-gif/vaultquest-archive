import { useCallback, useReducer, useRef } from "react";
import type { TimelineStage } from "../../components/TransactionTimeline";
import type { PoolActionInput, PoolActionType, VaultContractClient } from "../contract/types";

export type TxActiveStage = Exclude<TimelineStage, "success" | "failed">;
export type TxFailureReason =
  | "wallet_disconnected"
  | "signature_rejected"
  | "rpc_failure"
  | "reverted"
  | "timeout"
  | "stale_data"
  | "unknown";

export type TxFlowState =
  | { stage: "idle" }
  | { stage: "preparing" }
  | { stage: "awaiting-signature" }
  | { stage: "submitting"; txHash: string }
  | { stage: "confirming"; txHash: string }
  | { stage: "indexing"; txHash: string }
  | { stage: "success"; txHash: string }
  | {
      stage: "failed";
      failedAt: TxActiveStage;
      message: string;
      reason: TxFailureReason;
      retryable: boolean;
      txHash?: string;
    };

export type TxFlowEvent =
  | { type: "START" }
  | { type: "AWAIT_SIGNATURE" }
  | { type: "SUBMITTED"; txHash: string }
  | { type: "CONFIRMING" }
  | { type: "INDEXING" }
  | { type: "SUCCEEDED" }
  | {
      type: "FAILED";
      failedAt: TxActiveStage;
      message: string;
      reason: TxFailureReason;
      retryable: boolean;
      txHash?: string;
    }
  | { type: "RESET" };

const INITIAL_STATE: TxFlowState = { stage: "idle" };

/**
 * Pure transition function used by the hook and unit tests. Invalid or stale
 * events are ignored so late RPC responses cannot move a newer transaction.
 */
export function transitionTxState(state: TxFlowState, event: TxFlowEvent): TxFlowState {
  switch (event.type) {
    case "RESET":
      return INITIAL_STATE;
    case "START":
      return state.stage === "idle" || state.stage === "success" || state.stage === "failed"
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
        ? { stage: "confirming", txHash: state.txHash }
        : state;
    case "INDEXING":
      return state.stage === "confirming"
        ? { stage: "indexing", txHash: state.txHash }
        : state;
    case "SUCCEEDED":
      return state.stage === "indexing"
        ? { stage: "success", txHash: state.txHash }
        : state;
    case "FAILED":
      return state.stage === "idle" || state.stage === "success"
        ? state
        : {
            stage: "failed",
            failedAt: event.failedAt,
            message: event.message,
            reason: event.reason,
            retryable: event.retryable,
            ...(event.txHash ? { txHash: event.txHash } : {}),
          };
  }
}

export interface TxFlowResult {
  state: TxFlowState;
  busy: boolean;
  run: (
    client: VaultContractClient,
    type: PoolActionType,
    input: PoolActionInput,
    options?: TxFlowOptions,
  ) => Promise<void>;
  reset: () => void;
}

export interface TxFlowOptions {
  /** Called once after ledger confirmation and before the indexing delay. */
  onConfirmed?: (txHash: string) => void;
  /** Optional confirmation adapter. Defaults to immediate confirmation. */
  confirm?: (txHash: string) => Promise<"confirmed" | "reverted">;
  /** Maximum confirmation wait before the transaction becomes retryable. */
  confirmationTimeoutMs?: number;
  /** Delay reserved for backend indexer reconciliation. */
  indexingDelayMs?: number;
}

type ClassifiedFailure = {
  failedAt: TxActiveStage;
  message: string;
  reason: TxFailureReason;
  retryable: boolean;
};

function classifyError(err: unknown): ClassifiedFailure {
  const message = err instanceof Error ? err.message : String(err);
  const kind = (err as { kind?: string }).kind ?? "";

  if (kind === "wallet_disconnected") {
    return { failedAt: "awaiting-signature", message, reason: "wallet_disconnected", retryable: true };
  }
  if (kind === "signature_rejected") {
    return { failedAt: "awaiting-signature", message, reason: "signature_rejected", retryable: true };
  }
  if (kind === "rpc_failure") {
    return { failedAt: "submitting", message, reason: "rpc_failure", retryable: true };
  }
  if (kind === "contract_error") {
    return { failedAt: "confirming", message, reason: "reverted", retryable: false };
  }
  if (kind === "stale_data") {
    return { failedAt: "preparing", message, reason: "stale_data", retryable: true };
  }
  if (kind === "tx_timeout") {
    return { failedAt: "confirming", message, reason: "timeout", retryable: true };
  }
  return { failedAt: "confirming", message, reason: "unknown", retryable: true };
}

function wait(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs?: number): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) return promise;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error("Transaction confirmation timed out");
      (error as Error & { kind: string }).kind = "tx_timeout";
      reject(error);
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function useTxFlow(): TxFlowResult {
  const [state, dispatch] = useReducer(transitionTxState, INITIAL_STATE);
  const inFlight = useRef(false);
  const latestTxHash = useRef<string | undefined>(undefined);

  const busy =
    state.stage !== "idle" && state.stage !== "success" && state.stage !== "failed";

  const reset = useCallback(() => {
    if (!inFlight.current) {
      latestTxHash.current = undefined;
      dispatch({ type: "RESET" });
    }
  }, []);

  const run = useCallback(
    async (
      client: VaultContractClient,
      type: PoolActionType,
      input: PoolActionInput,
      options: TxFlowOptions = {},
    ) => {
      if (inFlight.current) return;
      inFlight.current = true;
      latestTxHash.current = undefined;
      dispatch({ type: "START" });

      try {
        dispatch({ type: "AWAIT_SIGNATURE" });
        const result = await client.submitAction(type, input);
        latestTxHash.current = result.txHash;
        dispatch({ type: "SUBMITTED", txHash: result.txHash });
        dispatch({ type: "CONFIRMING" });

        const confirmation = await withTimeout(
          options.confirm?.(result.txHash) ?? Promise.resolve("confirmed" as const),
          options.confirmationTimeoutMs,
        );

        if (confirmation === "reverted") {
          const error = new Error("Transaction reverted on-chain");
          (error as Error & { kind: string }).kind = "contract_error";
          throw error;
        }

        dispatch({ type: "INDEXING" });
        options.onConfirmed?.(result.txHash);
        await wait(options.indexingDelayMs ?? 2_000);
        dispatch({ type: "SUCCEEDED" });
      } catch (err) {
        const failure = classifyError(err);
        dispatch({
          type: "FAILED",
          ...failure,
          ...(latestTxHash.current ? { txHash: latestTxHash.current } : {}),
        });
      } finally {
        inFlight.current = false;
      }
    },
    [],
  );

  return { state, busy, run, reset };
}
