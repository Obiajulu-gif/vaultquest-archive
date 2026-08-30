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

describe("DepositModal pool data freshness (#619)", () => {
  it("refreshes pool/balance state before showing the review step when onRefreshBalance is provided", async () => {
    const refresh = deferred<void>();
    const onRefreshBalance = vi.fn(() => refresh.promise);
    const user = userEvent.setup();

    render(
      <DepositModal
        pool={pool}
        walletBalance="100"
        onClose={vi.fn()}
        onRefreshBalance={onRefreshBalance}
        onDeposit={vi.fn()}
      />,
    );

    await user.type(screen.getByLabelText("Amount"), "10");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    // Refresh is in flight: still on the input step, Continue shows a
    // refreshing state, and the review step has not been rendered yet.
    expect(onRefreshBalance).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("button", { name: "Refreshing pool data..." })).toBeDisabled();
    expect(screen.queryByText("Win chance change")).not.toBeInTheDocument();

    refresh.resolve();

    // Once the refresh resolves, the review step renders using the
    // (now-current) pool data.
    expect(await screen.findByText("Win chance change")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm deposit" })).toBeInTheDocument();
  });

  it("does not attempt a refresh before review when onRefreshBalance is not provided", async () => {
    const user = userEvent.setup();

    render(
      <DepositModal
        pool={pool}
        walletBalance="100"
        onClose={vi.fn()}
        onDeposit={vi.fn()}
      />,
    );

    await user.type(screen.getByLabelText("Amount"), "10");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByText("Win chance change")).toBeInTheDocument();
  });
});

describe("DepositModal deposit concentration limits (#643)", () => {
  it("previews remaining per-wallet and pool capacity before signing", async () => {
    const cappedPool: PoolSummary = { ...pool, maxWalletDeposit: "500", maxPoolDeposit: "10000" };
    render(
      <DepositModal
        pool={cappedPool}
        walletBalance="1000"
        walletDeposited="300"
        onClose={vi.fn()}
        onDeposit={vi.fn()}
      />,
    );

    const preview = await screen.findByTestId("deposit-capacity-preview");
    expect(preview).toHaveTextContent("Your remaining limit");
    expect(preview).toHaveTextContent("200"); // 500 wallet cap - 300 already deposited
    expect(preview).toHaveTextContent("Pool remaining capacity");
  });

  it("does not render a capacity preview for an uncapped pool", () => {
    render(
      <DepositModal pool={pool} walletBalance="1000" onClose={vi.fn()} onDeposit={vi.fn()} />,
    );
    expect(screen.queryByTestId("deposit-capacity-preview")).not.toBeInTheDocument();
  });

  it("disables Continue and explains the per-wallet limit when the amount exceeds it", async () => {
    const cappedPool: PoolSummary = { ...pool, maxWalletDeposit: "500" };
    const onDeposit = vi.fn();
    render(
      <DepositModal
        pool={cappedPool}
        walletBalance="1000"
        walletDeposited="300"
        onClose={vi.fn()}
        onDeposit={onDeposit}
      />,
    );

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Amount"), "250"); // 300 + 250 = 550 > 500 cap

    expect(await screen.findByText(/Amount exceeds your per-wallet limit/)).toBeInTheDocument();
    const continueButton = screen.getByRole("button", { name: "Continue" });
    expect(continueButton).toBeDisabled();

    // Clicking a disabled button is a no-op — confirms this isn't merely a
    // visual-only disabled state.
    await user.click(continueButton);
    expect(screen.queryByText("Pool")).not.toBeInTheDocument(); // never reached the review step
    expect(onDeposit).not.toHaveBeenCalled();
  });

  it("disables Continue and explains the pool limit when the amount exceeds it", async () => {
    const cappedPool: PoolSummary = { ...pool, maxPoolDeposit: "1000000000", remainingPoolCapacity: "50" };
    const onDeposit = vi.fn();
    render(
      <DepositModal pool={cappedPool} walletBalance="1000" onClose={vi.fn()} onDeposit={onDeposit} />,
    );

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Amount"), "60");

    expect(await screen.findByText(/Amount exceeds this pool's remaining capacity/)).toBeInTheDocument();
    const continueButton = screen.getByRole("button", { name: "Continue" });
    expect(continueButton).toBeDisabled();

    await user.click(continueButton);
    expect(onDeposit).not.toHaveBeenCalled();
  });

  it("allows Continue at exactly the remaining wallet capacity", async () => {
    const cappedPool: PoolSummary = { ...pool, maxWalletDeposit: "500" };
    render(
      <DepositModal
        pool={cappedPool}
        walletBalance="1000"
        walletDeposited="300"
        onClose={vi.fn()}
        onDeposit={vi.fn()}
      />,
    );

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Amount"), "200"); // exactly the remaining 200
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByText("Pool")).toBeInTheDocument(); // reached the review step
  });

  it("'Max' fills in the tightest of balance, wallet cap, and pool cap", async () => {
    const cappedPool: PoolSummary = { ...pool, maxWalletDeposit: "500", remainingPoolCapacity: "120" };
    render(
      <DepositModal
        pool={cappedPool}
        walletBalance="1000" // balance headroom: 999.5
        walletDeposited="300" // wallet headroom: 200
        onClose={vi.fn()}
        onDeposit={vi.fn()}
      />,
    );

    const user = userEvent.setup();
    // Pool capacity (120) is the tightest constraint of the three.
    await user.click(screen.getByRole("button", { name: "Max" }));
    expect(screen.getByLabelText("Amount")).toHaveValue(120);
  });

  it("still surfaces a contract-level cap rejection even if the client-side preview missed it", async () => {
    // Simulates a pool with no cap metadata provided to the UI (e.g. a
    // backend that hasn't been updated yet) but where the contract itself
    // enforces a cap — the authoritative on-chain rejection must still
    // surface clearly, since the client-side preview is an optimization,
    // not the source of truth.
    const client = createMockVaultClient();
    vi.spyOn(client, "submitAction").mockRejectedValue(
      new ContractInterfaceError("contract_error", "Transaction reverted by the contract."),
    );

    render(
      <DepositModal
        pool={pool} // no maxWalletDeposit/maxPoolDeposit set
        walletBalance="1000000"
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

    const user = await enterReview("999999");
    await user.click(screen.getByRole("button", { name: "Confirm deposit" }));

    await waitFor(() =>
      expect(screen.getByText("Transaction reverted by the contract.")).toBeInTheDocument(),
    );
  });
});
