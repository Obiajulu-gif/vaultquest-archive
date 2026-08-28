import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import React from "react";
import { SavedPoolsWatchlist } from "./SavedPoolsWatchlist";
import type { SavedPoolEntry } from "../contract/types";

const mockEntries: SavedPoolEntry[] = [
  {
    id: "pool-1",
    name: "Healthy USDC Pool",
    status: "open",
    tvl: "50000000",
    asset: "USDC",
    expectedYield: "4.5%",
    walletAddress: "GABC",
    savedAt: "2026-08-01T12:00:00Z",
    updatedAt: "2026-08-01T12:00:00Z"
  },
  {
    id: "pool-2",
    name: "Closed Pool",
    status: "closed",
    tvl: "250000000",
    asset: "XLM",
    expectedYield: "0%",
    walletAddress: "GABC",
    savedAt: "2026-08-02T12:00:00Z",
    updatedAt: "2026-08-02T12:00:00Z"
  },
  {
    id: "pool-3",
    name: "Cancelled Pool",
    status: "cancelled",
    tvl: "0",
    asset: "USDC",
    expectedYield: "0%",
    walletAddress: "GABC",
    savedAt: "2026-08-03T12:00:00Z",
    updatedAt: "2026-08-03T12:00:00Z"
  }
];

describe("SavedPoolsWatchlist", () => {
  it("renders empty state when there are no entries", () => {
    render(<SavedPoolsWatchlist entries={[]} walletConnected={true} />);
    expect(screen.getByText("No saved pools yet")).toBeInTheDocument();
  });

  it("renders saved pool rows and labels correctly", () => {
    render(<SavedPoolsWatchlist entries={mockEntries} walletConnected={true} />);
    expect(screen.getAllByText("Healthy USDC Pool")[0]).toBeInTheDocument();
    expect(screen.getAllByText("Closed Pool")[0]).toBeInTheDocument();
    expect(screen.getAllByText("Cancelled Pool")[0]).toBeInTheDocument();
  });

  it("renders warning badges and disables open actions for closed/cancelled pools", () => {
    const onOpenPool = vi.fn();
    const { container } = render(
      <SavedPoolsWatchlist entries={mockEntries} walletConnected={true} onOpenPool={onOpenPool} />
    );

    // Desktop check: should have 2 unavailable badges in table row cells
    const badges = screen.getAllByText("Unavailable");
    expect(badges).toHaveLength(4); // 2 in desktop, 2 in mobile

    // Verify buttons are disabled
    const openButtons = screen.getAllByRole("button", { name: /open/i });
    
    // Desktop Open buttons
    const desktopOpen1 = openButtons[0];
    const desktopOpen2 = openButtons[1];
    const desktopOpen3 = openButtons[2];

    expect(desktopOpen1).not.toBeDisabled();
    expect(desktopOpen2).toBeDisabled();
    expect(desktopOpen3).toBeDisabled();

    // Verify opacity classes on the parent wrapper elements
    // The closed pool rows (in table body) should have the opacity-60 and bg-red-950/10 classes
    const closedRows = container.querySelectorAll("tr.opacity-60");
    expect(closedRows).toHaveLength(2); // pool-2 and pool-3 desktop rows
  });

  it("triggers onUnsave callback on Remove button click", () => {
    const onUnsave = vi.fn();
    render(<SavedPoolsWatchlist entries={mockEntries} walletConnected={true} onUnsave={onUnsave} />);

    const removeButtons = screen.getAllByRole("button", { name: /remove/i });
    fireEvent.click(removeButtons[0]!); // click remove on the first entry

    expect(onUnsave).toHaveBeenCalledWith(mockEntries[0]);
  });
});
