import { act } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContractInterfaceError, type VaultContractClient } from "../contract/types";
import {
  transitionTxState,
  useTxFlow,
  type TxFlowState,
} from "./txStateMachine";

const input = {
  poolId: "pool-1",
  walletAddress: "GTESTWALLET",
  amount: "25",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function clientWith(submitAction: VaultContractClient["submitAction"]): VaultContractClient {
  return {
    isWalletConnected: () => true,
    getConnectedAddress: () => input.walletAddress,
    getPool: vi.fn(),
    getUserPosition: vi.fn(),
    listRewardHistory: vi.fn(),
    submitAction,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("transitionTxState", () => {
  it("accepts the documented happy-path transitions", () => {
    let state: TxFlowState = { stage: "idle" };
    state = transitionTxState(state, { type: "START" });
    state = transitionTxState(state, { type: "AWAIT_SIGNATURE" });
    state = transitionTxState(state, { type: "SUBMITTED", txHash: "tx-1" });
    state = transitionTxState(state, { type: "CONFIRMING" });
    state = transitionTxState(state, { type: "INDEXING" });
    state = transitionTxState(state, { type: "SUCCEEDED" });

    expect(state).toEqual({ stage: "success", txHash: "tx-1" });
  });

  it("ignores invalid and stale transitions predictably", () => {
    const idle: TxFlowState = { stage: "idle" };
    expect(transitionTxState(idle, { type: "CONFIRMING" })).toBe(idle);

    const success: TxFlowState = { stage: "success", txHash: "tx-old" };
    expect(
      transitionTxState(success, {
        type: "FAILED",
        failedAt: "confirming",
        message: "late response",
        reason: "unknown",
        retryable: true,
      }),
    ).toBe(success);
  });
});

describe("useTxFlow", () => {
  it("shows pending confirmation and then succeeds", async () => {
    const confirmation = deferred<"confirmed" | "reverted">();
    const onConfirmed = vi.fn();
    const client = clientWith(vi.fn().mockResolvedValue({ txHash: "tx-success", status: "submitted" }));
    const { result } = renderHook(() => useTxFlow());

    let runPromise!: Promise<void>;
    act(() => {
      runPromise = result.current.run(client, "drip", input, {
        confirm: () => confirmation.promise,
        indexingDelayMs: 0,
        onConfirmed,
      });
    });

    await waitFor(() => expect(result.current.state.stage).toBe("confirming"));
    expect(result.current.busy).toBe(true);

    await act(async () => {
      confirmation.resolve("confirmed");
      await runPromise;
    });

    expect(result.current.state).toEqual({ stage: "success", txHash: "tx-success" });
    expect(onConfirmed).toHaveBeenCalledTimes(1);
    expect(onConfirmed).toHaveBeenCalledWith("tx-success");
  });

  it("maps wallet rejection to the signature stage", async () => {
    const client = clientWith(
      vi.fn().mockRejectedValue(new ContractInterfaceError("signature_rejected", "User rejected request")),
    );
    const { result } = renderHook(() => useTxFlow());

    await act(async () => {
      await result.current.run(client, "drip", input, { indexingDelayMs: 0 });
    });

    expect(result.current.state).toMatchObject({
      stage: "failed",
      failedAt: "awaiting-signature",
      reason: "signature_rejected",
      retryable: true,
    });
  });

  it("maps RPC failures to submission and on-chain reverts to confirmation", async () => {
    const rpcClient = clientWith(
      vi.fn().mockRejectedValue(new ContractInterfaceError("rpc_failure", "RPC unavailable")),
    );
    const rpc = renderHook(() => useTxFlow());

    await act(async () => {
      await rpc.result.current.run(rpcClient, "withdraw", input, { indexingDelayMs: 0 });
    });
    expect(rpc.result.current.state).toMatchObject({
      stage: "failed",
      failedAt: "submitting",
      reason: "rpc_failure",
    });

    const revertedClient = clientWith(
      vi.fn().mockResolvedValue({ txHash: "tx-reverted", status: "submitted" }),
    );
    const reverted = renderHook(() => useTxFlow());

    await act(async () => {
      await reverted.result.current.run(revertedClient, "withdraw", input, {
        confirm: async () => "reverted",
        indexingDelayMs: 0,
      });
    });
    expect(reverted.result.current.state).toMatchObject({
      stage: "failed",
      failedAt: "confirming",
      reason: "reverted",
      retryable: false,
      txHash: "tx-reverted",
    });
  });

  it("times out a stalled confirmation and allows retry", async () => {
    vi.useFakeTimers();
    const stalled = deferred<"confirmed" | "reverted">();
    const submitAction = vi
      .fn()
      .mockResolvedValueOnce({ txHash: "tx-timeout", status: "submitted" })
      .mockResolvedValueOnce({ txHash: "tx-retry", status: "submitted" });
    const client = clientWith(submitAction);
    const onConfirmed = vi.fn();
    const { result } = renderHook(() => useTxFlow());

    let firstRun!: Promise<void>;
    act(() => {
      firstRun = result.current.run(client, "drip", input, {
        confirm: () => stalled.promise,
        confirmationTimeoutMs: 50,
        indexingDelayMs: 0,
        onConfirmed,
      });
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
      await firstRun;
    });

    expect(result.current.state).toMatchObject({
      stage: "failed",
      reason: "timeout",
      retryable: true,
      txHash: "tx-timeout",
    });
    expect(onConfirmed).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.run(client, "drip", input, {
        confirm: async () => "confirmed",
        indexingDelayMs: 0,
        onConfirmed,
      });
    });

    expect(result.current.state).toEqual({ stage: "success", txHash: "tx-retry" });
    expect(onConfirmed).toHaveBeenCalledTimes(1);
  });

  it("deduplicates concurrent submissions", async () => {
    const pending = deferred<{ txHash: string; status: "submitted" }>();
    const submitAction = vi.fn(() => pending.promise);
    const client = clientWith(submitAction);
    const { result } = renderHook(() => useTxFlow());

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = result.current.run(client, "drip", input, { indexingDelayMs: 0 });
      second = result.current.run(client, "drip", input, { indexingDelayMs: 0 });
    });

    expect(submitAction).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve({ txHash: "tx-once", status: "submitted" });
      await Promise.all([first, second]);
    });

    expect(result.current.state).toEqual({ stage: "success", txHash: "tx-once" });
  });
});
