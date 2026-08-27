import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createMockVaultClient, SAMPLE_ADDRESS } from "../contract/mockClient";
import {
  ContractInterfaceError,
  type PoolActionInput,
  type PoolActionResult,
  type VaultContractClient,
} from "../contract/types";
import {
  transitionTxState,
  useTxFlow,
  type TxFlowState,
} from "./txStateMachine";

const input: PoolActionInput = {
  poolId: "pool-1",
  walletAddress: SAMPLE_ADDRESS,
  amount: "25",
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function clientWithSubmit(
  submitAction: VaultContractClient["submitAction"],
): VaultContractClient {
  return { ...createMockVaultClient(), submitAction };
}

describe("transitionTxState", () => {
  it("accepts the complete ordered lifecycle", () => {
    let state: TxFlowState = { stage: "idle" };
    state = transitionTxState(state, { type: "START" });
    expect(state).toEqual({ stage: "preparing" });

    state = transitionTxState(state, { type: "AWAIT_SIGNATURE" });
    expect(state).toEqual({ stage: "awaiting-signature" });

    state = transitionTxState(state, { type: "SUBMITTED", txHash: "tx-1" });
    expect(state).toEqual({ stage: "submitting", txHash: "tx-1" });

    state = transitionTxState(state, { type: "CONFIRMING", txHash: "tx-1" });
    expect(state).toEqual({ stage: "confirming", txHash: "tx-1" });

    state = transitionTxState(state, { type: "INDEXING", txHash: "tx-1" });
    expect(state).toEqual({ stage: "indexing", txHash: "tx-1" });

    state = transitionTxState(state, { type: "SUCCEEDED", txHash: "tx-1" });
    expect(state).toEqual({ stage: "success", txHash: "tx-1" });
  });

  it("ignores invalid and out-of-order transitions predictably", () => {
    const idle: TxFlowState = { stage: "idle" };
    expect(
      transitionTxState(idle, { type: "SUBMITTED", txHash: "tx-skipped" }),
    ).toBe(idle);

    const preparing: TxFlowState = { stage: "preparing" };
    expect(
      transitionTxState(preparing, { type: "SUCCEEDED", txHash: "tx-skipped" }),
    ).toBe(preparing);
    expect(transitionTxState(preparing, { type: "RESET" })).toBe(preparing);
  });

  it("allows terminal states to start a retry and reset to idle", () => {
    const failed: TxFlowState = {
      stage: "failed",
      failedAt: "submitting",
      message: "RPC unavailable",
    };

    expect(transitionTxState(failed, { type: "START" })).toEqual({ stage: "preparing" });
    expect(transitionTxState(failed, { type: "RESET" })).toEqual({ stage: "idle" });
  });
});

describe("useTxFlow", () => {
  it("moves through confirmation and success with a mocked client", async () => {
    const client = createMockVaultClient({ txHashFactory: () => "tx-success" });
    const onConfirmed = vi.fn();
    const { result } = renderHook(() => useTxFlow());

    await act(async () => {
      await result.current.run(client, "drip", input, {
        waitForConfirmation: async () => {},
        onConfirmed,
        indexingDelayMs: 0,
      });
    });

    expect(result.current.state).toEqual({ stage: "success", txHash: "tx-success" });
    expect(result.current.busy).toBe(false);
    expect(onConfirmed).toHaveBeenCalledWith("tx-success");
  });

  it("keeps the flow pending while ledger confirmation is unresolved", async () => {
    const confirmation = deferred<void>();
    const client = createMockVaultClient({ txHashFactory: () => "tx-pending" });
    const { result } = renderHook(() => useTxFlow());
    let runPromise!: Promise<void>;

    act(() => {
      runPromise = result.current.run(client, "drip", input, {
        waitForConfirmation: () => confirmation.promise,
        confirmationTimeoutMs: 1_000,
        indexingDelayMs: 0,
      });
    });

    await waitFor(() => {
      expect(result.current.state).toEqual({ stage: "confirming", txHash: "tx-pending" });
    });
    expect(result.current.busy).toBe(true);

    await act(async () => {
      confirmation.resolve();
      await runPromise;
    });

    expect(result.current.state).toEqual({ stage: "success", txHash: "tx-pending" });
  });

  it("maps wallet rejection, RPC failure, revert, and stale indexing to their stages", async () => {
    const cases = [
      ["signature_rejected", "awaiting-signature"],
      ["rpc_failure", "submitting"],
      ["contract_error", "confirming"],
      ["stale_data", "indexing"],
    ] as const;

    for (const [kind, failedAt] of cases) {
      const client = createMockVaultClient({ failActions: { drip: kind } });
      const { result, unmount } = renderHook(() => useTxFlow());

      await act(async () => {
        await result.current.run(client, "drip", input, { indexingDelayMs: 0 });
      });

      expect(result.current.state.stage).toBe("failed");
      if (result.current.state.stage === "failed") {
        expect(result.current.state.failedAt).toBe(failedAt);
        expect(result.current.state.message).toContain(kind);
      }
      unmount();
    }
  });

  it("fails at confirmation when the confirmation adapter times out", async () => {
    const client = createMockVaultClient({ txHashFactory: () => "tx-timeout" });
    const { result } = renderHook(() => useTxFlow());

    await act(async () => {
      await result.current.run(client, "withdraw", input, {
        waitForConfirmation: () => new Promise<void>(() => {}),
        confirmationTimeoutMs: 5,
        indexingDelayMs: 0,
      });
    });

    expect(result.current.state.stage).toBe("failed");
    if (result.current.state.stage === "failed") {
      expect(result.current.state.failedAt).toBe("confirming");
      expect(result.current.state.message).toContain("timed out");
    }
  });

  it("deduplicates concurrent submissions while one action is in flight", async () => {
    const submission = deferred<PoolActionResult>();
    const submitAction = vi.fn(() => submission.promise);
    const client = clientWithSubmit(submitAction);
    const { result } = renderHook(() => useTxFlow());
    let first!: Promise<void>;
    let duplicate!: Promise<void>;

    act(() => {
      first = result.current.run(client, "drip", input, { indexingDelayMs: 0 });
      duplicate = result.current.run(client, "drip", input, { indexingDelayMs: 0 });
    });

    expect(submitAction).toHaveBeenCalledTimes(1);

    await act(async () => {
      submission.resolve({ txHash: "tx-deduped", status: "submitted" });
      await Promise.all([first, duplicate]);
    });

    expect(submitAction).toHaveBeenCalledTimes(1);
    expect(result.current.state).toEqual({ stage: "success", txHash: "tx-deduped" });
  });

  it("retries a recoverable failure once without duplicating the retry", async () => {
    const submitAction = vi
      .fn<VaultContractClient["submitAction"]>()
      .mockRejectedValueOnce(new ContractInterfaceError("rpc_failure", "RPC temporarily unavailable"))
      .mockResolvedValueOnce({ txHash: "tx-retry", status: "submitted" });
    const client = clientWithSubmit(submitAction);
    const { result } = renderHook(() => useTxFlow());

    await act(async () => {
      await result.current.run(client, "withdraw", input, { indexingDelayMs: 0 });
    });
    expect(result.current.state.stage).toBe("failed");

    await act(async () => {
      await Promise.all([
        result.current.run(client, "withdraw", input, { indexingDelayMs: 0 }),
        result.current.run(client, "withdraw", input, { indexingDelayMs: 0 }),
      ]);
    });

    expect(submitAction).toHaveBeenCalledTimes(2);
    expect(result.current.state).toEqual({ stage: "success", txHash: "tx-retry" });
  });
});

// ─── usePersistentTxFlow (#631) ───────────────────────────────────────────────

describe("usePersistentTxFlow – persistence and recovery", () => {
  const scopeKey = "test-wallet:testnet";
  const STORAGE_KEY = `vaultquest:pending_tx:${scopeKey}`;

  beforeEach(() => {
    localStorage.clear();
  });

  it("clears storage on success", async () => {
    const { usePersistentTxFlow } = await import("./txStateMachine");
    const client = clientWithSubmit(async () => ({ txHash: "tx-ok", status: "submitted" }));
    const { result } = renderHook(() => usePersistentTxFlow({ scopeKey }));

    await act(async () => {
      await result.current.run(client, "claim", input, { indexingDelayMs: 0 });
    });

    expect(result.current.state.stage).toBe("success");
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("clears storage on failure", async () => {
    const { usePersistentTxFlow } = await import("./txStateMachine");
    const err = new Error("RPC fail");
    (err as any).kind = "rpc_failure";
    const client = clientWithSubmit(async () => { throw err; });
    const { result } = renderHook(() => usePersistentTxFlow({ scopeKey }));

    await act(async () => {
      await result.current.run(client, "claim", input, { indexingDelayMs: 0 });
    });

    expect(result.current.state.stage).toBe("failed");
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("surfaces a recovered interrupted transaction as failed with a descriptive message", async () => {
    const { usePersistentTxFlow } = await import("./txStateMachine");
    const record = { stage: "confirming", txHash: "tx-interrupted", savedAt: Date.now() };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(record));

    const { result } = renderHook(() => usePersistentTxFlow({ scopeKey }));

    await waitFor(() => expect(result.current.state.stage).toBe("failed"));
    expect(result.current.recovered).toBe(true);
    if (result.current.state.stage === "failed") {
      expect(result.current.state.message).toMatch(/tx-interrupted/);
    }
  });

  it("ignores stale persisted records older than 24 hours", async () => {
    const { usePersistentTxFlow } = await import("./txStateMachine");
    const staleRecord = {
      stage: "confirming",
      txHash: "tx-stale",
      savedAt: Date.now() - 25 * 60 * 60 * 1000,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(staleRecord));

    const { result } = renderHook(() => usePersistentTxFlow({ scopeKey }));

    // Wait briefly; state should stay idle since record is expired.
    await new Promise((r) => setTimeout(r, 50));
    expect(result.current.state.stage).toBe("idle");
    expect(result.current.recovered).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});
