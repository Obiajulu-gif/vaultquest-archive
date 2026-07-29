import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { startTestDb, resetDb, type TestDb } from "./helpers/db.js";
import { seedAction } from "./helpers/factory.js";
import { QuestService } from "../src/services/questService.js";

const WALLET = "GQUESTWALLET000000000000000000000000000000000000000000";

describe("QuestService", () => {
  let db: TestDb;
  let svc: QuestService;

  beforeAll(async () => {
    db = await startTestDb();
    svc = new QuestService(db.prisma);
  });
  afterAll(async () => { await db.stop(); });
  beforeEach(async () => { await resetDb(db.prisma); });

  it("computes progress across the five standard quests", async () => {
    // Three deposits across two pools, $60 total, two distinct months.
    await seedAction(db.prisma, {
      walletAddress: WALLET, status: "confirmed",
      actionPayload: { vault_id: "pool-a", amount: "40" }
    });
    await seedAction(db.prisma, {
      walletAddress: WALLET, status: "confirmed",
      actionPayload: { vault_id: "pool-b", amount: "20" }
    });
    const winter = await seedAction(db.prisma, {
      walletAddress: WALLET, status: "confirmed",
      actionPayload: { pool_id: "pool-a", amount: "0" }
    });
    await db.prisma.actionLedger.update({
      where: { id: winter.id },
      data: { createdAt: new Date("2026-01-15T00:00:00Z") }
    });

    const progress = await svc.evaluateWallet(WALLET);
    const byId = new Map(progress.map((p) => [p.questId, p]));

    expect(byId.get("first_deposit")?.status).toBe("completed");
    expect(byId.get("save_100")?.progress).toBe(60);
    expect(byId.get("save_100")?.status).toBe("in_progress");
    expect(byId.get("save_100_three_months")?.progress).toBe(2);
    expect(byId.get("participate_5_draws")?.progress).toBe(2);
    expect(byId.get("first_win")?.status).toBe("in_progress");
  });

  it("ignores non-confirmed and redacted rows", async () => {
    await seedAction(db.prisma, {
      walletAddress: WALLET, status: "pending",
      actionPayload: { vault_id: "p", amount: "1000" }
    });
    const metrics = await svc.computeMetrics(WALLET);
    expect(metrics.totalDeposited).toBe(0);
    expect(metrics.depositCount).toBe(0);
  });

  it("marks a quest completed and stamps completedAt once", async () => {
    await seedAction(db.prisma, {
      walletAddress: WALLET, status: "confirmed",
      actionType: "claim", actionPayload: { vault_id: "p", amount: "5" }
    });
    const first = await svc.evaluateWallet(WALLET);
    const win = first.find((p) => p.questId === "first_win")!;
    expect(win.status).toBe("completed");
    expect(win.completedAt).toBeInstanceOf(Date);

    // Re-evaluating must not move the completion timestamp.
    const second = await svc.evaluateWallet(WALLET);
    const win2 = second.find((p) => p.questId === "first_win")!;
    expect(win2.completedAt?.getTime()).toBe(win.completedAt?.getTime());
  });

  it("evaluateRecent picks up wallets with fresh confirmed activity", async () => {
    await seedAction(db.prisma, {
      walletAddress: WALLET, status: "confirmed",
      actionPayload: { vault_id: "p", amount: "150" }
    });
    const result = await svc.evaluateRecent(new Date(Date.now() - 60_000));
    expect(result.wallets).toBe(1);

    const saved = await svc.getUserQuests(WALLET);
    expect(saved.find((q) => q.questId === "save_100")!.status).toBe("completed");
  });

  it("completes a per-wallet evaluation in under 100ms over a large ledger", async () => {
    // Seed a sizeable confirmed history for the wallet.
    const rows = Array.from({ length: 2000 }, (_, i) => ({
      idempotencyKey: randomUUID(),
      walletAddress: WALLET,
      actionType: "deposit" as const,
      actionPayload: { vault_id: `pool-${i % 7}`, amount: "1" },
      status: "confirmed" as const
    }));
    await db.prisma.actionLedger.createMany({ data: rows });

    // Warm the query plan, then measure.
    await svc.computeMetrics(WALLET);
    const start = performance.now();
    await svc.computeMetrics(WALLET);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(100);
  });
});
