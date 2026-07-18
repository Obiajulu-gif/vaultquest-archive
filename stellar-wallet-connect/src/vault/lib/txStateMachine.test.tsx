import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useTxFlow } from "./txStateMachine";
import type { VaultContractClient } from "../contract/types";

const input = { poolId: "pool-1", amount: "100" } as never;

function clientWith(result: Promise<{ txHash: string }>): VaultContractClient {
  return { submitAction: vi.fn(() => result) } as unknown as VaultContractClient;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("useTxFlow", () => {
  it.each(["deposit", "withdraw"] as const)(
    "moves %s through confirmation to success",
    async (actionType) => {
      vi.useFakeTimers();
      const client = clientWith(Promise.resolve({ txHash: "tx-123" }));
      const confirmed = vi.fn();
      const { result } = renderHook(() => useTxFlow());

      let run!: Promise<void>;
      act(() => {
        run = result.current.run(client, actionType, input, {
          onConfirmed: confirmed,
          indexingDelayMs: 25,
        });
      });
      await flush();

      expect(result.current.state).toEqual({ stage: "indexing", txHash: "tx-123" });
      expect(confirmed).toHaveBeenCalledOnce();
      expect(confirmed).toHaveBeenCalledWith("tx-123");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(25);
        await run;
      });
      expect(result.current.state).toEqual({ stage: "success", txHash: "tx-123" });
      expect(result.current.busy).toBe(false);
      vi.useRealTimers();
    },
  );

  it.each([
    ["signature_rejected", "awaiting-signature"],
    ["wallet_disconnected", "awaiting-signature"],
    ["rpc_failure", "submitting"],
    ["contract_error", "submitting"],
    ["timeout", "confirming"],
  ] as const)("maps %s failures to %s", async (kind, failedAt) => {
    const error = Object.assign(new Error(kind), { kind });
    const client = clientWith(Promise.reject(error));
    const { result } = renderHook(() => useTxFlow());

    await act(async () => {
      await result.current.run(client, "deposit", input, { indexingDelayMs: 0 });
    });

    expect(result.current.state).toEqual({ stage: "failed", failedAt, message: kind });
    expect(result.current.busy).toBe(false);
  });

  it("allows a retry after a recoverable failure without duplicating submission", async () => {
    const submitAction = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("rpc unavailable"), { kind: "rpc_failure" }))
      .mockResolvedValueOnce({ txHash: "tx-retry" });
    const client = { submitAction } as unknown as VaultContractClient;
    const { result } = renderHook(() => useTxFlow());

    await act(async () => {
      await result.current.run(client, "withdraw", input, { indexingDelayMs: 0 });
    });
    expect(result.current.state.stage).toBe("failed");

    await act(async () => {
      await result.current.run(client, "withdraw", input, { indexingDelayMs: 0 });
    });

    expect(result.current.state).toEqual({ stage: "success", txHash: "tx-retry" });
    expect(submitAction).toHaveBeenCalledTimes(2);
  });

  it("resets terminal state back to idle", async () => {
    const client = clientWith(Promise.resolve({ txHash: "tx-reset" }));
    const { result } = renderHook(() => useTxFlow());

    await act(async () => {
      await result.current.run(client, "deposit", input, { indexingDelayMs: 0 });
    });
    act(() => result.current.reset());

    expect(result.current.state).toEqual({ stage: "idle" });
    expect(result.current.busy).toBe(false);
  });
});
