#!/usr/bin/env tsx
/**
 * Operator-safe resumable backfill and recovery tool (#920, #728).
 *
 * Features:
 *   - Dry-run diff preview (shows exact creates, updates, and skips before applying)
 *   - Resumable checkpoints persisted in indexer_checkpoints
 *   - Gap calculation and consistency verification
 *   - Explicit skip reporting (e.g. RECORD_ALREADY_CONFIRMED)
 *   - Safe error isolation
 *
 * Usage:
 *   pnpm backfill                    # Resume from last checkpoint
 *   pnpm backfill --status           # Show current gap to chain tip
 *   pnpm backfill --verify           # Verify checkpoint consistency with action_ledger
 *   pnpm backfill --from 1000000     # Explicit start ledger
 *   pnpm backfill --to 1050000       # Explicit end ledger
 *   pnpm backfill --dry-run          # Preview diff without mutating database or checkpoint
 *   pnpm backfill --reset-checkpoint 995000 # Rewind/reset checkpoint
 *   pnpm backfill --limit 500        # Cap maximum records processed
 *   pnpm backfill --force            # Bypass safety warnings
 */

import { PrismaClient } from "@prisma/client";
import { logger } from "../logger.js";
import {
  BackfillService,
  type BackfillOptions,
  type RawBackfillEvent,
  type BackfillReport,
  type BackfillEventSource
} from "../services/backfillService.js";

export interface CliOptions extends BackfillOptions {
  status?: boolean;
  verify?: boolean;
  json?: boolean;
}

export function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--from" && i + 1 < args.length) {
      options.fromLedger = parseInt(args[++i], 10);
    } else if (arg === "--to" && i + 1 < args.length) {
      options.toLedger = parseInt(args[++i], 10);
    } else if (arg === "--status") {
      options.status = true;
    } else if (arg === "--verify") {
      options.verify = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--reset-checkpoint" && i + 1 < args.length) {
      options.resetCheckpoint = parseInt(args[++i], 10);
    } else if (arg === "--limit" && i + 1 < args.length) {
      options.limit = parseInt(args[++i], 10);
    } else if (arg === "--batch-size" && i + 1 < args.length) {
      options.batchSize = parseInt(args[++i], 10);
    } else if (arg === "--force") {
      options.force = true;
    } else if (arg === "--json") {
      options.json = true;
    }
  }

  return options;
}

export class DefaultBackfillEventSource implements BackfillEventSource {
  constructor(private readonly prisma: PrismaClient) {}

  async fetchEvents(fromLedger: number, toLedger: number, limit = 1000): Promise<RawBackfillEvent[]> {
    // Read from chain_events or pending_events if present
    const chainEvents = await this.prisma.chainEvent.findMany({
      where: {
        ledger: { gte: fromLedger, lte: toLedger },
      },
      take: limit,
      orderBy: { ledger: "asc" },
    });

    if (chainEvents.length > 0) {
      return chainEvents.map((e) => ({
        id: e.id,
        ledger: e.ledger,
        txHash: e.txHash,
        eventType: e.topicXdr[0] || "deposit",
        payload: { contractId: e.contractId, valueXdr: e.valueXdr },
        timestamp: e.ledgerClosedAt ?? undefined,
      }));
    }

    // Fallback: If no raw chainEvents in DB, return empty array
    return [];
  }

  async getLatestLedger(): Promise<number> {
    const maxChain = await this.prisma.chainEvent.aggregate({
      _max: { ledger: true },
    });
    if (maxChain._max.ledger) return maxChain._max.ledger;

    const maxAction = await this.prisma.actionLedger.aggregate({
      _max: { observedLedger: true },
    });
    return maxAction._max.observedLedger ?? 1000;
  }
}

export async function showStatus(prisma: PrismaClient, service?: BackfillService): Promise<void> {
  const svc = service ?? new BackfillService(prisma, new DefaultBackfillEventSource(prisma));
  const status = await svc.getStatus();

  console.log("================ Backfill Status ================");
  console.log(`Current Checkpoint Ledger: ${status.checkpointLedger}`);
  console.log(`Latest Known Ledger:      ${status.latestLedger}`);
  console.log(`Gap:                       ${status.gap} ledgers (~${status.estimatedHours} hours)`);
  if (status.lastSyncTime) {
    console.log(`Last Sync Time:            ${status.lastSyncTime.toISOString()}`);
  }
  if (status.lastError) {
    console.log(`Last Recorded Error:       ${status.lastError}`);
  }
  console.log("=================================================");
}

export async function verifyCheckpointConsistency(
  prisma: PrismaClient,
  service?: BackfillService
): Promise<boolean> {
  const svc = service ?? new BackfillService(prisma, new DefaultBackfillEventSource(prisma));
  const verification = await svc.verifyConsistency();

  console.log("========= Checkpoint Consistency Check =========");
  console.log(`Consistent:             ${verification.consistent ? "YES" : "NO"}`);
  console.log(`Checkpoint Ledger:      ${verification.checkpointLedger}`);
  console.log(`Max Action Ledger:      ${verification.maxActionLedger}`);
  console.log(`Divergence Gap:         ${verification.gap}`);
  if (verification.warning) {
    console.warn(`WARNING: ${verification.warning}`);
  }
  console.log("================================================");
  return verification.consistent;
}

export async function backfill(
  options: CliOptions,
  customService?: BackfillService,
  mockEvents?: RawBackfillEvent[]
): Promise<BackfillReport | void> {
  const prisma = new PrismaClient();
  const service = customService ?? new BackfillService(prisma, new DefaultBackfillEventSource(prisma));

  try {
    if (options.status) {
      await showStatus(prisma, service);
      return;
    }

    if (options.verify) {
      const isConsistent = await verifyCheckpointConsistency(prisma, service);
      if (!isConsistent && !options.force) {
        throw new Error("Checkpoint verification failed; use --force to override.");
      }
      return;
    }

    logger.info("Executing operator backfill", {
      from: options.fromLedger,
      to: options.toLedger,
      dryRun: options.dryRun ?? false,
      limit: options.limit,
    });

    const report = await service.runBackfill(mockEvents, options);

    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(BackfillService.formatDiffReport(report));
    }

    return report;
  } finally {
    await prisma.$disconnect();
  }
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  const options = parseArgs(process.argv.slice(2));

  backfill(options)
    .then(() => {
      logger.info("Backfill command finished successfully");
      process.exit(0);
    })
    .catch((error) => {
      logger.error("Backfill command failed", { error: error?.message ?? error });
      process.exit(1);
    });
}
