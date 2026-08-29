import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ActivityFeed, maskPoolLabel } from "../app/app/activity/page";

const TRANSACTIONS = [
  { id: "tx-1", type: "deposit", pool: "Community Drip Pool", asset: "USDC", amount: 500, date: "2026-05-28T14:22:00Z", status: "confirmed" },
  { id: "tx-2", type: "withdraw", pool: "Starter Vault", asset: "AVAX", amount: 100, date: "2026-05-10T11:30:00Z", status: "confirmed" },
  { id: "tx-sys-1", type: "system_message", message: "System Upgrade Completed", date: "2026-05-18T00:00:00Z", status: "confirmed" },
];

describe("maskPoolLabel (#655)", () => {
  it("returns the pool name unchanged when privacy mode is off", () => {
    expect(maskPoolLabel({ pool: "Community Drip Pool" }, false)).toBe("Community Drip Pool");
  });

  it("replaces the pool name with a generic placeholder when privacy mode is on", () => {
    expect(maskPoolLabel({ pool: "Community Drip Pool" }, true)).toBe("Vault activity");
  });

  it("leaves a transaction with no pool name alone regardless of privacy mode", () => {
    expect(maskPoolLabel({}, true)).toBeUndefined();
  });

  it("never masks a free-text message, since it doesn't name a specific vault", () => {
    expect(maskPoolLabel({ message: "System Upgrade Completed" }, true)).toBe("System Upgrade Completed");
    expect(maskPoolLabel({ message: "System Upgrade Completed" }, false)).toBe("System Upgrade Completed");
  });

  it("prefers message over pool when both are present, masked or not", () => {
    expect(maskPoolLabel({ message: "Vault Strategy Updated", pool: "Starter Vault" }, true)).toBe(
      "Vault Strategy Updated",
    );
  });
});

describe("ActivityFeed privacy mode rendering (#655)", () => {
  it("shows real pool/vault names by default", () => {
    render(<ActivityFeed transactions={TRANSACTIONS} />);
    expect(screen.getByText("Community Drip Pool")).toBeInTheDocument();
    expect(screen.getByText("Starter Vault")).toBeInTheDocument();
  });

  it("masks pool/vault names when privacyMode is on, leaving amounts and dates visible", () => {
    render(<ActivityFeed transactions={TRANSACTIONS} privacyMode />);
    expect(screen.queryByText("Community Drip Pool")).not.toBeInTheDocument();
    expect(screen.queryByText("Starter Vault")).not.toBeInTheDocument();
    expect(screen.getAllByText("Vault activity").length).toBe(2);

    // On-chain facts (amounts) are unaffected by the local display preference.
    expect(screen.getByText(/500/)).toBeInTheDocument();
    expect(screen.getByText(/100/)).toBeInTheDocument();
  });

  it("does not mask non-pool system messages, since they don't name a vault", () => {
    render(<ActivityFeed transactions={TRANSACTIONS} privacyMode />);
    expect(screen.getByText("System Upgrade Completed")).toBeInTheDocument();
  });
});
