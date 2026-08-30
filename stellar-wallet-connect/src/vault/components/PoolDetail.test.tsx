import { describe, it, expect, vi } from "vitest";
import { act } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PoolDetail, availableActions } from "./PoolDetail";
import { ONBOARDING_STORAGE_KEY } from "./OnboardingChecklist";
import type { PoolSummary, UserPosition } from "../contract/types";

const basePool: PoolSummary = {
  id: "pool-1",
  name: "Weekly USDC",
  status: "open",
  tvl: "10000",
  asset: "USDC",
  participantCount: 12,
  expectedYield: "5.2% APY",
  prize: "120 USDC",
  opensAt: "2026-05-01T00:00:00Z",
  locksAt: "2026-05-08T00:00:00Z",
  drawsAt: "2026-05-09T00:00:00Z",
};

const joined: UserPosition = {
  walletAddress: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  deposited: "500",
  shares: "500",
  joined: true,
};

describe("availableActions", () => {
  it("offers join when open and not joined", () => {
    expect(availableActions(basePool, null)).toEqual(["join"]);
  });
  it("offers drip and withdraw when open and joined", () => {
    expect(availableActions(basePool, joined)).toEqual(["drip", "withdraw"]);
  });
  it("offers claim and withdraw when settled and joined", () => {
    expect(availableActions({ ...basePool, status: "settled" }, joined)).toEqual(["claim", "withdraw"]);
  });
  it("offers nothing while drawing", () => {
    expect(availableActions({ ...basePool, status: "drawing" }, joined)).toEqual([]);
  });

  it("blocks join while the pool is in emergency pause", () => {
    expect(availableActions({ ...basePool, isEmergency: true }, null)).toEqual([]);
  });

  it("blocks drip but keeps withdraw while the pool is in emergency pause", () => {
    expect(availableActions({ ...basePool, isEmergency: true }, joined)).toEqual(["withdraw"]);
  });

  it("keeps claim and withdraw available when settled and paused", () => {
    expect(
      availableActions({ ...basePool, status: "settled", isEmergency: true }, joined)
    ).toEqual(["claim", "withdraw"]);
  });
});

describe("PoolDetail", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("shows a loading state before data arrives", () => {
    render(<PoolDetail pool={null} loading />);
    expect(screen.getAllByText(/loading pool/i).length).toBeGreaterThan(0);
  });

  it("renders overview stats and status", () => {
    render(<PoolDetail pool={basePool} />);
    expect(screen.getByRole("heading", { name: "Weekly USDC" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /first-time wallet checklist/i })).toBeInTheDocument();
    expect(screen.getByText("Open")).toBeInTheDocument();
    expect(screen.getByText("10,000 USDC")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
  });

  it("dismisses and reopens onboarding guidance", async () => {
    const user = userEvent.setup();
    render(<PoolDetail pool={basePool} />);
    await act(async () => {
      await user.click(screen.getByRole("button", { name: /got it/i }));
    });
    await waitFor(() => {
      expect(localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBe("true");
    });
    expect(screen.getByRole("button", { name: /onboarding checklist/i })).toBeInTheDocument();

    await act(async () => {
      await user.click(screen.getByRole("button", { name: /onboarding checklist/i }));
    });
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /first-time wallet checklist/i })).toBeInTheDocument();
      expect(localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBe("false");
    });
  });

  it("prompts to connect for the position when wallet is disconnected", () => {
    render(<PoolDetail pool={basePool} walletConnected={false} />);
    expect(screen.getByText(/wallet not connected/i)).toBeInTheDocument();
  });

  it("shows the user's position when joined", () => {
    render(<PoolDetail pool={basePool} position={joined} />);
    expect(screen.getByText("Your position")).toBeInTheDocument();
    expect(screen.getByText("GBBD47…FLA5")).toBeInTheDocument();
  });

  it("fires onAction when an action button is clicked", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    render(<PoolDetail pool={basePool} position={null} onAction={onAction} />);
    await act(async () => {
      await user.click(screen.getByRole("button", { name: /join pool/i }));
    });
    expect(onAction).toHaveBeenCalledWith("join");
  });

  it("renders an error state with retry", () => {
    render(<PoolDetail pool={null} error="nope" onRetry={() => {}} />);
    expect(screen.getByText(/couldn't load pool/i)).toBeInTheDocument();
  });

  it("does not show a pause banner or hide actions for a non-paused pool", () => {
    render(<PoolDetail pool={basePool} position={null} />);
    expect(screen.queryByText(/pool paused for recovery/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /join pool/i })).toBeInTheDocument();
  });

  it("shows a pause banner and hides join when the pool is in emergency mode", () => {
    render(<PoolDetail pool={{ ...basePool, isEmergency: true }} position={null} />);
    expect(screen.getByText(/pool paused for recovery/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /join pool/i })).not.toBeInTheDocument();
  });

  it("still shows withdraw (not gated on-chain) when paused and joined", () => {
    render(<PoolDetail pool={{ ...basePool, isEmergency: true }} position={joined} />);
    expect(screen.getByText(/pool paused for recovery/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /withdraw/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /add deposit/i })).not.toBeInTheDocument();
  });
});
