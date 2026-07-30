import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "../../tests/test-utils";
import RewardProjectionPanel from "./RewardProjectionPanel";

describe("RewardProjectionPanel", () => {
  const mockProjection = {
    estimatedApy: "5.5%",
    estimatedReward: "125.00",
    confirmedReward: "50.00",
    poolDurationDays: 30,
    rateSource: "DeFi Yield Protocol",
    updatedAt: new Date().toISOString(),
    asset: "USDC",
  };

  it("renders projected and confirmed rewards with distinct visual indicators", () => {
    render(<RewardProjectionPanel projection={mockProjection} />);

    expect(screen.getByTestId("projected-card")).toBeInTheDocument();
    expect(screen.getByTestId("confirmed-card")).toBeInTheDocument();
    expect(screen.getByText("125.00")).toBeInTheDocument();
    expect(screen.getByText("50.00")).toBeInTheDocument();
  });

  it("allows users to inspect calculation assumptions", () => {
    render(<RewardProjectionPanel projection={mockProjection} />);

    const toggleBtn = screen.getByTestId("toggle-assumptions-btn");
    expect(screen.queryByTestId("assumptions-content")).not.toBeInTheDocument();

    fireEvent.click(toggleBtn);
    expect(screen.getByTestId("assumptions-content")).toBeInTheDocument();
    expect(screen.getByText("30 Days")).toBeInTheDocument();
    expect(screen.getByText("DeFi Yield Protocol (5.5%)")).toBeInTheDocument();
  });

  it("displays a warning when projection data is stale", () => {
    const staleProjection = {
      ...mockProjection,
      updatedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
    };

    render(<RewardProjectionPanel projection={staleProjection} />);
    expect(screen.getByTestId("stale-warning")).toBeInTheDocument();
  });

  it("handles missing projection data gracefully without erroring", () => {
    render(<RewardProjectionPanel projection={null} />);
    expect(screen.getByTestId("missing-projection")).toBeInTheDocument();
    expect(screen.getByText(/Reward projection data is currently unavailable/i)).toBeInTheDocument();
  });
});
