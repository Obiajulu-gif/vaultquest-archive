import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { mapTxError, useTxFlow } from "./txStateMachine";
import type { VaultContractClient } from "../contract/types";

function clientWithSubmit(submitAction: VaultContractClient["submitAction"]): VaultContractClient {
  return { submitAction } as VaultContractClient;
}

const input = { poolId: "pool-1", amount: "10000000" } as never;

describe("useTxFlow", () => {
  it("moves a confirmed transaction to success", async () => {
    const onConfirmed = vi.fn();
    const client = clientWithSubmit(vi.fn().mockResolvedValue({ txHash: "tx-success" }));
    const { result } = renderHook(() => useTxFlow());

    await act(async () => {
      await result.current.run(client, "deposit" as never, input, {
        indexingDelayMs: 0,
        onConfirmed,
      });
    });

    expect(result.current.state).toEqual({ stage: "success", txHash: "tx-success" });
    expect(result.current.busy).toBe(false);
    expect(onConfirmed).toHaveBeenCalledOnce();
    expect(onConfirmed).toHaveBeenCalledWith("tx-success");
  });

  it.each([
    ["signature_rejected", "awaiting-signature"],
    ["wallet_disconnected", "awaiting-signature"],
    ["rpc_failure", "submitting"],
    ["contract_error", "submitting"],
  ])("maps %s into a retryable %s failure", async (kind, failedAt) => {
    const error = Object.assign(new Error(kind), { kind });
    const client = clientWithSubmit(vi.fn().mockRejectedValue(error));
    const { result } = renderHook(() => useTxFlow());

    await act(async () => {
      await result.current.run(client, "withdraw" as never, input);
    });

    expect(result.current.state).toEqual({ stage: "failed", failedAt, message: kind });
    expect(result.current.busy).toBe(false);
  });

  it("fails predictably when confirmation times out", async () => {
    vi.useFakeTimers();
    const client = clientWithSubmit(vi.fn(() => new Promise(() => undefined)));
    const { result } = renderHook(() => useTxFlow());

    let run!: Promise<void>;
    act(() => {
      run = result.current.run(client, "deposit" as never, input, { timeoutMs: 50 });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
      await run;
    });

    expect(result.current.state).toMatchObject({
      stage: "failed",
      failedAt: "confirming",
      message: "Transaction confirmation timed out",
    });
    vi.useRealTimers();
  });

  it("ignores duplicate submissions while a transaction is active", async () => {
    let resolve!: (value: { txHash: string }) => void;
    const submitAction = vi.fn(() => new Promise<{ txHash: string }>((done) => { resolve = done; }));
    const client = clientWithSubmit(submitAction as VaultContractClient["submitAction"]);
    const { result } = renderHook(() => useTxFlow());

    let first!: Promise<void>;
    await act(async () => {
      first = result.current.run(client, "deposit" as never, input, { indexingDelayMs: 0 });
      await result.current.run(client, "deposit" as never, input, { indexingDelayMs: 0 });
    });
    expect(submitAction).toHaveBeenCalledOnce();

    await act(async () => {
      resolve({ txHash: "tx-once" });
      await first;
    });
    expect(result.current.state).toEqual({ stage: "success", txHash: "tx-once" });
  });

  it("allows a retry after a recoverable failure without duplicating records", async () => {
    const submitAction = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("RPC unavailable"), { kind: "rpc_failure" }))
      .mockResolvedValueOnce({ txHash: "tx-retry" });
    const client = clientWithSubmit(submitAction);
    const { result } = renderHook(() => useTxFlow());

    await act(async () => {
      await result.current.run(client, "withdraw" as never, input);
    });
    expect(result.current.state.stage).toBe("failed");

    await act(async () => {
      await result.current.run(client, "withdraw" as never, input, { indexingDelayMs: 0 });
    });

    expect(submitAction).toHaveBeenCalledTimes(2);
    expect(result.current.state).toEqual({ stage: "success", txHash: "tx-retry" });
  });

  it("does not reset an active transaction", async () => {
    let resolve!: (value: { txHash: string }) => void;
    const client = clientWithSubmit(vi.fn(() => new Promise((done) => { resolve = done; })) as never);
    const { result } = renderHook(() => useTxFlow());

    let run!: Promise<void>;
    act(() => {
      run = result.current.run(client, "deposit" as never, input, { indexingDelayMs: 0 });
      result.current.reset();
    });
    expect(result.current.state.stage).not.toBe("idle");

    await act(async () => {
      resolve({ txHash: "tx-finished" });
      await run;
    });
  });
});

describe("mapTxError", () => {
  it("keeps unknown/reverted errors at confirmation", () => {
    expect(mapTxError(new Error("reverted"))).toEqual({
      failedAt: "confirming",
      message: "reverted",
    });
  });
});
