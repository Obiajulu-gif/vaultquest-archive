/**
 * Standalone ledger-range backfill script (issue #435).
 *
 * Reprocesses a bounded range of Stellar ledgers for missing events.
 * Reuses the idempotent LedgerService.reconcileEvent.
 *
 * Usage:
 *   tsx src/scripts/backfill.ts --start 1000 --end 2000 [--dry-run]
 *
 * Exit codes:
 *   0 - backfill succeeded
 *   1 - backfill failed
 */

import { getEnv } from "../env.js";
import { createLogger } from "../logger.js";
import { PrismaClient } from "@prisma/client";
import { LedgerService } from "../services/ledger.js";
import { SorobanRpcEventSource, sorobanNativeXdrDecoder } from "../services/stellarIndexer.js";

const env = getEnv();
const logger = createLogger(env.LOG_LEVEL);

function parseArgs() {
  const args = process.argv.slice(2);
  let startLedger: number | undefined;
  let endLedger: number | undefined;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--start") {
      startLedger = parseInt(args[++i], 10);
    } else if (arg === "--end") {
      endLedger = parseInt(args[++i], 10);
    } else if (arg === "--dry-run") {
      dryRun = true;
    }
  }

  if (startLedger === undefined || endLedger === undefined || isNaN(startLedger) || isNaN(endLedger)) {
    console.error("Usage: tsx src/scripts/backfill.ts --start <ledger> --end <ledger> [--dry-run]");
    process.exit(1);
  }

  if (endLedger < startLedger) {
    console.error("Error: --end ledger must be >= --start ledger");
    process.exit(1);
  }

  return { startLedger, endLedger, dryRun };
}

async function run() {
  const { startLedger, endLedger, dryRun } = parseArgs();

  if (!env.SOROBAN_RPC_URL) {
    console.error("Error: SOROBAN_RPC_URL must be set to run the backfill");
    process.exit(1);
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: env.DATABASE_URL } }
  });

  const ledgerService = new LedgerService(prisma);
  const contractIds = env.INDEXER_CONTRACT_IDS?.split(",").map((s) => s.trim()).filter(Boolean);
  const source = new SorobanRpcEventSource({
    rpcUrl: env.SOROBAN_RPC_URL.split(",").map((s) => s.trim()),
    contractIds,
    maxPageFetch: 10000
  });

  logger.info({ startLedger, endLedger, dryRun }, "Starting ledger range backfill");
  console.log(`Starting backfill from ledger ${startLedger} to ${endLedger}${dryRun ? ' (DRY RUN)' : ''}...`);

  let processed = 0;
  let skipped = 0;
  let failed = 0;

  try {
    // In a real implementation we would paginate through the ledgers.
    // For now we assume a single fetchEvents call covers the range.
    const rawEvents = await source.fetchEvents({ startLedger, endLedger, limit: 10000 });

    for (const raw of rawEvents) {
      let payload: Record<string, unknown>;
      try {
        payload = sorobanNativeXdrDecoder.decode(raw);
      } catch (err) {
        logger.warn({ err, txHash: raw.txHash, eventId: raw.id }, "backfill: quarantining malformed event");
        if (!dryRun) {
          await ledgerService.quarantineEvent({
            sorobanEventId: raw.id,
            ledger: raw.ledger,
            contractId: raw.contractId,
            txHash: raw.txHash,
            rawEvent: raw,
            reason: err instanceof Error ? err.message : String(err)
          });
        }
        failed += 1;
        continue;
      }
      const statusHint = raw.successful ? "confirmed" : "reverted";

      if (dryRun) {
        // In dry-run, we perform no mutations, but we can check if it exists
        // to categorize it as skipped vs processed.
        const existingAction = await prisma.actionLedger.findFirst({ where: { txHash: raw.txHash } });
        const existingPending = await prisma.pendingEvent.findFirst({ where: { txHash: raw.txHash } });
        
        if (existingAction || existingPending) {
          skipped += 1;
        } else {
          processed += 1;
        }
      } else {
        try {
          await ledgerService.reconcileEvent({
            txHash: raw.txHash,
            sorobanEventId: raw.id,
            eventPayload: payload,
            statusHint
          });
          processed += 1;
        } catch (err: unknown) {
          const isDuplicate =
            err instanceof Error &&
            (err.message.includes("Unique constraint") ||
              err.message.includes("P2002") ||
              (err as any).code === "P2002");

          if (isDuplicate) {
            skipped += 1;
          } else {
            logger.warn({ err, txHash: raw.txHash }, "backfill: failed to process event");
            failed += 1;
          }
        }
      }
    }

    console.log("Backfill completed.");
    console.log(`Processed: ${processed}`);
    console.log(`Skipped (duplicates): ${skipped}`);
    console.log(`Failed: ${failed}`);
    logger.info({ processed, skipped, failed }, "Backfill completed");

  } catch (err) {
    logger.error({ err }, "Backfill encountered a fatal error");
    console.error("Backfill encountered a fatal error:", err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

run();
