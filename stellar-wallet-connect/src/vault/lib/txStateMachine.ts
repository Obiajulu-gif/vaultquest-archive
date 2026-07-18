/**
 * Shared transaction state machine for wallet-driven actions.
 *
 * All wallet flows pass through this lifecycle so transaction progress and
 * recovery behaviour remain consistent across deposit and withdrawal UIs.
 */
import { useCallback, useRef, useState } from "react";
import type { TimelineStage } from "../../components/TransactionTimeline";
import type { PoolActionInput, PoolActionType, VaultContractClient } from "../contract/types";

export type TxFlowState =
  | { stage: "idle" }
  | { stage: "preparing" }
  | { stage: "awaiting-signature" }
  | { stage: "submitting"; txHash?: string }
  | { stage: "confirming"; txHash: string }
  | { stage: "indexing"; txHash: string }
  | { stage: "success"; txHash: string }
  | { stage: "failed"; failedAt: Exclude<TimelineStage, "success" | "failed">; message: string };

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
  onConfirmed?: (txHash: string) => void;
  indexingDelayMs?: number;
  /** Maximum time allowed for submitAction before the flow becomes retryable. */
  timeoutMs?: number;
}

function isTerminal(stage: TxFlowState["stage"]): boolean {
  return stage === "success" || stage === "failed";
}

export function mapTxError(err: unknown): {
  failedAt: Exclude<TimelineStage, "success" | "failed">;
  message: string;
} {
  const message = err instanceof Error ? err.message : String(err);
  const kind = (err as { kind?: string }).kind ?? "";
  if (kind === "wallet_disconnected" || kind === "signature_rejected") {
    return { failedAt: "awaiting-signature", message };
  }
  if (kind === "rpc_failure" || kind === "contract_error") {
    return { failedAt: "submitting", message };
  }
  return { failedAt: "confirming", message };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          const error = new Error("Transaction confirmation timed out");
          Object.assign(error, { kind: "confirmation_timeout" });
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function useTxFlow(): TxFlowResult {
  const [state, setState] = useState<TxFlowState>({ stage: "idle" });
  const inFlight = useRef(false);

  const busy = state.stage !== "idle" && !isTerminal(state.stage);

  const reset = useCallback(() => {
    if (inFlight.current) return;
    setState({ stage: "idle" });
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
      const { onConfirmed, indexingDelayMs = 2_000, timeoutMs = 60_000 } = options;

      setState({ stage: "preparing" });
      try {
        setState({ stage: "awaiting-signature" });
        const result = await withTimeout(client.submitAction(type, input), timeoutMs);

        setState({ stage: "submitting", txHash: result.txHash });
        setState({ stage: "confirming", txHash: result.txHash });
        onConfirmed?.(result.txHash);

        setState({ stage: "indexing", txHash: result.txHash });
        await new Promise<void>((resolve) => setTimeout(resolve, indexingDelayMs));
        setState({ stage: "success", txHash: result.txHash });
      } catch (err) {
        const { failedAt, message } = mapTxError(err);
        setState({ stage: "failed", failedAt, message });
      } finally {
        inFlight.current = false;
      }
    },
    [],
  );

  return { state, busy, run, reset };
}
