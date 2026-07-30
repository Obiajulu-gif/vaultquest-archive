/**
 * Background batch jobs for ledger hygiene.
 *
 * `sweepOrphans` runs on a cron schedule (see `src/cron.ts`) and:
 *   1. Marks `submitted` actions whose `updatedAt` is older than `ttlMinutes`
 *      as `orphaned` (they have been broadcasting too long with no confirmation).
 *   2. Prunes unconsumed `pending_events` older than 1 hour (events that
 *      arrived from the indexer but whose matching intent was never attached).
 *
 * `recoverStuckActions` uses the LedgerService lease-based recovery to handle
 * actions whose worker leases have expired.
 *
 * `ReconciliationEngine` detects and repairs drift between ActionLedger,
 * VaultSettlement, PendingEvent, and on-chain evidence. Supports dry-run
 * mode and appends a complete audit trail for every repair.
 */

import type { PrismaClient } from "@prisma/client";
import { ERROR_CODES } from "../constants.js";
import type { LedgerService } from "./ledger.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SweepResult {
  /** Number of submitted actions promoted to orphaned. */
  orphaned: number;
  /** Number of stale pending_events rows deleted. */
  prunedEvents: number;
}

export interface RecoveryResult {
  /** Number of actions recovered from expired leases. */
  recovered: number;
  /** Number of stale pending_events rows deleted. */
  prunedEvents: number;
}

export type DriftType =
  | "missing_action"
  | "missing_event"
  | "duplicate_tx_hash"
  | "stale_orphan"
  | "contradiction"
  | "orphaned_settlement"
  | "missing_settlement"
  | "stale_pending_event"
  | "insolvency_drift";

export interface DriftRecord {
  type: DriftType;
  recordType: "action_ledger" | "vault_settlement" | "pending_event";
  recordId: string;
  details: Record<string, unknown>;
}

export interface RepairStep {
  table: string;
  recordId: string;
  action: "update" | "delete" | "insert" | "quarantine";
  data: Record<string, unknown>;
  provenance: string;
}

export interface RepairPlan {
  drifts: DriftRecord[];
  steps: RepairStep[];
  dryRun: boolean;
}

export interface ReconciliationResult {
  driftsFound: number;
  stepsProposed: number;
  stepsApplied: number;
  quarantined: number;
  plan: RepairPlan;
}

// ─── Drift detection ──────────────────────────────────────────────────────────

/**
 * Scans ActionLedger, VaultSettlement, and PendingEvent for drift.
 * Returns a list of detected drifts.
 */
export async function detectDrift(prisma: PrismaClient): Promise<DriftRecord[]> {
  const drifts: DriftRecord[] = [];

  // 1. Missing event: submitted actions with tx_hash but no matching pending_event
  //    and not yet confirmed/reverted by reconcileEvent.
  const submittedWithTx = await prisma.actionLedger.findMany({
    where: {
      status: "submitted",
      txHash: { not: null },
      sorobanEventId: null
    },
    select: { id: true, txHash: true, status: true, updatedAt: true }
  });
  for (const action of submittedWithTx) {
    const event = await prisma.pendingEvent.findUnique({
      where: { txHash: action.txHash! }
    });
    if (!event) {
      drifts.push({
        type: "missing_event",
        recordType: "action_ledger",
        recordId: action.id,
        details: {
          txHash: action.txHash,
          status: action.status,
          updatedAt: action.updatedAt,
          message: "Action is submitted with tx_hash but no pending_event or chain evidence exists"
        }
      });
    }
  }

  // 2. Missing action: pending_events that have no matching action_ledger row
  //    and are not stale (consumedAt is null, receivedAt is recent).
  const orphanedEvents = await prisma.pendingEvent.findMany({
    where: {
      consumedAt: null
    },
    select: { txHash: true, sorobanEventId: true, statusHint: true, receivedAt: true }
  });
  for (const event of orphanedEvents) {
    const action = await prisma.actionLedger.findFirst({
      where: { txHash: event.txHash }
    });
    if (!action) {
      drifts.push({
        type: "missing_action",
        recordType: "pending_event",
        recordId: event.txHash,
        details: {
          txHash: event.txHash,
          sorobanEventId: event.sorobanEventId,
          statusHint: event.statusHint,
          receivedAt: event.receivedAt,
          message: "Pending event has no matching action_ledger row"
        }
      });
    }
  }

  // 3. Duplicate tx_hash: two actions claiming the same tx_hash.
  //    (Unique index on tx_hash prevents this, but check for null txHash cases.)
  const allWithTx = await prisma.actionLedger.findMany({
    where: { txHash: { not: null } },
    select: { id: true, txHash: true, status: true }
  });
  const hashMap = new Map<string, typeof allWithTx>();
  for (const a of allWithTx) {
    const h = a.txHash!;
    if (!hashMap.has(h)) hashMap.set(h, []);
    hashMap.get(h)!.push(a);
  }
  for (const [hash, actions] of hashMap) {
    if (actions.length > 1) {
      for (const a of actions) {
        drifts.push({
          type: "duplicate_tx_hash",
          recordType: "action_ledger",
          recordId: a.id,
          details: {
            txHash: hash,
            status: a.status,
            message: `tx_hash ${hash} is claimed by ${actions.length} actions`
          }
        });
      }
    }
  }

  // 4. Stale orphan: actions in `orphaned` status that have been orphaned
  //    for too long (> 7 days) with no resolution.
  const staleOrphans = await prisma.actionLedger.findMany({
    where: {
      status: "orphaned",
      updatedAt: { lt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
    },
    select: { id: true, txHash: true, errorCode: true, updatedAt: true }
  });
  for (const o of staleOrphans) {
    drifts.push({
      type: "stale_orphan",
      recordType: "action_ledger",
      recordId: o.id,
      details: {
        txHash: o.txHash,
        errorCode: o.errorCode,
        updatedAt: o.updatedAt,
        message: "Action has been orphaned for > 7 days without resolution"
      }
    });
  }

  // 5. Contradiction: action confirmed but pending_event says reverted, or vice versa.
  const confirmedActions = await prisma.actionLedger.findMany({
    where: {
      status: { in: ["confirmed", "reverted"] },
      sorobanEventId: { not: null }
    },
    select: { id: true, txHash: true, status: true, sorobanEventId: true }
  });
  for (const a of confirmedActions) {
    if (!a.txHash) continue;
    const event = await prisma.pendingEvent.findUnique({
      where: { txHash: a.txHash }
    });
    if (event && event.statusHint !== a.status) {
      drifts.push({
        type: "contradiction",
        recordType: "action_ledger",
        recordId: a.id,
        details: {
          txHash: a.txHash,
          actionStatus: a.status,
          eventStatusHint: event.statusHint,
          sorobanEventId: a.sorobanEventId,
          message: `Action status ${a.status} contradicts pending_event statusHint ${event.statusHint}`
        }
      });
    }
  }

  // 6. Orphaned settlement: VaultSettlement in "Resolving" for > 1 hour.
  const stuckSettlements = await prisma.vaultSettlement.findMany({
    where: {
      state: "Resolving",
      updatedAt: { lt: new Date(Date.now() - 60 * 60 * 1000) }
    },
    select: { id: true, vaultId: true, state: true, updatedAt: true, attempts: true }
  });
  for (const s of stuckSettlements) {
    drifts.push({
      type: "orphaned_settlement",
      recordType: "vault_settlement",
      recordId: s.id,
      details: {
        vaultId: s.vaultId,
        state: s.state,
        attempts: s.attempts,
        updatedAt: s.updatedAt,
        message: "Settlement stuck in Resolving for > 1 hour"
      }
    });
  }

  // 7. Missing settlement: confirmed deposit/withdraw actions with no matching VaultSettlement.
  const confirmedDeposits = await prisma.actionLedger.findMany({
    where: {
      status: "confirmed",
      actionType: { in: ["deposit", "withdraw"] }
    },
    select: { id: true, actionPayload: true, txHash: true }
  });
  for (const a of confirmedDeposits) {
    const payload = a.actionPayload as Record<string, unknown> | null;
    const vaultId = payload?.vault_id ?? payload?.pool_id;
    if (vaultId) {
      const settlement = await prisma.vaultSettlement.findUnique({
        where: { vaultId: String(vaultId) }
      });
      if (!settlement) {
        drifts.push({
          type: "missing_settlement",
          recordType: "action_ledger",
          recordId: a.id,
          details: {
            txHash: a.txHash,
            vaultId: String(vaultId),
            message: `Confirmed action references vault ${vaultId} but no VaultSettlement exists`
          }
        });
      }
    }
  }

  // 8. Stale pending events: unconsumed events older than 24h.
  const veryStaleEvents = await prisma.pendingEvent.findMany({
    where: {
      consumedAt: null,
      receivedAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) }
    },
    select: { txHash: true, receivedAt: true, statusHint: true }
  });
  for (const e of veryStaleEvents) {
    drifts.push({
      type: "stale_pending_event",
      recordType: "pending_event",
      recordId: e.txHash,
      details: {
        txHash: e.txHash,
        receivedAt: e.receivedAt,
        statusHint: e.statusHint,
        message: "Pending event unconsumed for > 24 hours"
      }
    });
  }

  return drifts;
}

// ─── Repair plan generation ───────────────────────────────────────────────────

/**
 * Converts a list of drifts into a repair plan. Each drift produces one or more
 * repair steps. Drifts that cannot be safely repaired are quarantined.
 */
export function buildRepairPlan(drifts: DriftRecord[], dryRun: boolean): RepairPlan {
  const steps: RepairStep[] = [];
  const quarantined: DriftRecord[] = [];

  for (const drift of drifts) {
    switch (drift.type) {
      case "missing_event": {
        // Action is submitted with tx_hash but no event arrived.
        // If it's been > 5 minutes, orphan it.
        const updatedAt = new Date(drift.details.updatedAt as string);
        const age = Date.now() - updatedAt.getTime();
        if (age > 5 * 60 * 1000) {
          steps.push({
            table: "action_ledger",
            recordId: drift.recordId,
            action: "update",
            data: {
              status: "orphaned",
              errorCode: ERROR_CODES.ORPHAN_TTL_EXPIRED,
              errorDetail: "reconciler: no matching event arrived within timeout"
            },
            provenance: `drift:missing_event:${drift.recordId}`
          });
        }
        break;
      }

      case "missing_action": {
        // Pending event with no matching action. If it's recent (< 1h), keep it.
        // If it's old (> 1h), delete it.
        const receivedAt = new Date(drift.details.receivedAt as string);
        if (Date.now() - receivedAt.getTime() > 60 * 60 * 1000) {
          steps.push({
            table: "pending_event",
            recordId: drift.recordId,
            action: "delete",
            data: {},
            provenance: `drift:missing_action:${drift.recordId}`
          });
        }
        break;
      }

      case "duplicate_tx_hash": {
        // Unique index prevents this in practice, but if found, quarantine.
        quarantined.push(drift);
        break;
      }

      case "stale_orphan": {
        // Already orphaned. No further action needed — operator can review.
        // Just log it.
        break;
      }

      case "contradiction": {
        // Action status contradicts event statusHint. Quarantine for manual review.
        quarantined.push(drift);
        break;
      }

      case "orphaned_settlement": {
        // Settlement stuck in Resolving. Roll back to Unresolved so it can be retried.
        steps.push({
          table: "vault_settlement",
          recordId: drift.recordId,
          action: "update",
          data: {
            state: "Unresolved",
            errorCode: ERROR_CODES.SETTLEMENT_RETRIES_EXHAUSTED,
            errorDetail: "reconciler: settlement was stuck in Resolving state"
          },
          provenance: `drift:orphaned_settlement:${drift.recordId}`
        });
        break;
      }

      case "missing_settlement": {
        // Confirmed action references a vault with no settlement.
        // This is informational — no automatic repair.
        break;
      }

      case "stale_pending_event": {
        // Unconsumed pending event older than 24h. Delete it.
        steps.push({
          table: "pending_event",
          recordId: drift.recordId,
          action: "delete",
          data: {},
          provenance: `drift:stale_pending_event:${drift.recordId}`
        });
        break;
      }

      default:
        quarantined.push(drift);
    }
  }

  return { drifts, steps, dryRun };
}

// ─── Apply repair plan ────────────────────────────────────────────────────────

/**
 * Applies a repair plan to the database. Idempotent: reapplying the same plan
 * is a no-op (checks existing audit trail). Appends a complete audit record.
 */
export async function applyRepairPlan(
  prisma: PrismaClient,
  plan: RepairPlan
): Promise<{ applied: number; quarantined: number }> {
  if (plan.dryRun) {
    return { applied: 0, quarantined: 0 };
  }

  let applied = 0;
  const appliedSteps: RepairStep[] = [];

  for (const step of plan.steps) {
    // Check if this step was already applied (idempotency).
    const existingAudit = await prisma.repairAudit.findFirst({
      where: {
        planJson: { path: ["provenance"], equals: step.provenance }
      }
    });
    if (existingAudit) continue;

    try {
      switch (step.table) {
        case "action_ledger": {
          if (step.action === "update") {
            await prisma.actionLedger.update({
              where: { id: step.recordId },
              data: step.data as any
            });
            applied++;
            appliedSteps.push(step);
          }
          break;
        }
        case "vault_settlement": {
          if (step.action === "update") {
            await prisma.vaultSettlement.update({
              where: { id: step.recordId },
              data: step.data as any
            });
            applied++;
            appliedSteps.push(step);
          }
          break;
        }
        case "pending_event": {
          if (step.action === "delete") {
            await prisma.pendingEvent.delete({
              where: { txHash: step.recordId }
            });
            applied++;
            appliedSteps.push(step);
          }
          break;
        }
      }
    } catch (err) {
      // If record was already deleted or updated, skip.
      continue;
    }
  }

  // Quarantine contradictions and unresolvable drifts.
  let quarantined = 0;
  for (const drift of plan.drifts) {
    if (drift.type === "contradiction" || drift.type === "duplicate_tx_hash") {
      const existing = await prisma.repairQuarantine.findFirst({
        where: {
          recordType: drift.recordType,
          recordId: drift.recordId,
          driftType: drift.type,
          resolvedAt: null
        }
      });
      if (!existing) {
        await prisma.repairQuarantine.create({
          data: {
            recordType: drift.recordType,
            recordId: drift.recordId,
            driftType: drift.type,
            details: drift.details as any
          }
        });
        quarantined++;
      }
    }
  }

  // Append audit trail.
  if (appliedSteps.length > 0) {
    await prisma.repairAudit.create({
      data: {
        planJson: plan as any,
        appliedJson: appliedSteps as any
      }
    });
  }

  return { applied, quarantined };
}

// ─── Full reconciliation pipeline ─────────────────────────────────────────────

/**
 * Runs the full reconciliation pipeline: detect drift → build plan → apply.
 *
 * @param prisma - PrismaClient
 * @param opts.dryRun - If true, only detects and plans without applying
 * @returns Full reconciliation result
 */
export async function reconcileAll(
  prisma: PrismaClient,
  opts: { dryRun?: boolean } = {}
): Promise<ReconciliationResult> {
  const dryRun = opts.dryRun ?? false;

  const drifts = await detectDrift(prisma);
  const plan = buildRepairPlan(drifts, dryRun);

  let stepsApplied = 0;
  let quarantined = 0;
  if (!dryRun) {
    const result = await applyRepairPlan(prisma, plan);
    stepsApplied = result.applied;
    quarantined = result.quarantined;
  }

  return {
    driftsFound: drifts.length,
    stepsProposed: plan.steps.length,
    stepsApplied,
    quarantined,
    plan
  };
}

// ─── Existing functions (unchanged) ───────────────────────────────────────────

export async function sweepOrphans(
  prisma: PrismaClient,
  opts: { ttlMinutes: number }
): Promise<SweepResult> {
  const cutoff = new Date(Date.now() - opts.ttlMinutes * 60 * 1000);
  const eventCutoff = new Date(Date.now() - 60 * 60 * 1000);

  const staleActions = await prisma.actionLedger.findMany({
    where: {
      status: "submitted",
      updatedAt: { lt: cutoff }
    },
    select: { id: true }
  });

  let orphaned = 0;
  if (staleActions.length > 0) {
    const result = await prisma.actionLedger.updateMany({
      where: {
        id: { in: staleActions.map((a) => a.id) },
        status: "submitted"
      },
      data: {
        status: "orphaned",
        errorCode: ERROR_CODES.ORPHAN_TTL_EXPIRED
      }
    });
    orphaned = result.count;
  }

  const pruned = await prisma.pendingEvent.deleteMany({
    where: {
      consumedAt: null,
      receivedAt: { lt: eventCutoff }
    }
  });

  return { orphaned, prunedEvents: pruned.count };
}

export async function recoverStuckActions(
  svc: LedgerService,
  prisma: PrismaClient,
  opts: { ttlMs?: number; dryRun?: boolean } = {}
): Promise<RecoveryResult> {
  const ttlMs = opts.ttlMs ?? 5 * 60 * 1000;
  const dryRun = opts.dryRun ?? false;

  const result = await svc.recoverSubmittedLeases("recovery-worker", { ttlMs, dryRun });

  const eventCutoff = new Date(Date.now() - 60 * 60 * 1000);
  const pruned = await prisma.pendingEvent.deleteMany({
    where: {
      consumedAt: null,
      receivedAt: { lt: eventCutoff }
    }
  });

  return { recovered: result.recovered, prunedEvents: pruned.count };
}