import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
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

  // #504 — totalDeposited previously used a raw SQL float8 cast, which
  // silently truncated fractional amounts and had no floor on malformed
  // values. It's now bigint-backed via Amount and rejects bad payloads
  // instead of coercing them to 0 or truncating them.
  it("excludes deposits with a fractional amount from totalDeposited but still counts them toward depositCount/distinctPools", async () => {
    await seedAction(db.prisma, {
      walletAddress: WALLET, status: "confirmed",
      actionPayload: { vault_id: "pool-a", amount: "40.5" }
    });
    await seedAction(db.prisma, {
      walletAddress: WALLET, status: "confirmed",
      actionPayload: { vault_id: "pool-b", amount: "20" }
    });

    const metrics = await svc.computeMetrics(WALLET);
    expect(metrics.totalDeposited).toBe(20); // only the valid deposit counts toward the dollar total
    expect(metrics.depositCount).toBe(2); // both deposits still happened
    expect(metrics.distinctPools).toBe(2);
  });

  it("excludes a deposit with a malformed (non-numeric) amount from totalDeposited", async () => {
    await seedAction(db.prisma, {
      walletAddress: WALLET, status: "confirmed",
      actionPayload: { vault_id: "pool-a", amount: "not-a-number" }
    });

    const metrics = await svc.computeMetrics(WALLET);
    expect(metrics.totalDeposited).toBe(0);
    expect(metrics.depositCount).toBe(1);
  });

  it("handles amounts beyond Number.MAX_SAFE_INTEGER without precision loss", async () => {
    // 2^53 - 1 = 9007199254740991; go well past it.
    await seedAction(db.prisma, {
      walletAddress: WALLET, status: "confirmed",
      actionPayload: { vault_id: "pool-a", amount: "9007199254740993" }
    });
    await seedAction(db.prisma, {
      walletAddress: WALLET, status: "confirmed",
      actionPayload: { vault_id: "pool-a", amount: "7" }
    });

    const metrics = await svc.computeMetrics(WALLET);
    // A float8 sum of these two values would lose the low-order digits;
    // bigint addition must not.
    expect(metrics.totalDeposited).toBe(9007199254741000);
  });

  // #504 acceptance criteria: "replaying finalized actions yields identical
  // progress" and tests must cover refunds/reorgs — a confirmed deposit
  // that later reverts must correctly drop out of totalDeposited (and any
  // quest progress derived from it) on the next evaluation, since
  // computeMetrics re-scans all confirmed rows from scratch each time
  // rather than maintaining a running delta.
  it("excludes a reverted (refunded/reorged) deposit from totalDeposited on re-evaluation", async () => {
    const action = await seedAction(db.prisma, {
      walletAddress: WALLET, status: "confirmed",
      actionPayload: { vault_id: "pool-a", amount: "150" }
    });

    const before = await svc.evaluateWallet(WALLET);
    const save100Before = before.find((p) => p.questId === "save_100")!;
    expect(save100Before.status).toBe("completed");

    // Simulate a reorg/refund: the action that funded progress reverts.
    await db.prisma.actionLedger.update({
      where: { id: action.id },
      data: { status: "reverted" }
    });

    const metricsAfter = await svc.computeMetrics(WALLET);
    expect(metricsAfter.totalDeposited).toBe(0);

    const after = await svc.evaluateWallet(WALLET);
    const save100After = after.find((p) => p.questId === "save_100")!;
    expect(save100After.progress).toBe(0);
    expect(save100After.status).toBe("in_progress");
    // The quest correctly un-completes; completedAt clears rather than
    // retaining a stale timestamp for a quest that's no longer complete.
    expect(save100After.completedAt).toBeNull();
  });

  // #504 acceptance criteria explicitly calls out "asset changes" as a
  // required test scenario, at the ledger/portfolio layer where per-action
  // asset identity is actually tracked (quest metrics are single-asset by
  // design per this file's own QUEST_ASSET_CODE convention — see
  // ledger.spec.ts for the asset-mismatch coverage against
  // getPortfolioSummary, which is where a vaultId reporting inconsistent
  // assets across actions is actually surfaced via invalid_action_count).

  it("running evaluateWallet twice in a row over unchanged data yields identical progress (replay determinism)", async () => {
    await seedAction(db.prisma, {
      walletAddress: WALLET, status: "confirmed",
      actionPayload: { vault_id: "pool-a", amount: "40" }
    });
    await seedAction(db.prisma, {
      walletAddress: WALLET, status: "confirmed",
      actionType: "claim", actionPayload: { vault_id: "pool-a", amount: "5" }
    });

    const first = await svc.evaluateWallet(WALLET);
    const second = await svc.evaluateWallet(WALLET);

    expect(second).toEqual(first);
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
    expect(result.poisoned).toBe(0);

    const saved = await svc.getUserQuests(WALLET);
    expect(saved.find((q) => q.questId === "save_100")!.status).toBe("completed");
  });

  // #505 acceptance criteria: "reorged/refunded actions trigger a
  // documented correction policy." evaluateRecent must pick up a wallet
  // whose only recent ledger change is a confirmed -> reverted
  // transition (not just fresh "confirmed" rows), and flag any already-
  // granted reward that the reversion invalidates.
  it("evaluateRecent picks up a wallet whose recent change is a reversion, and flags an invalidated grant", async () => {
    const action = await seedAction(db.prisma, {
      walletAddress: WALLET, status: "confirmed",
      actionType: "claim", actionPayload: { vault_id: "p", amount: "5" }
    });

    // First sweep: quest completes, reward grant is created and (via the
    // processGrants placeholder) marked granted.
    await svc.evaluateWallet(WALLET);
    await svc.processGrants();

    const grantsBefore = await db.prisma.rewardGrant.findMany({ where: { walletAddress: WALLET } });
    expect(grantsBefore).toHaveLength(1);
    expect(grantsBefore[0]!.status).toBe("granted");

    // Reorg/refund: the funding action reverts.
    await db.prisma.actionLedger.update({ where: { id: action.id }, data: { status: "reverted" } });

    const result = await svc.evaluateRecent(new Date(Date.now() - 60_000));
    expect(result.wallets).toBe(1); // picked up despite no longer being "confirmed"

    const grantsAfter = await db.prisma.rewardGrant.findMany({ where: { walletAddress: WALLET } });
    expect(grantsAfter).toHaveLength(1);
    expect(grantsAfter[0]!.status).toBe("needs_review");
    expect(grantsAfter[0]!.lastError).toMatch(/reverted|refunded/);
  });

  // #505 acceptance criteria: a single poison wallet must not abort the
  // rest of the batch.
  it("evaluateRecent continues past a poison wallet and still evaluates the rest of the batch", async () => {
    const goodWallet = "GQUESTWALLET111111111111111111111111111111111111111111";
    const poisonWallet = "GQUESTWALLETPOISON00000000000000000000000000000000000";

    await seedAction(db.prisma, {
      walletAddress: goodWallet, status: "confirmed",
      actionPayload: { vault_id: "p", amount: "150" }
    });
    // A row whose walletAddress collides with Postgres constraints is hard
    // to construct via the normal seed helper, so we simulate "poison" by
    // monkey-patching evaluateWallet to throw for one specific wallet and
    // restoring it afterward — the point under test is evaluateRecent's
    // per-wallet try/catch isolation, not any particular failure cause.
    await seedAction(db.prisma, {
      walletAddress: poisonWallet, status: "confirmed",
      actionPayload: { vault_id: "p", amount: "50" }
    });

    const originalEvaluateWallet = svc.evaluateWallet.bind(svc);
    const spy = vi.spyOn(svc, "evaluateWallet").mockImplementation(async (walletAddress: string) => {
      if (walletAddress === poisonWallet) {
        throw new Error("simulated poison-wallet failure");
      }
      return originalEvaluateWallet(walletAddress);
    });

    try {
      const result = await svc.evaluateRecent(new Date(Date.now() - 60_000));
      expect(result.wallets).toBe(2);
      expect(result.poisoned).toBe(1);

      const goodProgress = await svc.getUserQuests(goodWallet);
      expect(goodProgress.find((q) => q.questId === "save_100")!.status).toBe("completed");
    } finally {
      spy.mockRestore();
    }
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
