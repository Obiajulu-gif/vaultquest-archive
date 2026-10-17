import type { PrismaClient, SideEffectLedger } from "@prisma/client";
import type { BeginInput, BeginOutcome, EffectLedger, EffectRecord, EffectStatus, ListEffectsParams } from "./effectLedger.js";

function toRecord(row: SideEffectLedger): EffectRecord {
  return {
    key: row.effectKey,
    type: row.effectType,
    status: row.status as EffectStatus,
    attempts: row.attempts,
    lockedBy: row.lockedBy,
    lockedAt: row.lockedAt,
    lastError: row.lastError,
    result: row.result ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt
  };
}

/**
 * Postgres-backed ledger. Claims are optimistic compare-and-swap
 * (`updateMany` conditioned on the row still being claimable), so two workers
 * racing for one key never both win, and no row lock is held while the effect runs.
 */
export class PrismaEffectLedger implements EffectLedger {
  constructor(private readonly prisma: PrismaClient) {}

  async begin({ key, type, owner, now, leaseMs }: BeginInput): Promise<BeginOutcome> {
    const existing = await this.prisma.sideEffectLedger.findUnique({ where: { effectKey: key } });
    if (!existing) {
      try {
        const row = await this.prisma.sideEffectLedger.create({
          data: { effectKey: key, effectType: type, status: "in_progress", attempts: 1, lockedBy: owner, lockedAt: now }
        });
        return { claimed: true, record: toRecord(row) };
      } catch (err) {
        // Lost the race with a concurrent first claim of the same key.
        if ((err as { code?: string } | null)?.code !== "P2002") throw err;
      }
    } else if (existing.status === "completed") {
      return { claimed: false, record: toRecord(existing) };
    }

    const cutoff = new Date(now.getTime() - leaseMs);
    const res = await this.prisma.sideEffectLedger.updateMany({
      where: {
        effectKey: key,
        OR: [{ status: "failed" }, { status: "in_progress", lockedAt: { lt: cutoff } }]
      },
      data: { status: "in_progress", attempts: { increment: 1 }, lockedBy: owner, lockedAt: now }
    });
    const row = await this.prisma.sideEffectLedger.findUnique({ where: { effectKey: key } });
    if (!row) throw new Error(`side effect ledger row for ${key} disappeared during claim`);
    return { claimed: res.count === 1, record: toRecord(row) };
  }

  async complete(key: string, owner: string, result: unknown, now: Date) {
    const res = await this.prisma.sideEffectLedger.updateMany({
      where: { effectKey: key, status: "in_progress", lockedBy: owner },
      data: {
        status: "completed",
        ...(result !== undefined && result !== null ? { result: result as object } : {}),
        lastError: null,
        lockedBy: null,
        lockedAt: null,
        completedAt: now
      }
    });
    return res.count === 1;
  }

  async fail(key: string, owner: string, errorCode: string, _now: Date) {
    const res = await this.prisma.sideEffectLedger.updateMany({
      where: { effectKey: key, status: "in_progress", lockedBy: owner },
      data: { status: "failed", lastError: errorCode, lockedBy: null, lockedAt: null }
    });
    return res.count === 1;
  }

  async get(key: string) {
    const row = await this.prisma.sideEffectLedger.findUnique({ where: { effectKey: key } });
    return row ? toRecord(row) : null;
  }

  async list({ status, type, limit = 50 }: ListEffectsParams = {}) {
    const rows = await this.prisma.sideEffectLedger.findMany({
      where: { ...(status ? { status } : {}), ...(type ? { effectType: type } : {}) },
      orderBy: { createdAt: "desc" },
      take: limit
    });
    return rows.map(toRecord);
  }
}
