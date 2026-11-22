import type { PrismaClient } from "@prisma/client";
import { createLogger } from "../logger.js";

const logger = createLogger(process.env.LOG_LEVEL ?? "info");

/**
 * Operational health indicators for the VaultQuest system.
 * Covers unresolved failures, stale jobs, reconciliation drift, and user-impacting incidents.
 */

export type HealthSeverity = "healthy" | "warning" | "critical";

export type HealthCategory =
  | "Orphaned Actions"
  | "Stale Pending Events"
  | "Failed Background Jobs"
  | "Stale Action Leases"
  | "Unresolved Vault Settlements"
  | "Detected Reconciliation Drift"
  | "Pending Repair Proposals"
  | "Indexer Lag"
  | "Poison Events"
  | "Stale Orphans (>7 days)";

export interface HealthIndicator {
  category: string;
  status: "healthy" | "warning" | "critical";
  count: number;
  description: string;
  actionable: string; // What maintainers should do
  investigationLink?: string; // SQL query or log pointer for diagnosis
}

export interface OperationalHealthReport {
  timestamp: Date;
  overallStatus: "healthy" | "warning" | "critical";
  indicators: HealthIndicator[];
  summary: {
    totalIssues: number;
    criticalCount: number;
    warningCount: number;
  };
}

export interface HealthCategoryDetails {
  category: string;
  total: number;
  items: Array<Record<string, unknown>>;
  redacted: boolean;
}

/**
 * Service for aggregating operational health metrics and unresolved exceptions.
 */
export class OperationalHealthService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Generate a comprehensive operational health report.
   * Aggregates all health indicators from various tables and cron jobs.
   */
  async generateHealthReport(): Promise<OperationalHealthReport> {
    const indicators: HealthIndicator[] = [];

    // 1. Orphaned Actions (unresolved failures)
    const orphanedCount = await this.countOrphanedActions();
    if (orphanedCount > 0) {
      indicators.push({
        category: "Orphaned Actions",
        status: orphanedCount > 10 ? "critical" : "warning",
        count: orphanedCount,
        description: `${orphanedCount} actions stuck in orphaned state (submitted tx_hash but no confirmation)`,
        actionable: "Investigate drift detection and repair; may indicate stalled blockchain or indexer lag",
        investigationLink: `SELECT id, tx_hash, error_code, updated_at FROM action_ledger WHERE status = 'orphaned' ORDER BY updated_at DESC LIMIT 20`,
      });
    }

    const abandonedPendingCount = await this.countAbandonedPendingActions();
    if (abandonedPendingCount > 0) {
      indicators.push({
        category: "Abandoned Pending Actions",
        status: abandonedPendingCount > 10 ? "critical" : "warning",
        count: abandonedPendingCount,
        description: `${abandonedPendingCount} wallet actions have remained pending for more than 15 minutes`,
        actionable: "Inspect recovery checkpoints; resume only actions that have not started an external wallet operation, and verify wallet activity for all others",
        investigationLink: `SELECT id, wallet_address, action_type, recovery_checkpoint, created_at, updated_at FROM action_ledger WHERE status = 'pending' AND updated_at < NOW() - INTERVAL '15 minutes' ORDER BY updated_at ASC LIMIT 20`,
      });
    }

    // 2. Stale Pending Events (indexer backlog)
    const stalePendingCount = await this.countStalePendingEvents();
    if (stalePendingCount > 0) {
      indicators.push({
        category: "Stale Pending Events",
        status: stalePendingCount > 50 ? "critical" : "warning",
        count: stalePendingCount,
        description: `${stalePendingCount} contract events received but not yet consumed (indexer backlog)`,
        actionable: "Check indexer daemon health; may indicate slow event processing or RPC issues",
        investigationLink: `SELECT tx_hash, soroban_event_id, received_at FROM pending_events WHERE consumed_at IS NULL ORDER BY received_at ASC LIMIT 20`,
      });
    }

    // 3. Failed Background Jobs (worker errors)
    const failedJobsCount = await this.countFailedBackgroundJobs();
    if (failedJobsCount > 0) {
      indicators.push({
        category: "Failed Background Jobs",
        status: failedJobsCount > 5 ? "critical" : "warning",
        count: failedJobsCount,
        description: `${failedJobsCount} background jobs in failed state (draw proofs, notifications, etc.)`,
        actionable: "Review job worker logs; re-enqueue or manually fix dead-lettered jobs",
        investigationLink: `SELECT id, type, status, attempts, last_error FROM background_jobs WHERE status = 'failed' ORDER BY updated_at DESC LIMIT 20`,
      });
    }

    // 4. Stale Action Leases (worker hangs)
    const staleLeaseCount = await this.countStaleActionLeases();
    if (staleLeaseCount > 0) {
      indicators.push({
        category: "Stale Action Leases",
        status: staleLeaseCount > 3 ? "critical" : "warning",
        count: staleLeaseCount,
        description: `${staleLeaseCount} actions with expired worker leases (worker may have crashed)`,
        actionable: "Restart worker pods or check worker process status; leases auto-expire after 5 minutes",
        investigationLink: `SELECT action_id, worker_id, expires_at FROM action_leases WHERE expires_at < NOW() ORDER BY expires_at ASC LIMIT 20`,
      });
    }

    // 5. Unresolved Vault Settlements (user payouts pending)
    const unresolvedSettlementCount = await this.countUnresolvedSettlements();
    if (unresolvedSettlementCount > 0) {
      indicators.push({
        category: "Unresolved Vault Settlements",
        status: unresolvedSettlementCount > 20 ? "critical" : "warning",
        count: unresolvedSettlementCount,
        description: `${unresolvedSettlementCount} user payouts stuck in "Resolving" state (prize draw settlements)`,
        actionable: "Check settlement job worker; user may be unable to claim prize funds",
        investigationLink: `SELECT id, vault_id, state, amount, updated_at FROM vault_settlements WHERE state = 'Resolving' AND updated_at < NOW() - INTERVAL '1 hour' ORDER BY updated_at ASC LIMIT 20`,
      });
    }

    // 6. Detected Reconciliation Drift (unresolved anomalies)
    const driftCount = await this.countDetectedDrift();
    if (driftCount > 0) {
      indicators.push({
        category: "Detected Reconciliation Drift",
        status: driftCount > 5 ? "critical" : "warning",
        count: driftCount,
        description: `${driftCount} reconciliation anomalies detected (action_ledger vs on-chain mismatch)`,
        actionable: "Run reconciliation sweep to detect and repair; may indicate on-chain state divergence",
        investigationLink: `SELECT id, record_type, record_id, drift_type, detected_at FROM repair_quarantine WHERE resolved_at IS NULL ORDER BY detected_at ASC LIMIT 20`,
      });
    }

    // 7. Pending Repair Proposals (dual-control safety)
    const pendingRepairCount = await this.countPendingRepairs();
    if (pendingRepairCount > 0) {
      indicators.push({
        category: "Pending Repair Proposals",
        status: "warning",
        count: pendingRepairCount,
        description: `${pendingRepairCount} reconciliation repair proposals awaiting approval`,
        actionable: "Review repair proposals in dual-control system and approve/reject; may be time-critical for user funds",
        investigationLink: `SELECT id, proposer_id, step_count, status, created_at FROM repair_proposals WHERE status = 'pending' ORDER BY created_at ASC LIMIT 20`,
      });
    }

    // 8. Indexer Lag (block confirmation delay)
    const indexerLag = await this.measureIndexerLag();
    if (indexerLag && indexerLag > 5) {
      // More than 5 ledgers behind
      indicators.push({
        category: "Indexer Lag",
        status: indexerLag > 20 ? "critical" : "warning",
        count: indexerLag,
        description: `Indexer is ${indexerLag} ledgers behind current network (event ingestion delay)`,
        actionable: "Check Soroban RPC connectivity and indexer daemon logs; users may see stale balances",
        investigationLink: `SELECT latest_ledger, last_processed_event_id, last_sync_time FROM indexer_checkpoints ORDER BY last_sync_time DESC LIMIT 1`,
      });
    }

    // 9. Poison Events (malformed contract events)
    const poisonEventCount = await this.countPoisonEvents();
    if (poisonEventCount > 0) {
      indicators.push({
        category: "Poison Events",
        status: poisonEventCount > 10 ? "critical" : "warning",
        count: poisonEventCount,
        description: `${poisonEventCount} unparseable contract events quarantined (potential contract bug or RPC data corruption)`,
        actionable: "Review event payloads and contract state; may indicate contract deployment issue",
        investigationLink: `SELECT id, soroban_event_id, reason, detected_at FROM poison_events WHERE resolved_at IS NULL ORDER BY detected_at DESC LIMIT 10`,
      });
    }

    // 10. Stale Orphans (old failed actions never resolved)
    const staleOrphanCount = await this.countStaleOrphans();
    if (staleOrphanCount > 0) {
      indicators.push({
        category: "Stale Orphans (>7 days)",
        status: staleOrphanCount > 5 ? "critical" : "warning",
        count: staleOrphanCount,
        description: `${staleOrphanCount} orphaned actions unresolved for >7 days (likely permanent failures)`,
        actionable: "Mark as permanently failed; user may need manual intervention or refund",
        investigationLink: `SELECT id, tx_hash, error_code, updated_at FROM action_ledger WHERE status = 'orphaned' AND updated_at < NOW() - INTERVAL '7 days' ORDER BY updated_at ASC LIMIT 20`,
      });
    }

    // Calculate overall status
    const criticalCount = indicators.filter((i) => i.status === "critical").length;
    const warningCount = indicators.filter((i) => i.status === "warning").length;

    const overallStatus: "healthy" | "warning" | "critical" =
      criticalCount > 0 ? "critical" : warningCount > 0 ? "warning" : "healthy";

    return {
      timestamp: new Date(),
      overallStatus,
      indicators,
      summary: {
        totalIssues: indicators.length,
        criticalCount,
        warningCount,
      },
    };
  }

  // ─── Health Indicator Calculations ───────────────────────────────────────────

  private async countOrphanedActions(): Promise<number> {
    const result = await this.prisma.actionLedger.count({
      where: { status: "orphaned" },
    });
    return result;
  }

  private async countAbandonedPendingActions(): Promise<number> {
    return this.prisma.actionLedger.count({
      where: {
        status: "pending",
        updatedAt: { lt: new Date(Date.now() - 15 * 60 * 1000) }
      }
    });
  }

  private async countStalePendingEvents(): Promise<number> {
    const result = await this.prisma.pendingEvent.count({
      where: {
        consumedAt: null,
        receivedAt: { lt: new Date(Date.now() - 5 * 60 * 1000) }, // > 5 minutes old
      },
    });
    return result;
  }

  private async countFailedBackgroundJobs(): Promise<number> {
    const result = await this.prisma.backgroundJob.count({
      where: { status: "failed" },
    });
    return result;
  }

  private async countStaleActionLeases(): Promise<number> {
    const result = await this.prisma.actionLease.count({
      where: { expiresAt: { lt: new Date() } },
    });
    return result;
  }

  private async countUnresolvedSettlements(): Promise<number> {
    const result = await this.prisma.vaultSettlement.count({
      where: {
        state: "Resolving",
        updatedAt: { lt: new Date(Date.now() - 60 * 60 * 1000) }, // > 1 hour
      },
    });
    return result;
  }

  private async countDetectedDrift(): Promise<number> {
    const result = await this.prisma.repairQuarantine.count({
      where: { resolvedAt: null },
    });
    return result;
  }

  private async countPendingRepairs(): Promise<number> {
    const result = await this.prisma.repairProposal.count({
      where: { status: "pending" },
    });
    return result;
  }

  private async measureIndexerLag(): Promise<number | null> {
    const checkpoint = await this.prisma.indexerCheckpoint.findFirst({
      orderBy: { lastSyncTime: "desc" },
    });

    if (!checkpoint) return null;

    // Query current network ledger (simplified; in production, call Soroban RPC)
    // For now, estimate lag from last checkpoint
    const lagEstimate = Math.max(0, checkpoint.latestLedger - (checkpoint.latestLedger - 5)); // Placeholder
    return lagEstimate;
  }

  private async countPoisonEvents(): Promise<number> {
    const result = await this.prisma.poisonEvent.count({
      where: { resolvedAt: null },
    });
    return result;
  }

  private async countStaleOrphans(): Promise<number> {
    const result = await this.prisma.actionLedger.count({
      where: {
        status: "orphaned",
        updatedAt: { lt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }, // > 7 days
      },
    });
    return result;
  }

  /**
   * Get detailed health summary for a specific category (for drill-down views).
   */
  async getHealthCategoryDetails(
    category: string
  ): Promise<{ items: Array<Record<string, unknown>>; total: number }> {
    let items: Array<Record<string, unknown>> = [];
    let total = 0;

    switch (category) {
      case "Orphaned Actions":
        items = await this.prisma.actionLedger.findMany({
          where: { status: "orphaned" },
          select: {
            id: true,
            walletAddress: true,
            actionType: true,
            txHash: true,
            errorCode: true,
            updatedAt: true,
          },
          orderBy: { updatedAt: "desc" },
          take: 50,
        });
        total = await this.prisma.actionLedger.count({
          where: { status: "orphaned" },
        });
        break;

      case "Abandoned Pending Actions":
        items = await this.prisma.actionLedger.findMany({
          where: {
            status: "pending",
            updatedAt: { lt: new Date(Date.now() - 15 * 60 * 1000) },
          },
          select: {
            id: true,
            walletAddress: true,
            actionType: true,
            recoveryCheckpoint: true,
            createdAt: true,
            updatedAt: true,
          },
          orderBy: { updatedAt: "asc" },
          take: 50,
        });
        total = await this.countAbandonedPendingActions();
        break;

      case "Stale Pending Events":
        items = await this.prisma.pendingEvent.findMany({
          where: { consumedAt: null, receivedAt: { lt: new Date(Date.now() - 5 * 60 * 1000) } },
          select: { txHash: true, sorobanEventId: true, statusHint: true, receivedAt: true },
          orderBy: { receivedAt: "asc" },
          take: 50,
        });
        total = await this.prisma.pendingEvent.count({
          where: { consumedAt: null },
        });
        break;

      case "Failed Background Jobs":
        items = await this.prisma.backgroundJob.findMany({
          where: { status: "failed" },
          select: { id: true, type: true, attempts: true, updatedAt: true },
          orderBy: { updatedAt: "desc" },
          take: 50,
        });
        total = await this.prisma.backgroundJob.count({
          where: { status: "failed" },
        });
        break;

      case "Unresolved Vault Settlements":
        items = await this.prisma.vaultSettlement.findMany({
          where: { state: "Resolving" },
          select: {
            id: true,
            vaultId: true,
            recipient: true,
            amount: true,
            updatedAt: true,
          },
          orderBy: { updatedAt: "asc" },
          take: 50,
        });
        total = await this.prisma.vaultSettlement.count({
          where: { state: "Resolving" },
        });
        break;

      case "Pending Repair Proposals":
        items = await this.prisma.repairProposal.findMany({
          where: { status: "pending" },
          select: {
            id: true,
            proposerId: true,
            stepCount: true,
            valueTotal: true,
            createdAt: true,
          },
          orderBy: { createdAt: "asc" },
          take: 50,
        });
        total = await this.prisma.repairProposal.count({
          where: { status: "pending" },
        });
        break;

      case "Poison Events":
        items = await this.prisma.poisonEvent.findMany({
          where: { resolvedAt: null },
          select: {
            id: true,
            sorobanEventId: true,
            contractId: true,
            reason: true,
            detectedAt: true,
          },
          orderBy: { detectedAt: "desc" },
          take: 50,
        });
        total = await this.prisma.poisonEvent.count({
          where: { resolvedAt: null },
        });
        break;
    }

    return { items, total };
  }
}
