import React from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import VaultComparisonTable from "./VaultComparisonTable";

const vaults = [
  { id: "usdc", name: "USDC Reserve", asset: "USDC", network: "Avalanche", apy: 5.2, tvl: 1_200_000, lockup: 7, status: "active", participantCount: 428, lastActivity: new Date("2026-07-17") },
  { id: "xlm", name: "XLM Flex", asset: "XLM", network: "Stellar", apy: 3.8, tvl: 450_000, lockup: 0, status: "pending", participantCount: 196, lastActivity: new Date("2026-07-16") },
  { id: "sol", name: "SOL Max", asset: "SOL", network: "Solana", apy: 12.4, tvl: 2_100_000, lockup: 45, status: "completed", participantCount: 812, lastActivity: new Date("2026-07-15") },
];

const names = () => within(screen.getByRole("table")).getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("cell")[0].querySelector("p").textContent);

describe("VaultComparisonTable", () => {
  it("renders every comparison column and representative values", () => {
    render(<VaultComparisonTable vaults={vaults} />);
    expect(screen.getAllByRole("columnheader").map((header) => header.textContent.trim())).toEqual([
      "Vault", "Deposits (TVL)", "Participants", "Est. Yield", "Lockup", "Activity", "Action",
    ]);
    expect(screen.getByText("812")).toBeInTheDocument();
    expect(screen.getByText("12.4%")).toBeInTheDocument();
    expect(screen.getByText(/Solana.*SOL/)).toBeInTheDocument();
  });

  it("sorts APR in both directions", async () => {
    const user = userEvent.setup();
    render(<VaultComparisonTable vaults={vaults} />);
    expect(names()).toEqual(["SOL Max", "USDC Reserve", "XLM Flex"]);
    await user.click(screen.getByRole("columnheader", { name: /Est. Yield/ }));
    expect(names()).toEqual(["XLM Flex", "USDC Reserve", "SOL Max"]);
    await user.click(screen.getByRole("columnheader", { name: /Est. Yield/ }));
    expect(names()).toEqual(["SOL Max", "USDC Reserve", "XLM Flex"]);
  });

  it("sorts participant count in both directions", async () => {
    const user = userEvent.setup();
    render(<VaultComparisonTable vaults={vaults} />);
    await user.click(screen.getByRole("columnheader", { name: /Participants/ }));
    expect(names()).toEqual(["XLM Flex", "USDC Reserve", "SOL Max"]);
    await user.click(screen.getByRole("columnheader", { name: /Participants/ }));
    expect(names()).toEqual(["SOL Max", "USDC Reserve", "XLM Flex"]);
  });

  it("reacts when the selected sort changes", () => {
    const { rerender } = render(<VaultComparisonTable vaults={vaults} sortBy="apy" />);
    rerender(<VaultComparisonTable vaults={vaults} sortBy="participantCount" />);
    expect(names()).toEqual(["SOL Max", "USDC Reserve", "XLM Flex"]);
  });

  it("renders empty-state copy and clear action", async () => {
    const user = userEvent.setup();
    const onClearFilters = vi.fn();
    render(<VaultComparisonTable vaults={[]} onClearFilters={onClearFilters} />);
    expect(screen.getByRole("heading", { name: "No vaults match your filters" })).toBeInTheDocument();
    expect(screen.getByText(/Try clearing some filters/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(onClearFilters).toHaveBeenCalledOnce();
  });
});
