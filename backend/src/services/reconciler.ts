import type { PrismaClient } from "@prisma/client";
import { ERROR_CODES } from "../constants.js";

export type SweepResult = { orphaned: number; prunedEvents: number };

export async function sweepOrphans(
  prisma: PrismaClient,
  opts: { ttlMinutes: number }
): Promise<SweepResult> {
  const cutoff = new Date(Date.now() - opts.ttlMinutes * 60 * 1000);

  const stuck = await prisma.actionLedger.findMany({
    where: { status: "submitted", updatedAt: { lt: cutoff } },
    select: { id: true }
  });

  if (stuck.length > 0) {
    await prisma.actionLedger.updateMany({
      where: { id: { in: stuck.map((r: { id: string }) => r.id) } },
      data: { status: "orphaned", errorCode: ERROR_CODES.ORPHAN_TTL_EXPIRED }
    });
  }

  const pruneCutoff = new Date(Date.now() - 60 * 60 * 1000);
  const pruned = await prisma.pendingEvent.deleteMany({
    where: { receivedAt: { lt: pruneCutoff }, consumedAt: null }
  });

  return { orphaned: stuck.length, prunedEvents: pruned.count };
}

export type OutboundActionStatus = "pending" | "submitted" | "confirmed" | "failed";

export interface OutboundActionRecord {
  id: string;
  actionKey: string;
  actionType: string;
  payload: Record<string, unknown>;
  status: OutboundActionStatus;
  txHash: string | null;
  errorCode: string | null;
  errorDetail: string | null;
  attempts: number;
  maxAttempts: number;
  version: number;
  lastAttemptAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  confirmedAt: Date | null;
}

export interface OutboundActionInput {
  actionKey: string;
  actionType: string;
  payload: Record<string, unknown>;
  maxAttempts?: number;
}

export interface SubmitResult {
  record: OutboundActionRecord;
  newlySubmitted: boolean;
  txHash: string | null;
}

export class ReconciliationService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly submitFn: (payload: Record<string, unknown>) => Promise<{ txHash: string }>,
    private readonly checkChainFn: (txHash: string) => Promise<{ confirmed: boolean; errorCode?: string; errorDetail?: string }>
  ) {}

  async createOrGetOutboundAction(input: OutboundActionInput): Promise<OutboundActionRecord> {
    const maxAttempts = input.maxAttempts ?? 3;

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.outboundAction.findUnique({
        where: { actionKey: input.actionKey }
      });

      if (existing) {
        return existing as unknown as OutboundActionRecord;
      }

      const created = await tx.outboundAction.create({
        data: {
          actionKey: input.actionKey,
          actionType: input.actionType,
          payload: input.payload as object,
          status: "pending",
          attempts: 0,
          maxAttempts
        }
      });

      return created as unknown as OutboundActionRecord;
    });
  }

  async submitOutboundAction(actionKey: string): Promise<SubmitResult> {
    // Use atomic compare-and-swap to prevent concurrent submissions
    // First, try to atomically claim the action by updating status from pending to submitted
    try {
      const claimed = await this.prisma.$transaction(async (tx) => {
      const record = await tx.outboundAction.findUnique({ where: { actionKey } });
      if (!record) {
        throw new Error(`Outbound action ${actionKey} not found`);
      }

      if (record.status === "confirmed") {
        return { record: record as unknown as OutboundActionRecord, newlySubmitted: false, txHash: null };
      }

      if (record.status === "submitted" && record.txHash) {
        const chainResult = await this.checkChainFn(record.txHash);
        if (chainResult.confirmed) {
          await tx.outboundAction.update({
            where: { actionKey },
            data: {
              status: "confirmed",
              confirmedAt: new Date(),
              errorCode: null,
              errorDetail: null
            }
          });
          return { record: { ...record, status: "confirmed", confirmedAt: new Date() } as OutboundActionRecord, newlySubmitted: false, txHash: null };
        }
      }

      if (record.attempts >= (record.maxAttempts ?? 3)) {
        throw new Error(`Max attempts (${record.maxAttempts}) exceeded for action ${actionKey}`);
      }

      // Only proceed if status is pending, submitted without txHash, or failed (for retry)
      if (record.status !== "pending" && !(record.status === "submitted" && !record.txHash) && record.status !== "failed") {
        return { record: record as unknown as OutboundActionRecord, newlySubmitted: false, txHash: null };
      }

      // Try to atomically claim this action by updating status to "submitted" with a placeholder
      // We'll generate the actual txHash after claiming
      // Allow claiming failed actions for retry
      const claimResult = await tx.outboundAction.updateMany({
        where: {
          actionKey,
          status: { in: ["pending", "submitted", "failed"] },
          txHash: null
        },
        data: {
          status: "submitted",
          attempts: { increment: 1 },
          lastAttemptAt: new Date()
        }
      });

if (claimResult.count === 0) {
        // Another process claimed it or status changed
        const current = await tx.outboundAction.findUnique({ where: { actionKey } });
        if (!current) throw new Error(`Outbound action ${actionKey} not found`);
        if (current.status === "confirmed") {
          return { record: current as unknown as OutboundActionRecord, newlySubmitted: false, txHash: null };
        }
        if (current.status === "submitted" && current.txHash) {
          const chainResult = await this.checkChainFn(current.txHash);
          if (chainResult.confirmed) {
            await tx.outboundAction.update({
              where: { actionKey },
              data: { status: "confirmed", confirmedAt: new Date() }
            });
            return { record: { ...current, status: "confirmed", confirmedAt: new Date() } as OutboundActionRecord, newlySubmitted: false, txHash: null };
          }
        }
        return { record: current as unknown as OutboundActionRecord, newlySubmitted: false, txHash: null };
      }

      // Re-read the record to get updated attempts after claim
      const updatedRecord = await tx.outboundAction.findUnique({ where: { actionKey } });
      if (!updatedRecord) throw new Error(`Outbound action ${actionKey} not found after claim`);

      // Check max attempts with updated value
      if (updatedRecord.attempts >= (updatedRecord.maxAttempts ?? 3)) {
        throw new Error(`Max attempts (${updatedRecord.maxAttempts}) exceeded for action ${actionKey}`);
      }

      // We claimed it - now submit to chain
      const newAttempts = updatedRecord.attempts;
      let txHash: string;

      try {
        const result = await this.submitFn(updatedRecord.payload as Record<string, unknown>);
        txHash = result.txHash;
      } catch (err) {
        // Record failure using the same transaction client to avoid deadlock
        await tx.outboundAction.update({
          where: { actionKey },
          data: {
            status: "failed",
            attempts: newAttempts,
            lastAttemptAt: new Date(),
            errorCode: ERROR_CODES.SETTLEMENT_SUBMIT_FAILED,
            errorDetail: err instanceof Error ? err.message : String(err)
          }
        });
        // Don't throw - return failure result instead
        const failedRecord = await tx.outboundAction.findUnique({ where: { actionKey } });
        return { record: failedRecord! as unknown as OutboundActionRecord, newlySubmitted: false, txHash: null };
      }

      // Update with the actual txHash
      const updated = await tx.outboundAction.update({
        where: { actionKey },
        data: {
          txHash,
          errorCode: null,
          errorDetail: null
        }
      });

      return { record: updated as unknown as OutboundActionRecord, newlySubmitted: true, txHash };
    });

    // If we got a txHash from the transaction, we successfully submitted
    if (claimed.txHash) {
      return { record: claimed.record, newlySubmitted: claimed.newlySubmitted };
    }

    // Otherwise, return the result from the transaction
    return { record: claimed.record, newlySubmitted: claimed.newlySubmitted };
  } catch (err) {
    throw err;
  }
  }

  async reconcileOutboundAction(actionKey: string): Promise<OutboundActionRecord | null> {
    const record = await this.prisma.outboundAction.findUnique({ where: { actionKey } });
    if (!record) return null;

    if (record.status === "confirmed") {
      return record as unknown as OutboundActionRecord;
    }

    if (record.status === "submitted" && record.txHash) {
      const chainResult = await this.checkChainFn(record.txHash);

      if (chainResult.confirmed) {
        const updated = await this.prisma.outboundAction.update({
          where: { actionKey },
          data: {
            status: "confirmed",
            confirmedAt: new Date(),
            errorCode: null,
            errorDetail: null
          }
        });
        return updated as unknown as OutboundActionRecord;
      }

      if (chainResult.errorCode) {
        const updated = await this.prisma.outboundAction.update({
          where: { actionKey },
          data: {
            status: "failed",
            errorCode: chainResult.errorCode,
            errorDetail: chainResult.errorDetail
          }
        });
        return updated as unknown as OutboundActionRecord;
      }
    }

    return record as unknown as OutboundActionRecord;
  }

  async retryFailedAction(actionKey: string): Promise<SubmitResult> {
    const record = await this.prisma.outboundAction.findUnique({ where: { actionKey } });
    if (!record) throw new Error(`Outbound action ${actionKey} not found`);

    if (record.status !== "failed") {
      throw new Error(`Action ${actionKey} is not in failed state`);
    }

    // Reset to pending for retry
    await this.prisma.outboundAction.update({
      where: { actionKey },
      data: { status: "pending", errorCode: null, errorDetail: null }
    });

    // Submit and then reconcile
    const submitResult = await this.submitOutboundAction(actionKey);
    if (submitResult.record.status === "submitted" && submitResult.record.txHash) {
      // Try to reconcile immediately
      const reconciled = await this.reconcileOutboundAction(actionKey);
      if (reconciled) {
        return { record: reconciled, newlySubmitted: submitResult.newlySubmitted, txHash: submitResult.txHash };
      }
    }
    return submitResult;
  }

  async getOutboundAction(actionKey: string): Promise<OutboundActionRecord | null> {
    const record = await this.prisma.outboundAction.findUnique({ where: { actionKey } });
    return record ? (record as unknown as OutboundActionRecord) : null;
  }

  async listOutboundActions(opts: {
    status?: OutboundActionStatus;
    limit?: number;
    cursor?: string;
  }): Promise<{ items: OutboundActionRecord[]; nextCursor: string | null }> {
    const { status, limit = 50, cursor } = opts;
    const rows = await this.prisma.outboundAction.findMany({
      where: { ...(status && { status }) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(cursor && { cursor: { id: cursor }, skip: 1 })
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? items[items.length - 1]?.id ?? null : null;

    return { items: items as unknown as OutboundActionRecord[], nextCursor };
  }
}

export interface ReconciliationServiceOptions {
  prisma: PrismaClient;
  submitFn: (payload: Record<string, unknown>) => Promise<{ txHash: string }>;
  checkChainFn: (txHash: string) => Promise<{ confirmed: boolean; errorCode?: string; errorDetail?: string }>;
}

export function createReconciliationService(opts: ReconciliationServiceOptions): ReconciliationService {
  return new ReconciliationService(opts.prisma, opts.submitFn, opts.checkChainFn);
}

export type { PrismaClient };