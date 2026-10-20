/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles for PrismaClient and deliberately malformed receipts */
import { describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import {
  PrismaAuditTrailStore,
  PrismaLimitOverrideStore,
  PrismaReceiptStore,
  PrismaRecoveryCaseStore,
  ledgerRecoveryAdapter,
  prismaPendingActionSource,
  prismaReceiptActionSource,
} from "../src/services/governanceStores.js";
import {
  AuditSequenceConflictError,
  AuditTrailService,
  computeAuditRecordHash,
  type AuditRecord,
} from "../src/services/auditTrail.js";
import type { RecoveryCase } from "../src/services/pendingRecovery.js";
import type { StoredReceipt } from "../src/services/receipts.js";

// Prisma-backed stores for #812–#815 (no database required).

const UUID = "11111111-1111-4111-8111-111111111111";

function p2002() {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "test" });
}

describe("PrismaAuditTrailStore (#814)", () => {
  it("round-trips a record through the table without breaking its hash", async () => {
    const rows: any[] = [];
    const prisma = {
      auditTrailRecord: {
        findFirst: vi.fn(async () => (rows.length ? { sequence: rows.at(-1).sequence, recordHash: rows.at(-1).recordHash } : null)),
        create: vi.fn(async ({ data }: any) => {
          // Emulate Postgres: JSON null columns come back as null, timestamps as Date.
          rows.push({
            ...data,
            before: data.before === Prisma.DbNull ? null : data.before,
            after: data.after === Prisma.DbNull ? null : data.after,
            metadata: data.metadata === Prisma.DbNull ? null : data.metadata,
          });
        }),
        findMany: vi.fn(async (args: any) =>
          rows
            .filter((r) => args?.where?.sequence?.gt === undefined || r.sequence > args.where.sequence.gt)
            .slice(0, args?.take ?? rows.length)
            .map((r) => ({ ...r })),
        ),
      },
    } as any;
    const store = new PrismaAuditTrailStore(prisma);
    const trail = new AuditTrailService(store);

    const written = await trail.record({
      category: "access",
      action: "session.revoke",
      actor: { subject: "GUSER", role: "user" },
      target: { type: "wallet_session", id: "s1" },
      before: { revokedAt: null },
      after: { revokedAt: "2026-09-29T10:00:00.000Z" },
      occurredAt: "2026-09-29T10:00:00Z", // non-canonical input is normalised
    });
    expect(prisma.auditTrailRecord.create.mock.calls[0][0].data.metadata).toBe(Prisma.DbNull);

    const [read] = await store.scan(0, 10);
    expect(read).toEqual(written);
    const { recordHash, ...payload } = read as AuditRecord;
    expect(computeAuditRecordHash(payload)).toBe(recordHash);
    expect((await trail.verify()).ok).toBe(true);
  });

  it("maps a unique-sequence violation to AuditSequenceConflictError", async () => {
    const record: AuditRecord = {
      id: UUID,
      sequence: 7,
      category: "access",
      action: "session.revoke",
      actor: { subject: "GUSER", role: "user" },
      target: { type: "wallet_session", id: "s1" },
      reason: null,
      before: null,
      after: null,
      metadata: null,
      redactedFields: [],
      occurredAt: "2026-09-29T10:00:00.000Z",
      prevHash: "0".repeat(64),
      recordHash: "f".repeat(64),
    };
    const prisma = { auditTrailRecord: { create: vi.fn(async () => { throw p2002(); }) } } as any;
    await expect(new PrismaAuditTrailStore(prisma).append(record)).rejects.toBeInstanceOf(AuditSequenceConflictError);

    const boom = { auditTrailRecord: { create: vi.fn(async () => { throw new Error("db down"); }) } } as any;
    await expect(new PrismaAuditTrailStore(boom).append(record)).rejects.toThrow("db down");
  });

  it("builds filtered, cursor-bounded queries", async () => {
    const findMany = vi.fn(async () => []);
    const store = new PrismaAuditTrailStore({ auditTrailRecord: { findMany } } as any);
    await store.query({ category: "access", actorSubject: "GA", since: "2026-09-01T00:00:00.000Z", beforeSequence: 50, limit: 26 });
    expect(findMany).toHaveBeenCalledWith({
      where: {
        sequence: { lt: 50 },
        category: "access",
        actorSubject: "GA",
        occurredAt: { gte: new Date("2026-09-01T00:00:00.000Z") },
      },
      orderBy: { sequence: "desc" },
      take: 26,
    });
  });
});

describe("PrismaReceiptStore (#812)", () => {
  const receipt = {
    payload: { receiptId: "rcpt_1", actionId: UUID, stage: "requested" },
    algorithm: "ed25519",
    keyId: "GKEY",
    signature: "sig",
    issuedAt: "2026-09-29T10:00:00.000Z",
  } as unknown as StoredReceipt;

  it("inserts a new receipt", async () => {
    const create = vi.fn(async (_args: any) => ({}));
    const result = await new PrismaReceiptStore({ actionReceipt: { create } } as any).insertIfAbsent(receipt);
    expect(result.created).toBe(true);
    expect(create.mock.calls[0]![0]).toMatchObject({ data: { receiptId: "rcpt_1", actionId: UUID, stage: "requested", keyId: "GKEY" } });
  });

  it("returns the stored receipt on a duplicate insert", async () => {
    const stored = { receiptId: "rcpt_1", payload: receipt.payload, algorithm: "ed25519", keyId: "GKEY", signature: "first", issuedAt: new Date("2026-09-29T09:00:00.000Z") };
    const prisma = { actionReceipt: { create: vi.fn(async () => { throw p2002(); }), findUnique: vi.fn(async () => stored) } } as any;
    const result = await new PrismaReceiptStore(prisma).insertIfAbsent(receipt);
    expect(result).toMatchObject({ created: false, receipt: { signature: "first", issuedAt: "2026-09-29T09:00:00.000Z" } });
  });
});

describe("PrismaRecoveryCaseStore (#813)", () => {
  const c: RecoveryCase = {
    id: `rec_${UUID}`,
    actionId: UUID,
    walletAddress: "GA",
    actionType: "deposit",
    state: "retryable",
    attempts: 1,
    maxAttempts: 3,
    staleSince: "2026-09-29T10:00:00.000Z",
    detectedAt: "2026-09-29T10:30:00.000Z",
    lastAttemptAt: null,
    lastError: null,
    resolution: null,
    version: 2,
    updatedAt: "2026-09-29T10:31:00.000Z",
  };

  it("updates only when the version matches (optimistic concurrency)", async () => {
    const updateMany = vi.fn().mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    const store = new PrismaRecoveryCaseStore({ recoveryCase: { updateMany } } as any);
    expect(await store.update(c, 1)).toEqual(c);
    expect(await store.update(c, 1)).toBeNull();
    expect(updateMany.mock.calls[0]![0].where).toEqual({ id: c.id, version: 1 });
  });

  it("returns the existing case when the action already has one", async () => {
    const row = { ...c, staleSince: new Date(c.staleSince), detectedAt: new Date(c.detectedAt), updatedAt: new Date(c.updatedAt), lastAttemptAt: null };
    const prisma = { recoveryCase: { create: vi.fn(async () => { throw p2002(); }), findUnique: vi.fn(async () => row) } } as any;
    expect(await new PrismaRecoveryCaseStore(prisma).insertIfAbsent(c)).toEqual({ recoveryCase: c, created: false });
  });

  it("counts cases by state", async () => {
    const groupBy = vi.fn(async () => [{ state: "retryable", _count: { _all: 2 } }, { state: "failed", _count: { _all: 1 } }]);
    expect(await new PrismaRecoveryCaseStore({ recoveryCase: { groupBy } } as any).countByState()).toEqual({ retryable: 2, failed: 1 });
  });
});

describe("PrismaLimitOverrideStore (#815)", () => {
  it("finds only unrevoked, unexpired overrides for the scope", async () => {
    const findFirst = vi.fn(async (_args: any) => null);
    const at = new Date("2026-09-29T10:00:00.000Z");
    await new PrismaLimitOverrideStore({ limitOverride: { findFirst } } as any).findActive("action.create", "wallet:ga", at);
    expect(findFirst.mock.calls[0]![0].where).toEqual({ operation: "action.create", scopeKey: "wallet:ga", revokedAt: null, expiresAt: { gt: at } });
  });

  it("revokes once", async () => {
    const updateMany = vi.fn().mockResolvedValueOnce({ count: 0 });
    const store = new PrismaLimitOverrideStore({ limitOverride: { updateMany } } as any);
    expect(await store.revoke(UUID, "GADMIN", new Date())).toBeNull();
    expect(await store.revoke("not-a-uuid", "GADMIN", new Date())).toBeNull();
    expect(updateMany).toHaveBeenCalledTimes(1);
  });
});

describe("ActionLedger adapters (#812 #813)", () => {
  it("queries stale in-flight actions and skips non-UUID ids", async () => {
    const findMany = vi.fn(async () => []);
    const count = vi.fn(async () => 4);
    const findUnique = vi.fn(async () => null);
    const source = prismaPendingActionSource({ actionLedger: { findMany, count, findUnique } } as any);
    const cutoff = new Date("2026-09-29T09:30:00.000Z");

    await source.listStale(cutoff, 25);
    expect(findMany).toHaveBeenCalledWith({
      where: { status: { in: ["pending", "submitted"] }, updatedAt: { lte: cutoff } },
      orderBy: { updatedAt: "asc" },
      take: 25,
    });
    expect(await source.countStale(cutoff)).toBe(4);
    expect(await source.getAction("../etc/passwd")).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("looks receipts' actions up by tx hash", async () => {
    const findUnique = vi.fn(async () => ({ id: UUID }));
    const source = prismaReceiptActionSource({ actionLedger: { findUnique } } as any);
    expect(await source.findByTxHash("ab")).toEqual({ id: UUID });
    expect(findUnique).toHaveBeenCalledWith({ where: { txHash: "ab" } });
  });

  it("routes manual failure through LedgerService.cancelAction", async () => {
    const cancelAction = vi.fn(async () => ({}));
    await ledgerRecoveryAdapter({ cancelAction }).markFailed(UUID, "RECOVERY_MANUAL_FAILED", "abandoned");
    expect(cancelAction).toHaveBeenCalledWith(UUID, "RECOVERY_MANUAL_FAILED", "abandoned");
  });
});
