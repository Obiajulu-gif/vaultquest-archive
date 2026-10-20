import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { PoolComparisonView } from "./PoolComparisonView";
import type { PoolSummary } from "../contract/types";

function makePool(overrides: Partial<PoolSummary> = {}): PoolSummary {
  return {
    id: "pool-1",
    name: "Weekly USDC",
    status: "open",
    tvl: "1000",
    asset: "USDC",
    participantCount: 12,
    expectedYield: "5.2% APY",
    prize: "500 USDC",
    opensAt: "2026-01-01T00:00:00Z",
    locksAt: "2026-01-08T00:00:00Z",
    drawsAt: "2026-01-09T00:00:00Z",
    ...overrides,
  };
}

describe("PoolComparisonView", () => {
  it("renders present metric values normally", () => {
    const pool = makePool();
    render(
      <PoolComparisonView
        pools={[pool]}
        selectedIds={["pool-1"]}
        onToggleSelect={() => {}}
        onClear={() => {}}
      />,
    );
    expect(screen.getByText("5.2% APY")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByText(/1,000\.00 USDC/)).toBeInTheDocument();
  });

  it("renders a real zero TVL/participant count as the actual zero, not unavailable", () => {
    const pool = makePool({ tvl: "0", participantCount: 0 });
    render(
      <PoolComparisonView
        pools={[pool]}
        selectedIds={["pool-1"]}
        onToggleSelect={() => {}}
        onClear={() => {}}
      />,
    );
    // A genuine zero TVL still renders as a real "0.00 USDC" amount.
    expect(screen.getByText(/0\.00 USDC/)).toBeInTheDocument();
    // A genuine zero participant count still renders as "0", not "—".
    expect(screen.getByText("0")).toBeInTheDocument();
  });

  it("renders missing/unavailable metrics as an explicit unavailable state, never a numeric zero", () => {
    const pool = makePool({
      tvl: "" as unknown as string,
      participantCount: undefined as unknown as number,
      expectedYield: undefined as unknown as string,
    });
    render(
      <PoolComparisonView
        pools={[pool]}
        selectedIds={["pool-1"]}
        onToggleSelect={() => {}}
        onClear={() => {}}
      />,
    );
    // Missing TVL/participants/yield must never silently render as "0.00 USDC" / "0" / blank.
    expect(screen.queryByText(/0\.00 USDC/)).not.toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
    // Three distinct unavailable cells: TVL, Participants, Expected yield.
    const dashes = screen.getAllByText("—");
    expect(dashes.length).toBeGreaterThanOrEqual(3);
  });

  it("treats a NaN-producing TVL string as unavailable rather than coercing to zero", () => {
    const pool = makePool({ tvl: "not-a-number" });
    render(
      <PoolComparisonView
        pools={[pool]}
        selectedIds={["pool-1"]}
        onToggleSelect={() => {}}
        onClear={() => {}}
      />,
    );
    expect(screen.queryByText(/0\.00/)).not.toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(1);
  });

  it("shows an empty state when there are no pools", () => {
    render(
      <PoolComparisonView
        pools={[]}
        selectedIds={[]}
        onToggleSelect={() => {}}
        onClear={() => {}}
      />,
    );
    expect(screen.getByText(/no pools to compare/i)).toBeInTheDocument();
  });

  it("toggles pool selection", () => {
    const onToggleSelect = vi.fn();
    const pool = makePool();
    render(
      <PoolComparisonView
        pools={[pool]}
        selectedIds={[]}
        onToggleSelect={onToggleSelect}
        onClear={() => {}}
      />,
    );
    screen.getByRole("button", { name: /weekly usdc/i }).click();
    expect(onToggleSelect).toHaveBeenCalledWith("pool-1");
  });
});
