import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "../../tests/test-utils";
import WithdrawalEligibilityPanel from "./WithdrawalEligibilityPanel";

describe("WithdrawalEligibilityPanel", () => {
  const activePosition = {
    principal: "500.00",
    rewards: "25.50",
    lockEndsAt: new Date(Date.now() - 10000).toISOString(),
    poolStatus: "open",
    pendingActions: false,
    alreadyWithdrawn: false,
    asset: "USDC",
  };

  it("renders withdrawable principal and rewards separately for an active unlocked position", () => {
    render(<WithdrawalEligibilityPanel position={activePosition} />);

    expect(screen.getByTestId("eligible-banner")).toBeInTheDocument();
    expect(screen.getByText("500.00")).toBeInTheDocument();
    expect(screen.getByText("25.50")).toBeInTheDocument();
    expect(screen.getByText("525.50")).toBeInTheDocument();
  });

  it("handles matured pools as fully eligible", () => {
    const maturedPosition = {
      ...activePosition,
      poolStatus: "matured",
      lockEndsAt: new Date(Date.now() + 86400000).toISOString(),
    };

    render(<WithdrawalEligibilityPanel position={maturedPosition} />);
    expect(screen.getByTestId("eligible-banner")).toBeInTheDocument();
  });

  it("displays clear reason when pool is paused", () => {
    const pausedPosition = {
      ...activePosition,
      poolStatus: "paused",
    };

    render(<WithdrawalEligibilityPanel position={pausedPosition} />);
    expect(screen.getByTestId("ineligible-banner")).toBeInTheDocument();
    expect(screen.getByText(/Vault pool operations are currently paused/i)).toBeInTheDocument();
    expect(screen.getByTestId("withdraw-submit-btn")).toBeDisabled();
  });

  it("displays clear reason when position is already withdrawn", () => {
    const withdrawnPosition = {
      ...activePosition,
      alreadyWithdrawn: true,
      principal: "0.00",
      rewards: "0.00",
    };

    render(<WithdrawalEligibilityPanel position={withdrawnPosition} />);
    expect(screen.getByTestId("ineligible-banner")).toBeInTheDocument();
    expect(screen.getByText(/Position has already been fully withdrawn/i)).toBeInTheDocument();
  });

  it("displays locked status and remaining lock period reason when locked", () => {
    const lockedPosition = {
      ...activePosition,
      lockEndsAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
    };

    render(<WithdrawalEligibilityPanel position={lockedPosition} />);
    expect(screen.getByTestId("ineligible-banner")).toBeInTheDocument();
    expect(screen.getByText(/Position locked for/i)).toBeInTheDocument();
  });

  it("triggers onRefresh callback when refresh button is clicked", () => {
    const onRefreshMock = vi.fn();
    render(<WithdrawalEligibilityPanel position={activePosition} onRefresh={onRefreshMock} />);

    fireEvent.click(screen.getByTestId("refresh-eligibility-btn"));
    expect(onRefreshMock).toHaveBeenCalledTimes(1);
  });
});
