import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { startTestDb, type TestDb } from "./helpers/db.js";
import { LedgerService } from "../src/services/ledger.js";
import { verifyEventLog, eventBatchHash } from "../src/services/eventLogIntegrity.js";
import { StellarIndexer, sorobanNativeXdrDecoder, type RawHorizonEvent } from "../src/services/stellarIndexer.js";
import { LeaseService } from "../src/services/leaseService.js";
import { LeaseIndexerFence, PrismaProjectionRebuildStore, PrismaProjectionTarget, ProjectionRebuildService } from "../src/services/projectionRebuild.js";
import { captureBackupSnapshot, validateBackupSnapshot } from "../src/services/backupSnapshot.js";
import { AuditTrailService } from "../src/services/auditTrail.js";
import { PrismaAuditTrailStore } from "../src/services/governanceStores.js";

let db: TestDb;
let ledger: LedgerService;
const actor = { role: "maintainer" as const, subject: "fixture-maintainer" };
function event(index: number, overrides: Partial<RawHorizonEvent> = {}): RawHorizonEvent {
  return { id: `0000000429496729600-${String(index).padStart(10, "0")}`, ledger: 100,
    ledgerClosedAt: "2026-10-20T10:00:00.000Z", txHash: `fixture-tx-${index}`, contractId: "fixture-pool",
    topicXdr: [xdr.ScVal.scvSymbol("deposit").toXDR("base64")],
    valueXdr: nativeToScVal({ vault_id: "fixture-pool", amount: "100", version: 2 }).toXDR("base64"),
    successful: true, ...overrides };
}
async function seed(events: RawHorizonEvent[]) {
  for (const e of events) {
    await db.prisma.actionLedger.create({ data: { idempotencyKey: randomUUID(), walletAddress: "fixture-wallet",
      actionType: "deposit", actionPayload: { vault_id: "fixture-pool", amount: "100" }, status: "submitted", txHash: e.txHash } });
  }
  await ledger.appendChainEvents(events);
}
function service() {
  const target = new PrismaProjectionTarget(db.prisma, ledger, { decoder: sorobanNativeXdrDecoder, batchSize: 1 });
  const svc = new ProjectionRebuildService({ target, runs: new PrismaProjectionRebuildStore(db.prisma),
    fence: new LeaseIndexerFence(new LeaseService(db.prisma)),
    audit: new AuditTrailService(new PrismaAuditTrailStore(db.prisma)) });
  return { target, svc };
}
beforeAll(async () => { db = await startTestDb(); ledger = new LedgerService(db.prisma); });
afterAll(async () => { await db?.stop(); });
beforeEach(async () => {
  await db.prisma.$executeRawUnsafe("TRUNCATE TABLE action_ledger, action_leases, pending_events, poison_events, chain_events, chain_event_batches, projection_rebuilds, job_leases, indexer_checkpoints, pool_registry CASCADE");
});

describe("durable event log and production projection replay (#843)", () => {
  it("hashes original bytes deterministically, appends idempotently, and rejects changed duplicate IDs", async () => {
    const events = [event(2), event(1)];
    expect(eventBatchHash(events)).toBe(eventBatchHash([...events].reverse()));
    await ledger.appendChainEvents(events);
    await ledger.appendChainEvents(events);
    expect(await db.prisma.chainEvent.count()).toBe(2);
    expect(await db.prisma.chainEventBatch.count()).toBe(1);
    expect(await verifyEventLog(db.prisma)).toMatchObject({ batches: 1, eventsChecked: 2 });
    await expect(ledger.appendChainEvents([event(1, { valueXdr: "changed" })])).rejects.toMatchObject({ code: "ALTERED_EVENT" });
  });
  it("rebuilds unsorted real XDR fixtures in chain order with stable confirmation timestamps", async () => {
    await seed([event(3), event(1), event(2)]);
    const { svc } = service();
    const result = await (await svc.start({ actor, reason: "fixture rebuild" })).done;
    expect(result).toMatchObject({ status: "completed", eventsReplayed: 3, cursor: event(3).id });
    const project = () => db.prisma.actionLedger.findMany({ orderBy: { sorobanEventId: "asc" },
      select: { status: true, sorobanEventId: true, confirmedAt: true, verifiedPayload: true, recoveryCheckpoint: true } });
    const first = await project();
    expect(first.map((r) => r.sorobanEventId)).toEqual([event(1).id, event(2).id, event(3).id]);
    expect(first.every((r) => r.confirmedAt?.toISOString() === event(1).ledgerClosedAt)).toBe(true);
    expect((await (await svc.start({ actor, reason: "repeat rebuild" })).done).status).toBe("completed");
    expect(await project()).toEqual(first);
  });
  it("detects a missing event before destructive reset, even when it disappeared before the rebuild starts", async () => {
    await seed([event(1), event(2), event(3)]);
    await db.prisma.chainEvent.delete({ where: { id: event(2).id } });
    const { svc, target } = service();
    const reset = vi.spyOn(target, "resetProjections");
    await expect(svc.start({ actor, reason: "gap fixture" })).rejects.toThrow("MISSING_EVENT");
    expect(reset).not.toHaveBeenCalled();
    expect(await db.prisma.projectionRebuild.count()).toBe(0);
  });
  it("detects altered bytes and malformed raw envelopes", async () => {
    await seed([event(1)]);
    await db.prisma.chainEvent.update({ where: { id: event(1).id }, data: { valueXdr: "changed" } });
    await expect(verifyEventLog(db.prisma)).rejects.toMatchObject({ code: "ALTERED_EVENT" });
    await expect(ledger.appendChainEvents([event(2, { ledger: -1 })])).rejects.toMatchObject({ code: "MALFORMED_EVENT" });
  });
  it("quarantines malformed XDR, reports the gap, and leaves the live indexer fenced", async () => {
    await seed([event(1), event(2, { valueXdr: "invalid-xdr" }), event(3)]);
    const { svc } = service();
    const failed = await (await svc.start({ actor, reason: "malformed fixture" })).done;
    expect(failed).toMatchObject({ status: "failed", errorCode: "HALTED_ON_QUARANTINE", cursor: event(1).id });
    expect(await svc.isFenced()).toBe(true);
    expect(await db.prisma.actionLedger.count({ where: { status: "confirmed" } })).toBe(1);
    expect(await db.prisma.poisonEvent.count()).toBe(1);
  });
  it("halts on a partial replay write failure and resumes from the committed cursor", async () => {
    await seed([event(1), event(2), event(3)]);
    const original = ledger.reconcileEvents.bind(ledger);
    const spy = vi.spyOn(ledger, "reconcileEvents").mockImplementation(async (inputs) => {
      if (inputs[0]?.sorobanEventId === event(2).id) throw new Error("fixture database write failure");
      return original(inputs);
    });
    const { svc } = service();
    const failed = await (await svc.start({ actor, reason: "partial failure fixture" })).done;
    expect(failed).toMatchObject({ status: "failed", cursor: event(1).id });
    expect(await db.prisma.actionLedger.count({ where: { status: "confirmed" } })).toBe(1);
    spy.mockRestore();
    expect((await (await svc.resume(failed.id, actor)).done).status).toBe("completed");
    expect(await db.prisma.actionLedger.count({ where: { status: "confirmed" } })).toBe(3);
    expect(await svc.isFenced()).toBe(false);
  });
  it("does not advance past a failed registry write in a mixed batch", async () => {
    const events = [event(1), event(2, {
      topicXdr: [xdr.ScVal.scvSymbol("fpooldep").toXDR("base64")], contractId: "factory",
      valueXdr: nativeToScVal({ salt: "salt", pool_address: "pool", admin: "admin", asset: "asset", wasm_hash: "wasm" }).toXDR("base64"),
    }), event(3)];
    await seed(events);
    const indexer = new StellarIndexer({ ledger, decoder: sorobanNativeXdrDecoder, factoryAddress: "factory", source: { fetchEvents: async () => events } });
    const spy = vi.spyOn(ledger, "upsertPoolRegistryEntry").mockRejectedValueOnce(new Error("fixture registry failure"));
    await expect(indexer.tick()).rejects.toThrow("fixture registry failure");
    expect(indexer.getCursor()).toBe(event(1).id);
    expect(await db.prisma.actionLedger.count({ where: { status: "confirmed" } })).toBe(1);
    spy.mockRestore();
  });
  it("keeps registry events when they share a transaction with an action event", async () => {
    const events = [event(1), event(2, {
      txHash: event(1).txHash, topicXdr: [xdr.ScVal.scvSymbol("fpooldep").toXDR("base64")], contractId: "factory",
      valueXdr: nativeToScVal({ salt: "salt", pool_address: "pool", admin: "admin", asset: "asset", wasm_hash: "wasm" }).toXDR("base64"),
    }), event(3)];
    await seed([events[0]!, events[2]!]);
    const indexer = new StellarIndexer({ ledger, decoder: sorobanNativeXdrDecoder, factoryAddress: "factory", source: { fetchEvents: async () => events } });
    expect(await indexer.tick()).toMatchObject({ imported: 3, cursor: event(3).id });
    expect(await db.prisma.poolRegistry.count({ where: { poolAddress: "pool" } })).toBe(1);
  });
  it("captures real restored data read-only and validates its snapshot (#844)", async () => {
    await seed([event(1)]);
    await (await service().svc.start({ actor, reason: "snapshot fixture" })).done;
    const before = await db.prisma.actionLedger.findMany();
    const snapshot = await captureBackupSnapshot(db.prisma);
    expect(validateBackupSnapshot(snapshot)).toMatchObject({ readOnly: true, status: "valid" });
    expect(await db.prisma.actionLedger.findMany()).toEqual(before);
    snapshot.tables.action_ledger = [];
    expect(validateBackupSnapshot(snapshot).status).toBe("needs_review");
  });
  it("runs the operator replay and offline snapshot commands against real fixtures", async () => {
    await seed([event(1)]);
    const cwd = fileURLToPath(new URL("../", import.meta.url));
    const env = { ...process.env, DATABASE_URL: db.databaseUrl };
    const run = (script: string, args: string[]) => execFileSync(process.execPath,
      ["--import", "tsx", `src/scripts/${script}.ts`, ...args], { cwd, env, encoding: "utf8", timeout: 30000 });
    expect(JSON.parse(run("rebuildProjections", [])).readOnly).toBe(true);
    expect(await db.prisma.projectionRebuild.count()).toBe(0);
    expect(JSON.parse(run("rebuildProjections", ["--execute", "--actor", "fixture-operator", "--reason", "CLI fixture rebuild"])).status).toBe("completed");
    expect(await db.prisma.auditTrailRecord.count({ where: { action: "projection.rebuild.start", actorSubject: "fixture-operator" } })).toBe(1);
    const dir = mkdtempSync(join(tmpdir(), "vaultquest-snapshot-"));
    try {
      const file = join(dir, "validation.json");
      expect(JSON.parse(run("backupSnapshot", ["--output", file])).status).toBe("captured");
      expect(statSync(file).mode & 0o777).toBe(0o600);
      const before = readFileSync(file, "utf8");
      expect(JSON.parse(run("backupSnapshot", ["--snapshot", file])).status).toBe("valid");
      expect(readFileSync(file, "utf8")).toBe(before);
      expect(() => run("backupSnapshot", ["--output", file])).toThrow();
      expect(readFileSync(file, "utf8")).toBe(before);
    } finally { rmSync(dir, { recursive: true }); }
  });
});
