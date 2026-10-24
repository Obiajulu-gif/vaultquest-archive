import { describe, it, expect } from "vitest";
import { summarizeAccountPositions } from "@/lib/demo-portfolio";

describe("summarizeAccountPositions", () => {
  it("returns an empty summary for no activity", () => {
    const summary = summarizeAccountPositions([]);
    expect(summary).toEqual({
      positions: [],
      totalJoinedVaults: 0,
      totalBalance: 0,
      pendingActionsCount: 0,
    });
  });

  it("aggregates balance per pool from deposits, rewards, and withdrawals", () => {
    const summary = summarizeAccountPositions([
      { id: "1", type: "deposit", pool: "Starter Vault", asset: "USDC", amount: 500, status: "confirmed" },
      { id: "2", type: "reward", pool: "Starter Vault", asset: "USDC", amount: 50, status: "confirmed" },
      { id: "3", type: "withdraw", pool: "Starter Vault", asset: "USDC", amount: 100, status: "confirmed" },
      { id: "4", type: "deposit", pool: "High-Yield Round", asset: "XLM", amount: 200, status: "pending" },
    ]);

    expect(summary.totalJoinedVaults).toBe(2);
    expect(summary.totalBalance).toBe(650);
    expect(summary.pendingActionsCount).toBe(1);

    const starter = summary.positions.find((p) => p.pool === "Starter Vault");
    expect(starter.balance).toBe(450);
    expect(starter.pendingCount).toBe(0);

    const highYield = summary.positions.find((p) => p.pool === "High-Yield Round");
    expect(highYield.balance).toBe(200);
    expect(highYield.pendingCount).toBe(1);
  });

  it("skips non-vault transactions with no pool", () => {
    const summary = summarizeAccountPositions([
      { id: "1", type: "deposit", pool: "Starter Vault", asset: "USDC", amount: 500, status: "confirmed" },
      { id: "tx-sys-1", type: "system_message", message: "System Upgrade Completed", date: "2026-05-18T00:00:00Z", status: "confirmed" },
      { id: "tx-account-1", type: "account_action", message: "Profile Updated", date: "2026-05-05T15:20:00Z", status: "confirmed" },
    ]);

    expect(summary.totalJoinedVaults).toBe(1);
    expect(summary.positions).toHaveLength(1);
    expect(summary.positions[0].pool).toBe("Starter Vault");
    expect(summary.totalBalance).toBe(500);
  });
});
