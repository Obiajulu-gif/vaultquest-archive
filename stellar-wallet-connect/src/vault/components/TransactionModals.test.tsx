import { act } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DepositModal } from "./DepositModal";
import { WithdrawalModal } from "./WithdrawalModal";
import type { PoolSummary, UserPosition } from "../contract/types";

const pool: PoolSummary = {
  id: "pool-1",
  name: "Weekly USDC",
  status: "open",
  tvl: "10000000000",
  asset: "USDC",
  participantCount: 8,
  expectedYield: "5.2% APY",
  prize: "500 USDC",
  opensAt: "2026-07-01T00:00:00.000Z",
  locksAt: "2026-07-31T00:00:00.000Z",
  drawsAt: "2026-08-01T00:00:00.000Z",
};

const position: UserPosition = {
  walletAddress: "GTESTWALLET",
  deposited: "100",
  shares: "100",
  joined: true,
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

async function reviewDeposit(user: ReturnType<typeof userEvent.setup>, amount = "25") {
  await user.type(screen.getByLabelText("Amount"), amount);
  await user.click(screen.getByRole("button", { name: "Continue" }));
  expect(screen.getByRole("button", { name: /confirm deposit/i })).toBeInTheDocument();
}

async function reviewWithdrawal(user: ReturnType<typeof userEvent.setup>, amount = "25") {
  await user.type(screen.getByLabelText("Amount"), amount);
  await user.click(screen.getByRole("button", { name: "Continue" }));
  expect(screen.getByRole("button", { name: /confirm withdrawal/i })).toBeInTheDocument();
}

describe("DepositModal transaction states", () => {
  it("shows pending confirmation and then the confirmed state", async () => {
    const user = userEvent.setup();
    const pending = deferred<void>();
    const onDeposit = vi.fn(() => pending.promise);
    render(<DepositModal pool={pool} walletBalance="250" onDeposit={onDeposit} onClose={vi.fn()} />);

    await reviewDeposit(user);
    await user.click(screen.getByRole("button", { name: /confirm deposit/i }));
    expect(screen.getByText(/broadcasting deposit/i)).toBeInTheDocument();
    expect(screen.getByText(/waiting for wallet confirmation/i)).toBeInTheDocument();

    await act(async () => pending.resolve());
    expect(await screen.findByText(/deposit successful/i)).toBeInTheDocument();
    expect(onDeposit).toHaveBeenCalledWith("25");
  });

  it("recovers from rejection without duplicating the local transaction record", async () => {
    const user = userEvent.setup();
    const localRecords: string[] = [];
    const onDeposit = vi
      .fn()
      .mockRejectedValueOnce(new Error("User rejected the wallet request"))
      .mockImplementationOnce(async (amount: string) => {
        localRecords.push(amount);
      });

    render(<DepositModal pool={pool} walletBalance="250" onDeposit={onDeposit} onClose={vi.fn()} />);
    await reviewDeposit(user);
    await user.click(screen.getByRole("button", { name: /confirm deposit/i }));
    expect(await screen.findByText(/user rejected the wallet request/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /confirm deposit/i }));
    expect(await screen.findByText(/deposit successful/i)).toBeInTheDocument();
    expect(onDeposit).toHaveBeenCalledTimes(2);
    expect(localRecords).toEqual(["25"]);
  });

  it("renders RPC timeout errors as recoverable review state", async () => {
    const user = userEvent.setup();
    const onDeposit = vi.fn().mockRejectedValue(new Error("Transaction confirmation timed out"));
    render(<DepositModal pool={pool} walletBalance="250" onDeposit={onDeposit} onClose={vi.fn()} />);

    await reviewDeposit(user);
    await user.click(screen.getByRole("button", { name: /confirm deposit/i }));
    expect(await screen.findByText(/transaction confirmation timed out/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /confirm deposit/i })).toBeInTheDocument();
  });
});

describe("WithdrawalModal transaction states", () => {
  it("shows pending and confirmed withdrawal states", async () => {
    const user = userEvent.setup();
    const pending = deferred<void>();
    const onWithdraw = vi.fn(() => pending.promise);
    render(<WithdrawalModal pool={pool} position={position} onWithdraw={onWithdraw} onClose={vi.fn()} />);

    await reviewWithdrawal(user);
    await user.click(screen.getByRole("button", { name: /confirm withdrawal/i }));
    expect(screen.getByText(/broadcasting withdrawal/i)).toBeInTheDocument();

    await act(async () => pending.resolve());
    expect(await screen.findByText(/withdrawal successful/i)).toBeInTheDocument();
    expect(screen.getByText("Confirmed")).toBeInTheDocument();
  });

  it("surfaces reverted failures and permits a single clean retry", async () => {
    const user = userEvent.setup();
    const localRecords: string[] = [];
    const onWithdraw = vi
      .fn()
      .mockRejectedValueOnce(new Error("Transaction reverted on-chain"))
      .mockImplementationOnce(async (amount: string) => {
        localRecords.push(amount);
      });

    render(<WithdrawalModal pool={pool} position={position} onWithdraw={onWithdraw} onClose={vi.fn()} />);
    await reviewWithdrawal(user);
    await user.click(screen.getByRole("button", { name: /confirm withdrawal/i }));
    expect(await screen.findByText(/transaction reverted on-chain/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /confirm withdrawal/i }));
    await waitFor(() => expect(screen.getByText(/withdrawal successful/i)).toBeInTheDocument());
    expect(localRecords).toEqual(["25"]);
  });
});
