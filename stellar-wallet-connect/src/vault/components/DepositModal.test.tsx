import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createMockVaultClient, SAMPLE_ADDRESS } from "../contract/mockClient";
import { ContractInterfaceError, type PoolActionResult, type PoolSummary } from "../contract/types";
import { DepositModal } from "./DepositModal";

const pool: PoolSummary = {
  id: "pool-1",
  name: "Weekly USDC",
  status: "open",
  tvl: "1000000000",
  asset: "USDC",
  participantCount: 10,
  expectedYield: "5.2% APY",
  prize: "100 USDC",
  opensAt: "2026-07-01T00:00:00Z",
  locksAt: "2026-07-31T00:00:00Z",
  drawsAt: "2026-08-01T00:00:00Z",
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function enterReview(amount = "10") {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Amount"), amount);
  await user.click(screen.getByRole("button", { name: "Continue" }));
  return user;
}

describe("DepositModal transaction states", () => {
  it("shows a pending wallet state and then confirmed success", async () => {
    const submission = deferred<PoolActionResult>();
    const client = createMockVaultClient();
    const submit = vi.spyOn(client, "submitAction").mockImplementation(() => submission.promise);
    const onClose = vi.fn();

    render(
      <DepositModal
        pool={pool}
        walletBalance="100"
        onClose={onClose}
        onDeposit={async (amount) => {
          await client.submitAction("drip", {
            poolId: pool.id,
            walletAddress: SAMPLE_ADDRESS,
            amount,
          });
        }}
      />,
    );

    const user = await enterReview();
    await user.click(screen.getByRole("button", { name: "Confirm deposit" }));

    expect(await screen.findByText("Broadcasting deposit...")).toBeInTheDocument();
    expect(screen.getByText("Waiting for wallet confirmation")).toBeInTheDocument();
    expect(submit).toHaveBeenCalledTimes(1);

    submission.resolve({ txHash: "tx-deposit", status: "submitted" });

    expect(await screen.findByText("Deposit successful!")).toBeInTheDocument();
    expect(screen.getByText(/10 USDC/)).toBeInTheDocument();
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("surfaces wallet rejection and retries without a duplicate submission", async () => {
    const client = createMockVaultClient();
    const submit = vi
      .spyOn(client, "submitAction")
      .mockRejectedValueOnce(
        new ContractInterfaceError("signature_rejected", "Request rejected in wallet. No funds were moved."),
      )
      .mockResolvedValueOnce({ txHash: "tx-deposit-retry", status: "submitted" });

    render(
      <DepositModal
        pool={pool}
        walletBalance="100"
        onClose={vi.fn()}
        onDeposit={async (amount) => {
          await client.submitAction("drip", {
            poolId: pool.id,
            walletAddress: SAMPLE_ADDRESS,
            amount,
          });
        }}
      />,
    );

    const user = await enterReview("15");
    await user.click(screen.getByRole("button", { name: "Confirm deposit" }));

    expect(await screen.findByText("Request rejected in wallet. No funds were moved.")).toBeInTheDocument();
    expect(submit).toHaveBeenCalledTimes(1);

    // The failed request returns to review with the same amount. One explicit
    // retry creates exactly one additional wallet submission.
    await user.click(screen.getByRole("button", { name: "Confirm deposit" }));

    expect(await screen.findByText("Deposit successful!")).toBeInTheDocument();
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit).toHaveBeenLastCalledWith(
      "drip",
      expect.objectContaining({ amount: "15", poolId: pool.id }),
    );
  });

  it.each([
    ["rpc_failure", "Stellar RPC is unavailable."],
    ["contract_error", "Transaction reverted by the contract."],
    ["stale_data", "Confirmation timed out. Try again safely."],
  ] as const)("renders %s failures clearly", async (kind, message) => {
    const client = createMockVaultClient();
    vi.spyOn(client, "submitAction").mockRejectedValue(new ContractInterfaceError(kind, message));

    render(
      <DepositModal
        pool={pool}
        walletBalance="100"
        onClose={vi.fn()}
        onDeposit={async (amount) => {
          await client.submitAction("drip", {
            poolId: pool.id,
            walletAddress: SAMPLE_ADDRESS,
            amount,
          });
        }}
      />,
    );

    const user = await enterReview();
    await user.click(screen.getByRole("button", { name: "Confirm deposit" }));

    await waitFor(() => expect(screen.getByText(message)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Confirm deposit" })).toBeEnabled();
  });
});
