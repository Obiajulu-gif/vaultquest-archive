import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createMockVaultClient, SAMPLE_ADDRESS } from "../contract/mockClient";
import {
  ContractInterfaceError,
  type PoolActionResult,
  type PoolSummary,
  type UserPosition,
} from "../contract/types";
import { WithdrawalModal } from "./WithdrawalModal";

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

const position: UserPosition = {
  walletAddress: SAMPLE_ADDRESS,
  deposited: "80",
  shares: "80",
  joined: true,
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function enterReview(amount = "20") {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Amount"), amount);
  await user.click(screen.getByRole("button", { name: "Continue" }));
  return user;
}

describe("WithdrawalModal transaction states", () => {
  it("shows pending confirmation and a confirmed withdrawal summary", async () => {
    const submission = deferred<PoolActionResult>();
    const client = createMockVaultClient();
    const submit = vi.spyOn(client, "submitAction").mockImplementation(() => submission.promise);

    render(
      <WithdrawalModal
        pool={pool}
        position={position}
        onClose={vi.fn()}
        onWithdraw={async (amount) => {
          await client.submitAction("withdraw", {
            poolId: pool.id,
            walletAddress: SAMPLE_ADDRESS,
            amount,
          });
        }}
      />,
    );

    const user = await enterReview();
    await user.click(screen.getByRole("button", { name: "Confirm withdrawal" }));

    expect(await screen.findByText("Broadcasting withdrawal...")).toBeInTheDocument();
    expect(screen.getByText("Waiting for wallet confirmation")).toBeInTheDocument();
    expect(submit).toHaveBeenCalledTimes(1);

    submission.resolve({ txHash: "tx-withdraw", status: "submitted" });

    expect(await screen.findByText("Withdrawal successful!")).toBeInTheDocument();
    expect(screen.getByText("Confirmed")).toBeInTheDocument();
    expect(screen.getByText(/60 USDC/)).toBeInTheDocument();
  });

  it("shows a reverted transaction and allows one safe retry", async () => {
    const client = createMockVaultClient();
    const submit = vi
      .spyOn(client, "submitAction")
      .mockRejectedValueOnce(
        new ContractInterfaceError("contract_error", "Withdrawal reverted; your position is unchanged."),
      )
      .mockResolvedValueOnce({ txHash: "tx-withdraw-retry", status: "submitted" });

    render(
      <WithdrawalModal
        pool={pool}
        position={position}
        onClose={vi.fn()}
        onWithdraw={async (amount) => {
          await client.submitAction("withdraw", {
            poolId: pool.id,
            walletAddress: SAMPLE_ADDRESS,
            amount,
          });
        }}
      />,
    );

    const user = await enterReview("30");
    await user.click(screen.getByRole("button", { name: "Confirm withdrawal" }));

    expect(await screen.findByText("Withdrawal reverted; your position is unchanged.")).toBeInTheDocument();
    expect(submit).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Confirm withdrawal" }));

    expect(await screen.findByText("Withdrawal successful!")).toBeInTheDocument();
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit).toHaveBeenLastCalledWith(
      "withdraw",
      expect.objectContaining({ amount: "30", poolId: pool.id }),
    );
  });

  it.each([
    ["signature_rejected", "Withdrawal rejected in wallet."],
    ["rpc_failure", "RPC submission failed."],
    ["stale_data", "Withdrawal confirmation timed out."],
  ] as const)("renders %s failures and preserves the entered amount", async (kind, message) => {
    const client = createMockVaultClient();
    vi.spyOn(client, "submitAction").mockRejectedValue(new ContractInterfaceError(kind, message));

    render(
      <WithdrawalModal
        pool={pool}
        position={position}
        onClose={vi.fn()}
        onWithdraw={async (amount) => {
          await client.submitAction("withdraw", {
            poolId: pool.id,
            walletAddress: SAMPLE_ADDRESS,
            amount,
          });
        }}
      />,
    );

    const user = await enterReview("12");
    await user.click(screen.getByRole("button", { name: "Confirm withdrawal" }));

    await waitFor(() => expect(screen.getByText(message)).toBeInTheDocument());
    expect(screen.getByText(/12 USDC/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm withdrawal" })).toBeEnabled();
  });
});

describe("WithdrawalModal lockup and liquidity error mapping (#620)", () => {
  it("distinguishes a lockup-active rejection from a generic failure", async () => {
    const client = createMockVaultClient();
    vi.spyOn(client, "submitAction").mockRejectedValue(
      new ContractInterfaceError("lockup_active", "Withdrawal before lockup ends."),
    );

    render(
      <WithdrawalModal
        pool={pool}
        position={position}
        onClose={vi.fn()}
        onWithdraw={async (amount) => {
          await client.submitAction("withdraw", {
            poolId: pool.id,
            walletAddress: SAMPLE_ADDRESS,
            amount,
          });
        }}
      />,
    );

    const user = await enterReview("12");
    await user.click(screen.getByRole("button", { name: "Confirm withdrawal" }));

    // Distinct heading/copy on the review step — not the generic
    // "Transaction failed" text shared by every other error kind.
    expect(await screen.findByText("Still in lockup")).toBeInTheDocument();
    expect(screen.queryByText("Transaction failed")).not.toBeInTheDocument();
    expect(
      screen.getByText(/still within its lockup period and can't be withdrawn yet/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Withdrawal before lockup ends\./)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm withdrawal" })).toBeEnabled();
  });

  it("distinguishes an insufficient-liquidity rejection from a generic failure", async () => {
    const client = createMockVaultClient();
    vi.spyOn(client, "submitAction").mockRejectedValue(
      new ContractInterfaceError("insufficient_liquidity", "Not enough idle liquidity; request queued."),
    );

    render(
      <WithdrawalModal
        pool={pool}
        position={position}
        onClose={vi.fn()}
        onWithdraw={async (amount) => {
          await client.submitAction("withdraw", {
            poolId: pool.id,
            walletAddress: SAMPLE_ADDRESS,
            amount,
          });
        }}
      />,
    );

    const user = await enterReview("12");
    await user.click(screen.getByRole("button", { name: "Confirm withdrawal" }));

    expect(await screen.findByText("Withdrawal queued")).toBeInTheDocument();
    expect(screen.queryByText("Transaction failed")).not.toBeInTheDocument();
    expect(
      screen.getByText(/doesn't have enough available liquidity to settle this withdrawal immediately/),
    ).toBeInTheDocument();
  });

  it("still shows the generic failure state for a plain contract_error", async () => {
    const client = createMockVaultClient();
    vi.spyOn(client, "submitAction").mockRejectedValue(
      new ContractInterfaceError("contract_error", "Transaction reverted by the contract."),
    );

    render(
      <WithdrawalModal
        pool={pool}
        position={position}
        onClose={vi.fn()}
        onWithdraw={async (amount) => {
          await client.submitAction("withdraw", {
            poolId: pool.id,
            walletAddress: SAMPLE_ADDRESS,
            amount,
          });
        }}
      />,
    );

    const user = await enterReview("12");
    await user.click(screen.getByRole("button", { name: "Confirm withdrawal" }));

    // Generic errors keep the plain, undifferentiated review-step message —
    // no lockup/queued framing gets applied to a real contract revert.
    expect(await screen.findByText("Transaction reverted by the contract.")).toBeInTheDocument();
    expect(screen.queryByText("Still in lockup")).not.toBeInTheDocument();
    expect(screen.queryByText("Withdrawal queued")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm withdrawal" })).toBeEnabled();
  });
});
