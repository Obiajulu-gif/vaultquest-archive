import { describe, expect, it, vi } from "vitest";
import { PrivacyAnalyticsService } from "../src/services/privacyAnalyticsService.js";

describe("PrivacyAnalyticsService", () => {
  it("returns aggregate-only metrics, suppresses small participant cohorts, and performs read-only queries", async () => {
    const tx = {
      $executeRaw: vi.fn(async () => 0),
      $queryRaw: vi.fn()
        .mockResolvedValueOnce([{ action_type: "deposit", status: "confirmed", count: 7 }])
        .mockResolvedValueOnce([{ status: "Resolved", count: 7 }])
        .mockResolvedValueOnce([{ status: "granted", count: 2 }])
        .mockResolvedValueOnce([{ status: "succeeded", count: 9 }])
        .mockResolvedValueOnce([{ count: 3 }]),
    };
    const prisma = {
      $transaction: vi.fn(async (fn: (client: typeof tx) => unknown, options: unknown) => {
        expect(options).toMatchObject({ isolationLevel: "RepeatableRead" });
        return fn(tx);
      }),
    } as any;

    const summary = await new PrivacyAnalyticsService(prisma).summarize(365);

    expect(tx.$executeRaw).toHaveBeenCalled();
    expect(summary.window.days).toBe(90);
    expect(summary.activity.total).toBe(7);
    expect(summary.backgroundJobs).toEqual([{ status: "succeeded", count: 9 }]);
    expect(summary.participants.distinctWallets).toBeNull();
    expect(summary.privacy.distinctWalletsSuppressed).toBe(true);
    expect(JSON.stringify(summary)).not.toContain("G".repeat(56));
    expect(JSON.stringify(summary)).not.toContain("tx_hash");
  });
});
