import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { RewardHistory } from "./RewardHistory";
import type { RewardHistoryEntry } from "../contract/types";

const entries: RewardHistoryEntry[] = [
  {
    id: "r1",
    poolId: "pool-1",
    poolName: "Weekly USDC",
    cycleEndedAt: "2026-05-09T00:00:00Z",
    rewardAmount: "42",
    asset: "USDC",
    status: "won",
    winnerAddress: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    txHash: "txhash123456789",
  },
];

describe("RewardHistory", () => {
  it("prompts to connect when the wallet is disconnected", () => {
    render(<RewardHistory entries={null} walletConnected={false} />);
    expect(screen.getByText(/wallet not connected/i)).toBeInTheDocument();
  });

  it("shows a loading state", () => {
    render(<RewardHistory entries={null} loading />);
    expect(screen.getAllByText(/loading reward history/i).length).toBeGreaterThan(0);
  });

  it("shows an empty state when there are no completed cycles", () => {
    render(<RewardHistory entries={[]} />);
    expect(screen.getByText(/no completed cycles yet/i)).toBeInTheDocument();
  });

  it("shows an error state with a retry affordance", () => {
    render(<RewardHistory entries={null} error="boom" onRetry={() => {}} />);
    expect(screen.getByText(/couldn't load reward history/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });

  it("renders rows with truncated winner address and an explorer link", () => {
    render(<RewardHistory entries={entries} />);
    expect(screen.getAllByText("Weekly USDC").length).toBeGreaterThan(0);
    // Truncated, privacy-aware address (never the full string).
    expect(screen.getAllByText("GBBD47…FLA5").length).toBeGreaterThan(0);
    expect(screen.queryByText(entries[0].winnerAddress as string)).not.toBeInTheDocument();
    const links = screen.getAllByRole("link");
    expect(links[0]).toHaveAttribute("href", expect.stringContaining("/tx/txhash123456789"));
  });

  describe("uneconomical claim warning (#644)", () => {
    it("shows a warning badge for a small XLM reward below the estimated claim fee", () => {
      const smallReward: RewardHistoryEntry[] = [
        {
          id: "r-small",
          poolId: "pool-1",
          poolName: "XLM Drip",
          cycleEndedAt: "2026-05-09T00:00:00Z",
          rewardAmount: "0.001",
          asset: "XLM",
          status: "won",
          winnerAddress: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
          txHash: null,
        },
      ];
      render(<RewardHistory entries={smallReward} onClaim={() => {}} />);
      expect(screen.getAllByText(/may cost more to claim/i).length).toBeGreaterThan(0);
    });

    it("shows no warning badge for a normal-sized XLM reward", () => {
      const normalReward: RewardHistoryEntry[] = [
        {
          id: "r-normal",
          poolId: "pool-1",
          poolName: "XLM Drip",
          cycleEndedAt: "2026-05-09T00:00:00Z",
          rewardAmount: "42",
          asset: "XLM",
          status: "won",
          winnerAddress: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
          txHash: null,
        },
      ];
      render(<RewardHistory entries={normalReward} onClaim={() => {}} />);
      expect(screen.queryByText(/may cost more to claim/i)).not.toBeInTheDocument();
    });

    it("does not warn on a small non-XLM reward (no cross-asset fee comparison)", () => {
      const smallUsdcReward: RewardHistoryEntry[] = [
        {
          id: "r-small-usdc",
          poolId: "pool-1",
          poolName: "USDC Drip",
          cycleEndedAt: "2026-05-09T00:00:00Z",
          rewardAmount: "0.001",
          asset: "USDC",
          status: "won",
          winnerAddress: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
          txHash: null,
        },
      ];
      render(<RewardHistory entries={smallUsdcReward} onClaim={() => {}} />);
      expect(screen.queryByText(/may cost more to claim/i)).not.toBeInTheDocument();
    });

    it("does not warn on a zero-amount reward", () => {
      const zeroReward: RewardHistoryEntry[] = [
        {
          id: "r-zero",
          poolId: "pool-1",
          poolName: "XLM Drip",
          cycleEndedAt: "2026-05-09T00:00:00Z",
          rewardAmount: "0",
          asset: "XLM",
          status: "no_win",
          winnerAddress: null,
          txHash: null,
        },
      ];
      render(<RewardHistory entries={zeroReward} />);
      expect(screen.queryByText(/may cost more to claim/i)).not.toBeInTheDocument();
    });
  });
});
