import { describe, expect, it, vi } from "vitest";
import { AuditTrailService, InMemoryAuditTrailStore } from "../src/services/auditTrail.js";
import {
  InMemoryRecoveryCaseStore,
  PendingRecoveryService,
  RECOVERY_USER_MESSAGES,
  RecoveryError,
  type PendingActionSnapshot,
  type PendingActionSource,
  type RecoveryExecutor,
} from "../src/services/pendingRecovery.js";

// #813 — deterministic recovery workflow for stuck pending actions.

const T0 = Date.parse("2026-09-29T10:00:00.000Z");
const THRESHOLD = 30 * 60_000;
const OWNER = "GOWNER";
const MAINTAINER = { subject: "GADMIN", role: "maintainer" as const };
const USER = { subject: OWNER, role: "user" as const };

class FakeActions implements PendingActionSource {
  rows = new Map<string, PendingActionSnapshot>();
  put(row: Partial<PendingActionSnapshot> & { id: string }) {
    this.rows.set(row.id, {
      walletAddress: OWNER,
      actionType: "deposit",
      status: "submitted",
      txHash: "ab".repeat(32),
      createdAt: new Date(T0).toISOString(),
      updatedAt: new Date(T0).toISOString(),
      ...this.rows.get(row.id),
      ...row,
    });
  }
  async getAction(id: string) {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }
  private stale(cutoff: Date) {
    return [...this.rows.values()]
      .filter((r) => ["pending", "submitted"].includes(r.status) && new Date(r.updatedAt).getTime() <= cutoff.getTime())
      .sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)));
  }
  async listStale(cutoff: Date, limit: number) {
    return this.stale(cutoff).slice(0, limit);
  }
  async countStale(cutoff: Date) {
    return this.stale(cutoff).length;
  }
}

function setup(opts: { executor?: RecoveryExecutor; maxAttempts?: number } = {}) {
  let now = T0;
  const clock = {
    set: (ms: number) => {
      now = ms;
    },
  };
  const actions = new FakeActions();
  const store = new InMemoryRecoveryCaseStore();
  const auditStore = new InMemoryAuditTrailStore();
  const audit = new AuditTrailService(auditStore, { now: () => new Date(now) });
  const ledger = {
    markFailed: vi.fn(async (actionId: string) => {
      actions.put({ id: actionId, status: "failed" });
    }),
  };
  const svc = new PendingRecoveryService({
    store,
    actions,
    audit,
    ledger,
    executor: opts.executor,
    staleAfterMs: THRESHOLD,
    maxAttempts: opts.maxAttempts ?? 3,
    now: () => new Date(now),
  });
  return { svc, actions, store, auditStore, ledger, clock };
}

async function stuckCase(ctx: ReturnType<typeof setup>, id = "a1") {
  ctx.actions.put({ id });
  ctx.clock.set(T0 + THRESHOLD);
  const { opened } = await ctx.svc.scan();
  return opened.find((c) => c.actionId === id)!;
}

describe("stale detection (#813)", () => {
  it("becomes visible exactly at the configured threshold, before any scan", async () => {
    const ctx = setup();
    ctx.actions.put({ id: "a1" });

    ctx.clock.set(T0 + THRESHOLD - 1);
    expect((await ctx.svc.diagnostics()).stale.count).toBe(0);

    ctx.clock.set(T0 + THRESHOLD);
    const d = await ctx.svc.diagnostics();
    expect(d.staleAfterMs).toBe(THRESHOLD);
    expect(d.stale.count).toBe(1);
    expect(d.stale.oldestAgeMs).toBe(THRESHOLD);
    expect(d.stale.byStatus).toEqual({ submitted: 1 });
    expect(d.stale.sample[0]).toMatchObject({ actionId: "a1", caseState: null, hasTxHash: true });
  });

  it("ignores terminal actions and actions still moving", async () => {
    const ctx = setup();
    ctx.actions.put({ id: "done", status: "confirmed" });
    ctx.actions.put({ id: "fresh", updatedAt: new Date(T0 + THRESHOLD).toISOString() });
    ctx.clock.set(T0 + THRESHOLD);
    expect((await ctx.svc.scan()).opened).toHaveLength(0);
  });

  it("scan opens one retryable case per stale action, idempotently, and audits detection", async () => {
    const ctx = setup();
    const c = await stuckCase(ctx);
    expect(c).toMatchObject({ state: "retryable", attempts: 0, maxAttempts: 3, staleSince: new Date(T0).toISOString() });
    expect(await ctx.svc.scan()).toEqual({ opened: [], existing: 1 });

    const [detect] = await ctx.auditStore.scan(0, 10);
    expect(detect).toMatchObject({
      category: "recovery",
      action: "recovery.detect",
      actor: { subject: "system:recovery-scan", role: "system" },
      target: { type: "recovery_case", id: c.id },
      before: { state: "pending" },
      after: { state: "retryable", attempts: 0 },
    });
    expect((await ctx.svc.diagnostics()).cases).toEqual({ retryable: 1 });
  });
});

describe("retry (#813)", () => {
  it("retry success resolves the case when the action has moved on", async () => {
    const ctx = setup();
    const c = await stuckCase(ctx);
    ctx.actions.put({ id: "a1", status: "confirmed" });

    const resolved = await ctx.svc.retry(c.id, MAINTAINER);
    expect(resolved).toMatchObject({ state: "resolved", attempts: 1, lastError: null, resolution: { kind: "auto", finalStatus: "confirmed" } });

    const last = (await ctx.auditStore.query({ limit: 1 }))[0]!;
    expect(last).toMatchObject({
      action: "recovery.retry",
      actor: MAINTAINER,
      before: { state: "retryable", attempts: 0 },
      after: { state: "resolved", attempts: 1 },
      metadata: { outcome: "resolved", actionId: "a1" },
    });
  });

  it("retry failure stays retryable until max attempts, then fails", async () => {
    const ctx = setup({ maxAttempts: 3 });
    const c = await stuckCase(ctx);

    expect(await ctx.svc.retry(c.id, MAINTAINER)).toMatchObject({ state: "retryable", attempts: 1, lastError: "still submitted" });
    expect(await ctx.svc.retry(c.id, MAINTAINER)).toMatchObject({ state: "retryable", attempts: 2 });
    expect(await ctx.svc.retry(c.id, MAINTAINER)).toMatchObject({ state: "failed", attempts: 3 });
    await expect(ctx.svc.retry(c.id, MAINTAINER)).rejects.toMatchObject({ code: "ILLEGAL_TRANSITION" });
  });

  it("an executor crash counts as a failed attempt, never a success", async () => {
    const ctx = setup({ executor: { retry: async () => { throw new Error("rpc timeout"); } }, maxAttempts: 1 });
    const c = await stuckCase(ctx);
    expect(await ctx.svc.retry(c.id, MAINTAINER)).toMatchObject({ state: "failed", attempts: 1, lastError: "rpc timeout" });
  });

  it("an explicit failed outcome from the executor is recorded", async () => {
    const ctx = setup({ executor: { retry: async () => ({ outcome: "failed", detail: "tx not found on chain" }) } });
    const c = await stuckCase(ctx);
    expect(await ctx.svc.retry(c.id, MAINTAINER)).toMatchObject({ state: "retryable", lastError: "tx not found on chain" });
  });

  it("is deterministic: identical inputs give identical state sequences", async () => {
    const run = async () => {
      const ctx = setup({ maxAttempts: 2 });
      const c = await stuckCase(ctx);
      const states = [c.state];
      states.push((await ctx.svc.retry(c.id, MAINTAINER)).state);
      states.push((await ctx.svc.retry(c.id, MAINTAINER)).state);
      states.push((await ctx.svc.escalate(c.id, MAINTAINER, "chain lookup inconclusive")).state);
      states.push((await ctx.svc.resolve(c.id, MAINTAINER, { outcome: "dismissed", reason: "confirmed manually" })).state);
      return states;
    };
    const first = await run();
    expect(first).toEqual(["retryable", "retryable", "failed", "manual_review", "resolved"]);
    expect(await run()).toEqual(first);
  });
});

describe("manual resolution (#813)", () => {
  it("resolve as failed fails the ledger action first, then closes the case, audited with reason", async () => {
    const ctx = setup({ maxAttempts: 1 });
    const c = await stuckCase(ctx);
    await ctx.svc.retry(c.id, MAINTAINER); // -> failed
    await ctx.svc.escalate(c.id, MAINTAINER, "wallet reports no signature");

    const resolved = await ctx.svc.resolve(c.id, MAINTAINER, { outcome: "failed", reason: "user abandoned the signature" });
    expect(ctx.ledger.markFailed).toHaveBeenCalledWith("a1", "RECOVERY_MANUAL_FAILED", "user abandoned the signature");
    expect(resolved).toMatchObject({ state: "resolved", resolution: { kind: "manual", outcome: "failed", reason: "user abandoned the signature" } });

    const last = (await ctx.auditStore.query({ limit: 1 }))[0]!;
    expect(last).toMatchObject({
      action: "recovery.resolve",
      actor: MAINTAINER,
      reason: "user abandoned the signature",
      before: { state: "manual_review" },
      after: { state: "resolved" },
    });
  });

  it("dismissed closes the case without touching the ledger", async () => {
    const ctx = setup();
    const c = await stuckCase(ctx);
    await ctx.svc.resolve(c.id, MAINTAINER, { outcome: "dismissed", reason: "indexer backlog, confirmed later" });
    expect(ctx.ledger.markFailed).not.toHaveBeenCalled();
  });

  it("leaves the case untouched when the ledger update fails", async () => {
    const ctx = setup();
    const c = await stuckCase(ctx);
    ctx.ledger.markFailed.mockRejectedValueOnce(new Error("illegal transition"));
    await expect(ctx.svc.resolve(c.id, MAINTAINER, { outcome: "failed", reason: "abandoned" })).rejects.toThrow("illegal transition");
    expect((await ctx.store.get(c.id))!.state).toBe("retryable");
  });

  it("requires reasons and rejects illegal transitions", async () => {
    const ctx = setup();
    const c = await stuckCase(ctx);
    await expect(ctx.svc.escalate(c.id, MAINTAINER, " ")).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(ctx.svc.resolve(c.id, MAINTAINER, { outcome: "dismissed", reason: "" })).rejects.toMatchObject({ code: "INVALID_REQUEST" });

    await ctx.svc.escalate(c.id, MAINTAINER, "needs a look");
    await expect(ctx.svc.escalate(c.id, MAINTAINER, "again")).rejects.toMatchObject({ code: "ILLEGAL_TRANSITION" });
    await expect(ctx.svc.retry(c.id, MAINTAINER)).rejects.toMatchObject({ code: "ILLEGAL_TRANSITION" });

    await ctx.svc.resolve(c.id, MAINTAINER, { outcome: "dismissed", reason: "fine" });
    await expect(ctx.svc.resolve(c.id, MAINTAINER, { outcome: "dismissed", reason: "twice" })).rejects.toMatchObject({ code: "ILLEGAL_TRANSITION" });
    await expect(ctx.svc.retry("rec_missing", MAINTAINER)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects a concurrent update instead of applying both", async () => {
    const ctx = setup();
    const c = await stuckCase(ctx);
    vi.spyOn(ctx.store, "update").mockResolvedValueOnce(null);
    await expect(ctx.svc.escalate(c.id, MAINTAINER, "racing")).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await ctx.store.get(c.id))!.state).toBe("retryable");
  });
});

describe("owner view and user retry (#813)", () => {
  it("shows pending before the threshold and opens a retryable case once stale", async () => {
    const ctx = setup();
    ctx.actions.put({ id: "a1" });
    ctx.clock.set(T0 + 1000);
    expect(await ctx.svc.viewForOwner("a1", OWNER)).toMatchObject({ state: "pending", canRetry: false, caseId: null, message: RECOVERY_USER_MESSAGES.pending });

    ctx.clock.set(T0 + THRESHOLD);
    const view = await ctx.svc.viewForOwner("a1", OWNER.toLowerCase());
    expect(view).toMatchObject({ state: "retryable", canRetry: true, message: RECOVERY_USER_MESSAGES.retryable });
    const retried = await ctx.svc.retry(view.caseId!, USER, OWNER);
    expect(retried.attempts).toBe(1);
    expect((await ctx.auditStore.query({ action: "recovery.retry", limit: 1 }))[0]!.actor).toEqual(USER);
  });

  it("denies other wallets", async () => {
    const ctx = setup();
    const c = await stuckCase(ctx);
    await expect(ctx.svc.viewForOwner("a1", "GINTRUDER")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(ctx.svc.retry(c.id, { subject: "GINTRUDER", role: "user" }, "GINTRUDER")).rejects.toBeInstanceOf(RecoveryError);
  });

  it("validates configuration", () => {
    const base = { store: new InMemoryRecoveryCaseStore(), actions: new FakeActions(), audit: { record: async () => undefined } };
    expect(() => new PendingRecoveryService({ ...base, staleAfterMs: 0 })).toThrow();
    expect(() => new PendingRecoveryService({ ...base, maxAttempts: 0 })).toThrow();
  });
});
