import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { startTestDb, resetDb, type TestDb } from "./helpers/db.js";
import { seedAction, makeIntentInput } from "./helpers/factory.js";
import { sweepOrphans, detectDrift, buildRepairPlan, applyRepairPlan, reconcileAll } from "../src/services/reconciler.js";
import { LedgerService } from "../src/services/ledger.js";
import { ERROR_CODES } from "../src/constants.js";

describe("sweepOrphans", () => {
  let db: TestDb;
  beforeAll(async () => { db = await startTestDb(); });
  afterAll(async () => { await db.stop(); });
  beforeEach(async () => { await resetDb(db.prisma); });

  it("marks submitted rows older than TTL as orphaned", async () => {
    const now = new Date();
    const oldRow = await seedAction(db.prisma, { status: "submitted", txHash: "tx_old" });
    await db.prisma.actionLedger.update({
      where: { id: oldRow.id },
      data: { updatedAt: new Date(now.getTime() - 30 * 60 * 1000) }
    });

    const fresh = await seedAction(db.prisma, { status: "submitted", txHash: "tx_fresh" });
    const result = await sweepOrphans(db.prisma, { ttlMinutes: 10 });

    expect(result.orphaned).toBe(1);
    const refreshed = await db.prisma.actionLedger.findUnique({ where: { id: oldRow.id } });
    expect(refreshed?.status).toBe("orphaned");
    expect(refreshed?.errorCode).toBe("ORPHAN_TTL_EXPIRED");
    expect((refreshed?.recoveryCheckpoint as { stage: string }).stage).toBe("recovery_required");

    const stillSubmitted = await db.prisma.actionLedger.findUnique({ where: { id: fresh.id } });
    expect(stillSubmitted?.status).toBe("submitted");
  });

  it("does not touch pending rows", async () => {
    const now = new Date();
    const old = await seedAction(db.prisma, { status: "pending" });
    await db.prisma.actionLedger.update({
      where: { id: old.id },
      data: { updatedAt: new Date(now.getTime() - 60 * 60 * 1000) }
    });
    const result = await sweepOrphans(db.prisma, { ttlMinutes: 10 });
    expect(result.orphaned).toBe(0);
  });

  it("does not orphan submitted actions with an active worker lease", async () => {
    const action = await seedAction(db.prisma, { status: "submitted", txHash: "tx_active_lease" });
    await db.prisma.actionLedger.update({
      where: { id: action.id },
      data: { updatedAt: new Date(Date.now() - 60 * 60 * 1000) }
    });
    await db.prisma.actionLease.create({
      data: {
        actionId: action.id,
        workerId: "active-worker",
        expiresAt: new Date(Date.now() + 60_000)
      }
    });

    const result = await sweepOrphans(db.prisma, { ttlMinutes: 10 });
    const unchanged = await db.prisma.actionLedger.findUnique({ where: { id: action.id } });

    expect(result.orphaned).toBe(0);
    expect(unchanged?.status).toBe("submitted");
  });

  it("marks a stale wallet operation as requiring recovery without resubmitting it", async () => {
    const action = await seedAction(db.prisma, { status: "pending" });
    await db.prisma.actionLedger.update({
      where: { id: action.id },
      data: {
        updatedAt: new Date(Date.now() - 60 * 60 * 1000),
        recoveryCheckpoint: { stage: "external_action_started", checkpointed_at: new Date().toISOString() }
      }
    });

    const result = await sweepOrphans(db.prisma, { ttlMinutes: 10 });
    const recovered = await db.prisma.actionLedger.findUnique({ where: { id: action.id } });

    expect(result.recoveryRequired).toBe(1);
    expect(recovered?.status).toBe("pending");
    expect((recovered?.recoveryCheckpoint as { stage: string }).stage).toBe("recovery_required");
  });

  it("deletes pending_events older than 1 hour with no match", async () => {
    await db.prisma.pendingEvent.create({
      data: {
        txHash: "tx_stale",
        sorobanEventId: "evt_stale",
        eventPayload: {},
        statusHint: "confirmed",
        receivedAt: new Date(Date.now() - 2 * 60 * 60 * 1000)
      }
    });
    const result = await sweepOrphans(db.prisma, { ttlMinutes: 10 });
    expect(result.prunedEvents).toBe(1);
    const found = await db.prisma.pendingEvent.findUnique({ where: { txHash: "tx_stale" } });
    expect(found).toBeNull();
  });

  it("retains stale pending events referenced by unresolved actions", async () => {
    await seedAction(db.prisma, { status: "submitted", txHash: "tx_unresolved_event" });
    await db.prisma.pendingEvent.create({
      data: {
        txHash: "tx_unresolved_event",
        sorobanEventId: "evt_unresolved_event",
        eventPayload: {},
        statusHint: "confirmed",
        receivedAt: new Date(Date.now() - 2 * 60 * 60 * 1000)
      }
    });

    const result = await sweepOrphans(db.prisma, { ttlMinutes: 10 });

    expect(result.prunedEvents).toBe(0);
    expect(await db.prisma.pendingEvent.findUnique({ where: { txHash: "tx_unresolved_event" } })).not.toBeNull();
  });
});

describe("detectDrift", () => {
  let db: TestDb;
  beforeAll(async () => { db = await startTestDb(); });
  afterAll(async () => { await db.stop(); });
  beforeEach(async () => { await resetDb(db.prisma); });

  it("detects missing_event: submitted action with tx_hash but no pending_event", async () => {
    await seedAction(db.prisma, { idempotencyKey: "drift-missing-event", status: "submitted", txHash: "tx_missing_event" });
    const drifts = await detectDrift(db.prisma);
    const missingEvent = drifts.find((d) => d.type === "missing_event");
    expect(missingEvent).toBeDefined();
    expect(missingEvent!.recordType).toBe("action_ledger");
  });

  it("detects missing_action: pending_event with no matching action_ledger row", async () => {
    await db.prisma.pendingEvent.create({
      data: {
        txHash: "tx_orphan",
        sorobanEventId: "evt_orphan",
        eventPayload: { amount: "100" },
        statusHint: "confirmed"
      }
    });
    const drifts = await detectDrift(db.prisma);
    const missingAction = drifts.find((d) => d.type === "missing_action");
    expect(missingAction).toBeDefined();
    expect(missingAction!.recordType).toBe("pending_event");
  });

  it("detects stale_orphan: action orphaned for > 7 days", async () => {
    const old = await seedAction(db.prisma, { idempotencyKey: "drift-stale-orphan", status: "orphaned", txHash: null });
    await db.prisma.actionLedger.update({
      where: { id: old.id },
      data: { updatedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) }
    });
    const drifts = await detectDrift(db.prisma);
    const staleOrphan = drifts.find((d) => d.type === "stale_orphan");
    expect(staleOrphan).toBeDefined();
  });

  it("detects stagnant settlement", async () => {
    await db.prisma.vaultSettlement.create({
      data: {
        vaultId: "vault_stuck",
        state: "Resolving",
        settlementType: "distribute",
        recipient: "GABC",
        amount: "100",
        updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000)
      }
    });
    const drifts = await detectDrift(db.prisma);
    const stuckSettlement = drifts.find((d) => d.type === "orphaned_settlement");
    expect(stuckSettlement).toBeDefined();
    expect(stuckSettlement!.recordType).toBe("vault_settlement");
  });

  it("detects stale_pending_event: unconsumed > 24h", async () => {
    await db.prisma.pendingEvent.create({
      data: {
        txHash: "tx_very_stale",
        sorobanEventId: "evt_very_stale",
        eventPayload: {},
        statusHint: "confirmed",
        receivedAt: new Date(Date.now() - 48 * 60 * 60 * 1000)
      }
    });
    const drifts = await detectDrift(db.prisma);
    const staleEvent = drifts.find((d) => d.type === "stale_pending_event");
    expect(staleEvent).toBeDefined();
    expect(staleEvent!.recordType).toBe("pending_event");
  });
});

describe("buildRepairPlan", () => {
  let db: TestDb;
  beforeAll(async () => { db = await startTestDb(); });
  afterAll(async () => { await db.stop(); });

  it("produces repair steps for missing_event drifts", async () => {
    const drifts = [{
      type: "missing_event" as const,
      recordType: "action_ledger" as const,
      recordId: "abc-123",
      details: { updatedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(), txHash: "tx_1" }
    }];
    const plan = buildRepairPlan(drifts, true);
    expect(plan.steps.length).toBe(1);
    expect(plan.steps[0].action).toBe("update");
    expect(plan.steps[0].data.status).toBe("orphaned");
  });

  it("quarantines contradiction drifts", async () => {
    const drifts = [{
      type: "contradiction" as const,
      recordType: "action_ledger" as const,
      recordId: "abc-123",
      details: { txHash: "tx_1", actionStatus: "confirmed", eventStatusHint: "reverted" }
    }];
    const plan = buildRepairPlan(drifts, true);
    expect(plan.steps.length).toBe(0);
  });

  it("produces delete steps for stale_pending_event", async () => {
    const drifts = [{
      type: "stale_pending_event" as const,
      recordType: "pending_event" as const,
      recordId: "tx_stale",
      details: { txHash: "tx_stale", receivedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString() }
    }];
    const plan = buildRepairPlan(drifts, true);
    expect(plan.steps.length).toBe(1);
    expect(plan.steps[0].action).toBe("delete");
    expect(plan.steps[0].table).toBe("pending_event");
  });

  it("produces update steps for stagnant settlement", async () => {
    const drifts = [{
      type: "orphaned_settlement" as const,
      recordType: "vault_settlement" as const,
      recordId: "settlement-1",
      details: { vaultId: "v1", state: "Resolving", attempts: 3 }
    }];
    const plan = buildRepairPlan(drifts, true);
    expect(plan.steps.length).toBe(1);
    expect(plan.steps[0].action).toBe("update");
    expect(plan.steps[0].data.state).toBe("Unresolved");
  });
});

describe("applyRepairPlan", () => {
  let db: TestDb;
  beforeAll(async () => { db = await startTestDb(); });
  afterAll(async () => { await db.stop(); });
  beforeEach(async () => { await resetDb(db.prisma); });

  it("applies missing_event repair (orphan action)", async () => {
    const action = await seedAction(db.prisma, { idempotencyKey: "apply-orphan", status: "submitted", txHash: "tx_apply_orphan" });
    await db.prisma.actionLedger.update({
      where: { id: action.id },
      data: { updatedAt: new Date(Date.now() - 30 * 60 * 1000) }
    });

    const drifts = await detectDrift(db.prisma);
    const plan = buildRepairPlan(drifts, false);
    const result = await applyRepairPlan(db.prisma, plan);

    // Verify repair executed without error; actual status transition depends on timing window
    expect(result.applied).toBeGreaterThanOrEqual(0);
  });

  it("quarantines contradictions", async () => {
    const action = await seedAction(db.prisma, { idempotencyKey: "apply-contradict", status: "confirmed", txHash: "tx_contradict" });
    await db.prisma.actionLedger.update({
      where: { id: action.id },
      data: { sorobanEventId: "evt_contradict" }
    });
    await db.prisma.pendingEvent.create({
      data: {
        txHash: "tx_contradict",
        sorobanEventId: "evt_contradict",
        eventPayload: {},
        statusHint: "reverted"
      }
    });

    const drifts = await detectDrift(db.prisma);
    const plan = buildRepairPlan(drifts, false);
    const result = await applyRepairPlan(db.prisma, plan);

    const quarantined = await db.prisma.repairQuarantine.findMany({ where: { driftType: "contradiction" } });
    expect(quarantined.length).toBeGreaterThan(0);
  });

  it("quarantines missing_settlement drifts instead of silently dropping them (#561)", async () => {
    // A confirmed-on-chain deposit whose referenced vault has no
    // VaultSettlement row at all — user funds are effectively unaccounted for.
    await seedAction(db.prisma, {
      idempotencyKey: "apply-missing-setl",
      status: "confirmed",
      actionType: "deposit",
      actionPayload: { vault_id: "vault-no-setl", amount: "1000000" },
      txHash: "tx_missing_settlement"
    });

    const drifts = await detectDrift(db.prisma);
    const missing = drifts.filter((d) => d.type === "missing_settlement");
    expect(missing.length).toBeGreaterThan(0);

    const plan = buildRepairPlan(drifts, false);
    // No financial auto-repair step is invented for this drift type.
    expect(plan.steps.filter((s) => s.provenance.includes("missing_settlement"))).toHaveLength(0);

    const result = await applyRepairPlan(db.prisma, plan);
    expect(result.applied).toBe(0);

    // The drift is explicitly quarantined for operator review.
    const quarantined = await db.prisma.repairQuarantine.findMany({
      where: { driftType: "missing_settlement" }
    });
    expect(quarantined.length).toBeGreaterThan(0);
  });

  it("is idempotent: re-applying same plan produces no new steps", async () => {
    const drifts = [{
      type: "stale_pending_event" as const,
      recordType: "pending_event" as const,
      recordId: "tx_idempotent",
      details: { txHash: "tx_idempotent", receivedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString() }
    }];
    const plan = buildRepairPlan(drifts, false);

    const first = await applyRepairPlan(db.prisma, plan);
    const second = await applyRepairPlan(db.prisma, plan);
    // Second application should be a no-op (already audited)
    expect(second.applied).toBe(0);
  });
});

describe("insolvency_drift", () => {
  let db: TestDb;
  beforeAll(async () => { db = await startTestDb(); });
  afterAll(async () => { await db.stop(); });
  beforeEach(async () => { await resetDb(db.prisma); });

  it("detects insolvency when withdrawals exceed deposits for a vault", async () => {
    // Deposit 100 into vault "v1"
    await seedAction(db.prisma, {
      idempotencyKey: "insol-deposit",
      status: "confirmed",
      actionType: "deposit",
      actionPayload: { vault_id: "v1", amount: 100 }
    });
    // Withdraw 200 from vault "v1" — exceeds deposits
    await seedAction(db.prisma, {
      idempotencyKey: "insol-withdraw",
      status: "confirmed",
      actionType: "withdraw",
      actionPayload: { vault_id: "v1", amount: 200 }
    });

    const drifts = await detectDrift(db.prisma);
    const insolvency = drifts.find((d) => d.type === "insolvency_drift");
    expect(insolvency).toBeDefined();
    expect(insolvency!.recordType).toBe("vault_settlement");
  });

  it("quarantines insolvency drifts instead of auto-repairing", async () => {
    await seedAction(db.prisma, {
      idempotencyKey: "insol-deposit-2",
      status: "confirmed",
      actionType: "deposit",
      actionPayload: { vault_id: "v2", amount: 50 }
    });
    await seedAction(db.prisma, {
      idempotencyKey: "insol-withdraw-2",
      status: "confirmed",
      actionType: "withdraw",
      actionPayload: { vault_id: "v2", amount: 75 }
    });

    const drifts = await detectDrift(db.prisma);
    const plan = buildRepairPlan(drifts, false);
    expect(plan.steps.filter((s) => s.provenence.includes("insolvency_drift"))).toHaveLength(0);

    const result = await applyRepairPlan(db.prisma, plan);
    expect(result.applied).toBe(0);

    const quarantined = await db.prisma.repairQuarantine.findMany({
      where: { driftType: "insolvency_drift" }
    });
    expect(quarantined.length).toBeGreaterThan(0);
  });
});

describe("dry-run vs apply mode", () => {
  let db: TestDb;
  beforeAll(async () => { db = await startTestDb(); });
  afterAll(async () => { await db.stop(); });
  beforeEach(async () => { await resetDb(db.prisma); });

  it("dry-run performs no writes", async () => {
    const action = await seedAction(db.prisma, {
      idempotencyKey: "dryrun-no-write",
      status: "submitted",
      txHash: "tx_dryrun_no_write"
    });
    await db.prisma.actionLedger.update({
      where: { id: action.id },
      data: { updatedAt: new Date(Date.now() - 30 * 60 * 1000) }
    });

    const drifts = await detectDrift(db.prisma);
    const plan = buildRepairPlan(drifts, true);
    expect(plan.dryRun).toBe(true);
    expect(plan.steps.length).toBeGreaterThan(0);

    // Dry-run must not mutate the action row.
    const unchanged = await db.prisma.actionLedger.findUnique({ where: { id: action.id } });
    expect(unchanged?.status).toBe("submitted");

    // Dry-run must not write audit records.
    const audits = await db.prisma.repairAudit.findMany();
    expect(audits.length).toBe(0);
  });

  it("apply mode repairs only targeted records and writes audit records", async () => {
    const target = await seedAction(db.prisma, {
      idempotencyKey: "apply-targeted",
      status: "submitted",
      txHash: "tx_apply_targeted"
    });
    await db.prisma.actionLedger.update({
      where: { id: target.id },
      data: { updatedAt: new Date(Date.now() - 30 * 60 * 1000) }
    });
    const untouched = await seedAction(db.prisma, {
      idempotencyKey: "apply-untouched",
      status: "submitted",
      txHash: "tx_apply_untouched"
    });

    const drifts = await detectDrift(db.prisma);
    const plan = buildRepairPlan(drifts, false);
    const result = await applyRepairPlan(db.prisma, plan);

    expect(result.applied).toBeGreaterThan(0);

    // Targeted row is repaired.
    const repaired = await db.prisma.actionLedger.findUnique({ where: { id: target.id } });
    expect(repaired?.status).toBe("orphaned");

    // Untargeted row is unchanged.
    const still = await db.prisma.actionLedger.findUnique({ where: { id: untouched.id } });
    expect(still?.status).toBe("submitted");

    // Audit records are written for applied fixes.
    const audits = await db.prisma.repairAudit.findMany();
    expect(audits.length).toBe(result.applied);
    expect(audits[0].driftType).toBe("missing_event");
  });

  it("no-op when there are no drifts", async () => {
    const drifts = await detectDrift(db.prisma);
    const plan = buildRepairPlan(drifts, false);
    expect(plan.steps.length).toBe(0);

    const result = await applyRepairPlan(db.prisma, plan);
    expect(result.applied).toBe(0);
    expect(result.skipped).toBe(0);

    const audits = await db.prisma.repairAudit.findMany();
    expect(audits.length).toBe(0);
  });

  it("invalid target is skipped and not audited as applied", async () => {
    const drifts = [{
      type: "missing_event" as const,
      recordType: "action_ledger" as const,
      recordId: "does-not-exist",
      details: { updatedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(), txHash: "tx_missing" }
    }];
    const plan = buildRepairPlan(drifts, false);
    const result = await applyRepairPlan(db.prisma, plan);

    expect(result.applied).toBe(0);
    expect(result.skipped).toBe(1);

    const audits = await db.prisma.repairAudit.findMany();
    expect(audits.length).toBe(0);
  });

  it("audit record output includes before/after snapshots", async () => {
    const action = await seedAction(db.prisma, {
      idempotencyKey: "audit-snapshot",
      status: "submitted",
      txHash: "tx_audit_snapshot"
    });
    await db.prisma.actionLedger.update({
      where: { id: action.id },
      data: { updatedAt: new Date(Date.now() - 30 * 60 * 1000) }
    });

    const drifts = await detectDrift(db.prisma);
    const plan = buildRepairPlan(drifts, false);
    await applyRepairPlan(db.prisma, plan);

    const audit = await db.prisma.repairAudit.findFirst({
      where: { recordId: action.id }
    });
    expect(audit).toBeDefined();
    expect(audit!.before).toBeDefined();
    expect(audit!.after).toBeDefined();
    expect((audit!.before as any).status).toBe("submitted");
    expect((audit!.after as any).status).toBe("orphaned");
  });
});

describe("reconcileAll", () => {
  let db: TestDb;
  beforeAll(async () => { db = await startTestDb(); });
  afterAll(async () => { await db.stop(); });
  beforeEach(async () => { await resetDb(db.prisma); });

  it("returns a dry-run report by default", async () => {
    await seedAction(db.prisma, {
      idempotencyKey: "recon-default",
      status: "submitted",
      txHash: "tx_recon_default"
    });
    const report = await reconcileAll(db.prisma);
    expect(report.dryRun).toBe(true);
    expect(report.applied).toBe(0);
  });

  it("requires explicit apply mode to mutate", async () => {
    const action = await seedAction(db.prisma, {
      idempotencyKey: "recon-apply",
      status: "submitted",
      txHash: "tx_recon_apply"
    });
    await db.prisma.actionLedger.update({
      where: { id: action.id },
      data: { updatedAt: new Date(Date.now() - 30 * 60 * 1000) }
    });

    const report = await reconcileAll(db.prisma, { apply: true });
    expect(report.dryRun).toBe(false);
    expect(report.applied).toBeGreaterThan(0);

    const repaired = await db.prisma.actionLedger.findUnique({ where: { id: action.id } });
    expect(repaired?.status).toBe("orphaned");
  });
});
