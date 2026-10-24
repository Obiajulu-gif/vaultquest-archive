/**
 * Prisma-backed stores for #812 (receipts), #813 (recovery cases),
 * #814 (audit trail) and #815 (limit overrides), plus adapters over the
 * existing ActionLedger table.
 *
 * Each class implements the store interface its service already exercises
 * with an in-memory implementation in tests, so the business rules are
 * identical in both. Concurrency is delegated to database constraints:
 *  - audit_trail.sequence is UNIQUE  → a lost race surfaces as
 *    AuditSequenceConflictError and the service re-reads the head and retries;
 *  - action_receipts.receipt_id is the PK → duplicate issuance returns the
 *    stored receipt;
 *  - recovery_cases.action_id is UNIQUE and updates are conditional on
 *    `version` (optimistic concurrency).
 */

import { Prisma, type PrismaClient } from "@prisma/client";
import {
  AuditSequenceConflictError,
  type AuditQuery,
  type AuditRecord,
  type AuditState,
  type AuditTrailStore,
} from "./auditTrail.js";
import {
  RECEIPT_STAGES,
  type ReceiptActionSnapshot,
  type ReceiptActionSource,
  type ReceiptPayload,
  type ReceiptStore,
  type StoredReceipt,
} from "./receipts.js";
import {
  IN_FLIGHT_STATUSES,
  type PendingActionSnapshot,
  type PendingActionSource,
  type RecoveryCase,
  type RecoveryCaseStore,
  type RecoveryLedger,
} from "./pendingRecovery.js";
import type { LimitOverride, LimitOverrideStore, OperationName } from "./operationLimits.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

function json(value: AuditState | Record<string, unknown> | null): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value === null ? Prisma.DbNull : (value as Prisma.InputJsonValue);
}

// ─── #814 audit trail ────────────────────────────────────────────────────────

type AuditRow = {
  id: string;
  sequence: number;
  category: string;
  action: string;
  actorSubject: string;
  actorRole: string;
  targetType: string;
  targetId: string;
  reason: string | null;
  before: unknown;
  after: unknown;
  metadata: unknown;
  redactedFields: string[];
  occurredAt: Date;
  prevHash: string;
  recordHash: string;
};

function toAuditRecord(row: AuditRow): AuditRecord {
  return {
    id: row.id,
    sequence: row.sequence,
    category: row.category as AuditRecord["category"],
    action: row.action,
    actor: { subject: row.actorSubject, role: row.actorRole as AuditRecord["actor"]["role"] },
    target: { type: row.targetType, id: row.targetId },
    reason: row.reason,
    before: (row.before ?? null) as AuditState | null,
    after: (row.after ?? null) as AuditState | null,
    metadata: (row.metadata ?? null) as AuditState | null,
    redactedFields: row.redactedFields,
    occurredAt: row.occurredAt.toISOString(),
    prevHash: row.prevHash,
    recordHash: row.recordHash,
  };
}

function auditWhere(q: AuditQuery & { beforeSequence?: number }): Prisma.AuditTrailRecordWhereInput {
  return {
    ...(q.beforeSequence !== undefined ? { sequence: { lt: q.beforeSequence } } : {}),
    ...(q.category ? { category: q.category } : {}),
    ...(q.action ? { action: q.action } : {}),
    ...(q.actorSubject ? { actorSubject: q.actorSubject } : {}),
    ...(q.targetType ? { targetType: q.targetType } : {}),
    ...(q.targetId ? { targetId: q.targetId } : {}),
    ...(q.since || q.until
      ? {
          occurredAt: {
            ...(q.since ? { gte: new Date(q.since) } : {}),
            ...(q.until ? { lt: new Date(q.until) } : {}),
          },
        }
      : {}),
  };
}

export class PrismaAuditTrailStore implements AuditTrailStore {
  constructor(private readonly prisma: PrismaClient) {}

  async head() {
    const row = await this.prisma.auditTrailRecord.findFirst({
      orderBy: { sequence: "desc" },
      select: { sequence: true, recordHash: true },
    });
    return row ?? null;
  }

  async append(record: AuditRecord): Promise<void> {
    try {
      await this.prisma.auditTrailRecord.create({
        data: {
          id: record.id,
          sequence: record.sequence,
          category: record.category,
          action: record.action,
          actorSubject: record.actor.subject,
          actorRole: record.actor.role,
          targetType: record.target.type,
          targetId: record.target.id,
          reason: record.reason,
          before: json(record.before),
          after: json(record.after),
          metadata: json(record.metadata),
          redactedFields: record.redactedFields,
          occurredAt: new Date(record.occurredAt),
          prevHash: record.prevHash,
          recordHash: record.recordHash,
        },
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new AuditSequenceConflictError(record.sequence);
      throw err;
    }
  }

  async query(q: AuditQuery & { beforeSequence?: number; limit: number }): Promise<AuditRecord[]> {
    const rows = await this.prisma.auditTrailRecord.findMany({
      where: auditWhere(q),
      orderBy: { sequence: "desc" },
      take: q.limit,
    });
    return rows.map((r) => toAuditRecord(r as AuditRow));
  }

  async scan(afterSequence: number, limit: number): Promise<AuditRecord[]> {
    const rows = await this.prisma.auditTrailRecord.findMany({
      where: { sequence: { gt: afterSequence } },
      orderBy: { sequence: "asc" },
      take: limit,
    });
    return rows.map((r) => toAuditRecord(r as AuditRow));
  }
}

// ─── #812 receipts ───────────────────────────────────────────────────────────

type ReceiptRow = {
  receiptId: string;
  payload: unknown;
  algorithm: string;
  keyId: string;
  signature: string;
  issuedAt: Date;
};

function toStoredReceipt(row: ReceiptRow): StoredReceipt {
  return {
    payload: row.payload as ReceiptPayload,
    algorithm: row.algorithm as StoredReceipt["algorithm"],
    keyId: row.keyId,
    signature: row.signature,
    issuedAt: row.issuedAt.toISOString(),
  };
}

export class PrismaReceiptStore implements ReceiptStore {
  constructor(private readonly prisma: PrismaClient) {}

  async insertIfAbsent(receipt: StoredReceipt) {
    try {
      await this.prisma.actionReceipt.create({
        data: {
          receiptId: receipt.payload.receiptId,
          actionId: receipt.payload.actionId,
          stage: receipt.payload.stage,
          payload: receipt.payload as unknown as Prisma.InputJsonValue,
          algorithm: receipt.algorithm,
          keyId: receipt.keyId,
          signature: receipt.signature,
          issuedAt: new Date(receipt.issuedAt),
        },
      });
      return { receipt, created: true };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const existing = await this.get(receipt.payload.receiptId);
      if (!existing) throw err;
      return { receipt: existing, created: false };
    }
  }

  async get(receiptId: string) {
    const row = await this.prisma.actionReceipt.findUnique({ where: { receiptId } });
    return row ? toStoredReceipt(row as ReceiptRow) : null;
  }

  async listByAction(actionId: string) {
    if (!UUID.test(actionId)) return [];
    const rows = await this.prisma.actionReceipt.findMany({ where: { actionId } });
    return rows
      .map((r) => toStoredReceipt(r as ReceiptRow))
      .sort((a, b) => RECEIPT_STAGES.indexOf(a.payload.stage) - RECEIPT_STAGES.indexOf(b.payload.stage));
  }
}

// ─── #813 recovery cases ─────────────────────────────────────────────────────

type CaseRow = {
  id: string;
  actionId: string;
  walletAddress: string;
  actionType: string;
  state: string;
  attempts: number;
  maxAttempts: number;
  staleSince: Date;
  detectedAt: Date;
  lastAttemptAt: Date | null;
  lastError: string | null;
  resolution: unknown;
  version: number;
  updatedAt: Date;
};

function toCase(row: CaseRow): RecoveryCase {
  return {
    id: row.id,
    actionId: row.actionId,
    walletAddress: row.walletAddress,
    actionType: row.actionType,
    state: row.state as RecoveryCase["state"],
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    staleSince: row.staleSince.toISOString(),
    detectedAt: row.detectedAt.toISOString(),
    lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
    lastError: row.lastError,
    resolution: (row.resolution ?? null) as RecoveryCase["resolution"],
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function caseData(c: RecoveryCase) {
  return {
    walletAddress: c.walletAddress,
    actionType: c.actionType,
    state: c.state,
    attempts: c.attempts,
    maxAttempts: c.maxAttempts,
    staleSince: new Date(c.staleSince),
    detectedAt: new Date(c.detectedAt),
    lastAttemptAt: c.lastAttemptAt ? new Date(c.lastAttemptAt) : null,
    lastError: c.lastError,
    resolution: json(c.resolution as Record<string, unknown> | null),
    version: c.version,
    updatedAt: new Date(c.updatedAt),
  };
}

export class PrismaRecoveryCaseStore implements RecoveryCaseStore {
  constructor(private readonly prisma: PrismaClient) {}

  async get(id: string) {
    const row = await this.prisma.recoveryCase.findUnique({ where: { id } });
    return row ? toCase(row as CaseRow) : null;
  }

  async getByAction(actionId: string) {
    if (!UUID.test(actionId)) return null;
    const row = await this.prisma.recoveryCase.findUnique({ where: { actionId } });
    return row ? toCase(row as CaseRow) : null;
  }

  async insertIfAbsent(c: RecoveryCase) {
    try {
      await this.prisma.recoveryCase.create({ data: { id: c.id, actionId: c.actionId, ...caseData(c) } });
      return { recoveryCase: c, created: true };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const existing = await this.getByAction(c.actionId);
      if (!existing) throw err;
      return { recoveryCase: existing, created: false };
    }
  }

  async update(next: RecoveryCase, expectedVersion: number) {
    const result = await this.prisma.recoveryCase.updateMany({
      where: { id: next.id, version: expectedVersion },
      data: caseData(next),
    });
    return result.count === 1 ? next : null;
  }

  async list(filter: { state?: RecoveryCase["state"]; limit: number }) {
    const rows = await this.prisma.recoveryCase.findMany({
      where: filter.state ? { state: filter.state } : {},
      orderBy: { staleSince: "asc" },
      take: filter.limit,
    });
    return rows.map((r) => toCase(r as CaseRow));
  }

  async countByState() {
    const groups = await this.prisma.recoveryCase.groupBy({ by: ["state"], _count: { _all: true } });
    const counts: Partial<Record<RecoveryCase["state"], number>> = {};
    for (const g of groups) counts[g.state as RecoveryCase["state"]] = g._count._all;
    return counts;
  }
}

// ─── #815 limit overrides ────────────────────────────────────────────────────

type OverrideRow = {
  id: string;
  operation: string;
  scopeKey: string;
  limitValue: number;
  reason: string;
  grantedBy: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedBy: string | null;
};

function toOverride(row: OverrideRow): LimitOverride {
  return {
    id: row.id,
    operation: row.operation as OperationName,
    scopeKey: row.scopeKey,
    limit: row.limitValue,
    reason: row.reason,
    grantedBy: row.grantedBy,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    revokedBy: row.revokedBy,
  };
}

export class PrismaLimitOverrideStore implements LimitOverrideStore {
  constructor(private readonly prisma: PrismaClient) {}

  async insert(o: LimitOverride) {
    await this.prisma.limitOverride.create({
      data: {
        id: o.id,
        operation: o.operation,
        scopeKey: o.scopeKey,
        limitValue: o.limit,
        reason: o.reason,
        grantedBy: o.grantedBy,
        createdAt: new Date(o.createdAt),
        expiresAt: new Date(o.expiresAt),
        revokedAt: o.revokedAt ? new Date(o.revokedAt) : null,
        revokedBy: o.revokedBy,
      },
    });
  }

  async get(id: string) {
    if (!UUID.test(id)) return null;
    const row = await this.prisma.limitOverride.findUnique({ where: { id } });
    return row ? toOverride(row as OverrideRow) : null;
  }

  async findActive(operation: OperationName, scopeKey: string, at: Date) {
    const row = await this.prisma.limitOverride.findFirst({
      where: { operation, scopeKey, revokedAt: null, expiresAt: { gt: at } },
      orderBy: { createdAt: "desc" },
    });
    return row ? toOverride(row as OverrideRow) : null;
  }

  async list(filter: { operation?: OperationName; scopeKey?: string; activeAt?: Date }) {
    const rows = await this.prisma.limitOverride.findMany({
      where: {
        ...(filter.operation ? { operation: filter.operation } : {}),
        ...(filter.scopeKey ? { scopeKey: filter.scopeKey } : {}),
        ...(filter.activeAt ? { revokedAt: null, expiresAt: { gt: filter.activeAt } } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 500,
    });
    return rows.map((r) => toOverride(r as OverrideRow));
  }

  async revoke(id: string, revokedBy: string, at: Date) {
    if (!UUID.test(id)) return null;
    const result = await this.prisma.limitOverride.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: at, revokedBy },
    });
    return result.count === 1 ? this.get(id) : null;
  }
}

// ─── ActionLedger adapters ───────────────────────────────────────────────────

type LedgerRow = ReceiptActionSnapshot & PendingActionSnapshot;

async function findAction(prisma: PrismaClient, id: string): Promise<LedgerRow | null> {
  // Non-UUID ids can't exist and would make Postgres raise a cast error.
  if (!UUID.test(id)) return null;
  const row = await prisma.actionLedger.findUnique({ where: { id } });
  return (row as unknown as LedgerRow) ?? null;
}

export function prismaReceiptActionSource(prisma: PrismaClient): ReceiptActionSource {
  return {
    getAction: (id) => findAction(prisma, id),
    async findByTxHash(txHash) {
      const row = await prisma.actionLedger.findUnique({ where: { txHash } });
      return (row as unknown as ReceiptActionSnapshot) ?? null;
    },
  };
}

export function prismaPendingActionSource(prisma: PrismaClient): PendingActionSource {
  const where = (cutoff: Date): Prisma.ActionLedgerWhereInput => ({
    status: { in: IN_FLIGHT_STATUSES as Prisma.EnumActionStatusFilter["in"] },
    updatedAt: { lte: cutoff },
  });
  return {
    getAction: (id) => findAction(prisma, id),
    async listStale(cutoff, limit) {
      const rows = await prisma.actionLedger.findMany({
        where: where(cutoff),
        orderBy: { updatedAt: "asc" },
        take: limit,
      });
      return rows as unknown as PendingActionSnapshot[];
    },
    countStale: (cutoff) => prisma.actionLedger.count({ where: where(cutoff) }),
  };
}

/** Manual "resolve as failed" goes through the ledger's own transition rules. */
export function ledgerRecoveryAdapter(ledger: {
  cancelAction(id: string, errorCode: string, errorDetail?: string): Promise<unknown>;
}): RecoveryLedger {
  return {
    async markFailed(actionId, errorCode, detail) {
      await ledger.cancelAction(actionId, errorCode, detail);
    },
  };
}
