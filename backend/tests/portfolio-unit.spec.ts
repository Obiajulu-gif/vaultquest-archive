import { describe, it, expect } from "vitest";
import { LedgerService } from "../src/services/ledger.js";

describe("LedgerService.getPortfolioSummary Unit Tests (No Database Required)", () => {
  const walletAddress = "GABCDEF1234567890123456789012345678901234567890123456789";

  it("handles empty wallet cleanly (zero-state)", async () => {
    // Mock prisma actionLedger.findMany returning an empty list
    const mockPrisma = {
      actionLedger: {
        findMany: async (args: any) => {
          expect(args.where.walletAddress).toBe(walletAddress);
          return [];
        }
      }
    } as any;

    const svc = new LedgerService(mockPrisma);
    const summary = await svc.getPortfolioSummary(walletAddress);

    expect(summary.wallet_address).toBe(walletAddress);
    expect(summary.total_deposits).toBe(0);
    expect(summary.active_positions).toEqual([]);
    expect(summary.pending_rewards).toBe(0);
    expect(summary.claimable_amount).toBe(0);
    expect(summary.recent_activity).toEqual([]);
  });

  it("aggregates deposits, withdrawals, and claims accurately", async () => {
    const mockActions = [
      {
        id: "act-pending",
        walletAddress,
        actionType: "deposit",
        status: "pending",
        createdAt: new Date("2026-05-30T02:00:00Z"),
        txHash: null,
        actionPayload: { vault_id: "pool-A", amount: "500" }
      },
      {
        id: "act-claim",
        walletAddress,
        actionType: "claim",
        status: "confirmed",
        createdAt: new Date("2026-05-30T01:50:00Z"),
        txHash: "tx-claim",
        actionPayload: { vault_id: "pool-A", amount: "30" },
        // #509: claimable_amount trusts the finalized event's decoded
        // payload for confirmed claims, not the client-supplied actionPayload.
        verifiedPayload: { amount: "30" }
      },
      {
        id: "act-withdraw-1",
        walletAddress,
        actionType: "withdraw",
        status: "confirmed",
        createdAt: new Date("2026-05-30T01:40:00Z"),
        txHash: "tx-wd1",
        actionPayload: { vault_id: "pool-A", amount: "50" }
      },
      {
        id: "act-deposit-2",
        walletAddress,
        actionType: "deposit",
        status: "confirmed",
        createdAt: new Date("2026-05-30T01:30:00Z"),
        txHash: "tx-dep2",
        actionPayload: { vault_id: "pool-B", amount: "400" }
      },
      {
        id: "act-deposit-1",
        walletAddress,
        actionType: "deposit",
        status: "confirmed",
        createdAt: new Date("2026-05-30T01:20:00Z"),
        txHash: "tx-dep1",
        actionPayload: { vault_id: "pool-A", amount: "200" }
      }
    ];

    const mockPrisma = {
      actionLedger: {
        findMany: async (args: any) => {
          expect(args.where.walletAddress).toBe(walletAddress);
          return mockActions;
        }
      }
    } as any;

    const svc = new LedgerService(mockPrisma);
    const summary = await svc.getPortfolioSummary(walletAddress);

    expect(summary.wallet_address).toBe(walletAddress);
    expect(summary.total_deposits).toBe(550); // pool-A (200 - 50 = 150) + pool-B (400) = 550
    expect(summary.claimable_amount).toBe(30);
    expect(summary.pending_rewards).toBe(0);

    // Verify active positions
    expect(summary.active_positions).toHaveLength(2);
    const posA = summary.active_positions.find(p => p.vault_id === "pool-A");
    const posB = summary.active_positions.find(p => p.vault_id === "pool-B");
    expect(posA?.balance).toBe(150);
    expect(posB?.balance).toBe(400);

    // Verify recent activity is limited and properly ordered
    expect(summary.recent_activity).toHaveLength(5);
    expect(summary.recent_activity[0]?.id).toBe("act-pending");
    expect(summary.recent_activity[0]?.status).toBe("pending");
    expect(summary.recent_activity[4]?.id).toBe("act-deposit-1");
  });

  // #509: claimable_amount must come from the finalized event's decoded
  // payload (verifiedPayload), not the client-supplied actionPayload, since
  // actionPayload is mutable by anyone with database write access.
  describe("#509 payout verification", () => {
    it("uses verifiedPayload amount for a confirmed claim, not actionPayload", async () => {
      const mockActions = [
        {
          id: "act-claim-verified",
          walletAddress,
          actionType: "claim",
          status: "confirmed",
          createdAt: new Date("2026-05-30T01:50:00Z"),
          txHash: "tx-claim",
          actionPayload: { vault_id: "pool-A", amount: "9999" }, // client claims a huge amount
          verifiedPayload: { winner: "GABCDEF1234567890123456789012345678901234567890123456789", amount: "30" }
        }
      ];
      const mockPrisma = {
        actionLedger: { findMany: async () => mockActions }
      } as any;

      const svc = new LedgerService(mockPrisma);
      const summary = await svc.getPortfolioSummary(walletAddress);

      // Trusts the verified figure (30), not the claimed one (9999).
      expect(summary.claimable_amount).toBe(30);
    });

    it("excludes a confirmed claim with no verifiedPayload from claimable_amount (fail closed)", async () => {
      const mockActions = [
        {
          id: "act-claim-unverified",
          walletAddress,
          actionType: "claim",
          status: "confirmed",
          createdAt: new Date("2026-05-30T01:50:00Z"),
          txHash: "tx-claim",
          actionPayload: { vault_id: "pool-A", amount: "500" },
          verifiedPayload: null
        }
      ];
      const mockPrisma = {
        actionLedger: { findMany: async () => mockActions }
      } as any;

      const svc = new LedgerService(mockPrisma);
      const summary = await svc.getPortfolioSummary(walletAddress);

      expect(summary.claimable_amount).toBe(0);
    });

    it("still trusts actionPayload for deposit/withdraw (wallet-signed, no third-party payout trust boundary)", async () => {
      const mockActions = [
        {
          id: "act-deposit",
          walletAddress,
          actionType: "deposit",
          status: "confirmed",
          createdAt: new Date("2026-05-30T01:20:00Z"),
          txHash: "tx-dep",
          actionPayload: { vault_id: "pool-A", amount: "200" },
          verifiedPayload: null
        }
      ];
      const mockPrisma = {
        actionLedger: { findMany: async () => mockActions }
      } as any;

      const svc = new LedgerService(mockPrisma);
      const summary = await svc.getPortfolioSummary(walletAddress);

      expect(summary.total_deposits).toBe(200);
    });
  });
});
