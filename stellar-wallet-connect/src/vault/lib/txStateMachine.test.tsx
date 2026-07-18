import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useTxFlow } from "./txStateMachine";
import type { VaultContractClient } from "../contract/types";

const input = { poolId: "pool-1", amount: "100" } as never;

function clientWith(submitAction: VaultContractClient["submitAction"]): VaultContractClient {
  return { submitAction } as VaultContractClient;
}

describe("useTxFlow", () => {
  it("moves a successful deposit through confirmation to success", async () => {
    vi.useFakeTimers();
    const onConfirmed = vi.fn();
    const client = clientWith(vi.fn().mockResolvedValue({ txHash: "tx-success" }));
    const { result } = renderHook(() => useTxFlow());

    let run!: Promise<void>;
    act(() => {
      run = result.current.run(client, "deposit", input, { onConfirmed, indexingDelayMs: 10 });
    });
    await act(async () => { await vi.runAllTimersAsync(); await run; });

    expect(result.current.state).toEqual({ stage: "success", txHash: "tx-success" });
    expect(onConfirmed).toHaveBeenCalledOnce();
    expect(onConfirmed).toHaveBeenCalledWith("tx-success");
    vi.useRealTimers();
  });

  it.each([
    ["signature_rejected", "awaiting-signature"],
    ["wallet_disconnected", "awaiting-signature"],
    ["rpc_failure", "submitting"],
    ["contract_error", "submitting"],
  ])("maps %s failures to %s", async (kind, failedAt) => {
    const error = Object.assign(new Error(kind), { kind });
    const client = clientWith(vi.fn().mockRejectedValue(error));
    const { result } = renderHook(() => useTxFlow());

    await act(async () => { await result.current.run(client, "withdraw", input); });

    expect(result.current.state).toEqual({ stage: "failed", failedAt, message: kind });
    expect(result.current.busy).toBe(false);
  });

  it("allows retry after a recoverable failure without duplicating submissions", async () => {
    const submitAction = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("temporary RPC failure"), { kind: "rpc_failure" }))
      .mockResolvedValueOnce({ txHash: "tx-retry" });
    const client = clientWith(submitAction);
    const { result } = renderHook(() => useTxFlow());

    await act(async () => { await result.current.run(client, "deposit", input); });
    expect(result.current.state.stage).toBe("failed");

    await act(async () => { await result.current.run(client, "deposit", input, { indexingDelayMs: 0 }); });
    expect(result.current.state).toEqual({ stage: "success", txHash: "tx-retry" });
    expect(submitAction).toHaveBeenCalledTimes(2);
  });

  it("resets terminal state to idle", async () => {
    const client = clientWith(vi.fn().mockRejectedValue(new Error("confirmation timeout")));
    const { result } = renderHook(() => useTxFlow());
    await act(async () => { await result.current.run(client, "withdraw", input); });
    act(() => result.current.reset());
    expect(result.current.state).toEqual({ stage: "idle" });
  });
});
