/**
 * Chain-state disaster recovery (#754): rehearsal drill and real rebuild.
 *
 *   --mode drill (default): proves recovery works, against live.
 *     1. restore the latest pg_dump from BACKUP_DIR into an EMPTY database
 *     2. prisma migrate deploy
 *     3. rebuild chain-derived state from chain history (below)
 *     4. diff chain-derived state against live inside one read snapshot
 *
 *   --mode rebuild: the recovery itself, after an operator restored the
 *     latest backup into --target-url (docs/DISASTER_RECOVERY.md).
 *     Rebuilds chain state and writes the indexer checkpoint so the
 *     indexer resumes where the rebuilt log ends.
 *
 * Rebuild = drop chain-derived/ephemeral state (dataClassification.ts),
 * re-fetch the chain event log from Soroban RPC from --start-ledger, and
 * replay it through the production indexer.
 *
 * Usage:
 *   tsx src/scripts/drDrill.ts --target-url <postgres-url> --start-ledger <n> [--mode drill|rebuild]
 *
 * --start-ledger must be inside the RPC's retention window (getHealth
 * oldestLedger). An RPC with a longer history-retention-window extends how
 * far back the rebuild can reach.
 *
 * Exit codes: 0 — rebuild done / drill found no chain-derived mismatches;
 * 1 — mismatches or failure. In a drill, rows missing from the recovered
 * database are intents created after the backup (the recovery point) and
 * are reported, not failed on.
 */

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Prisma, PrismaClient } from "@prisma/client";
import { getEnv } from "../env.js";
import { createLogger } from "../logger.js";
import { LedgerService } from "../services/ledger.js";
import { BackupService, isSameDatabase } from "../services/backupService.js";
import {
  SorobanRpcEventSource,
  firstEventIdOfLedger,
  ledgerOfEventId,
  sorobanNativeXdrDecoder
} from "../services/stellarIndexer.js";
import {
  ChainEventLogSource,
  diffChainState,
  refillEventLog,
  replayEventLog,
  resetChainDerivedState,
  resolvedPoisonEventIds
} from "../services/replayEquivalence.js";

const env = getEnv();
const logger = createLogger(env.LOG_LEVEL);

type Mode = "drill" | "rebuild";

function parseArgs(): { targetUrl: string; startLedger: number; mode: Mode } {
  const args = process.argv.slice(2);
  const value = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const targetUrl = value("--target-url");
  const startLedger = Number(value("--start-ledger"));
  const mode = (value("--mode") ?? "drill") as Mode;
  if (!targetUrl || !Number.isInteger(startLedger) || startLedger <= 0 || (mode !== "drill" && mode !== "rebuild")) {
    console.error("Usage: tsx src/scripts/drDrill.ts --target-url <postgres-url> --start-ledger <ledger> [--mode drill|rebuild]");
    process.exit(1);
  }
  return { targetUrl, startLedger, mode };
}

function migrate(databaseUrl: string): void {
  execFileSync(process.execPath, [fileURLToPath(new URL("../../node_modules/prisma/build/index.js", import.meta.url)), "migrate", "deploy"], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "inherit"
  });
}

/** Drops chain state in `target` and re-fetches the event log from chain history; returns events fetched. */
async function refetchChainHistory(target: PrismaClient, rpcUrl: string, startLedger: number): Promise<number> {
  // The contract filter the restored backup knew about, captured before the reset drops the registry.
  const staticIds = (env.INDEXER_CONTRACT_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const contractIds = [...new Set([...staticIds, ...(await new LedgerService(target).getActivePoolAddresses())])];
  await resetChainDerivedState(target);
  const rpc = new SorobanRpcEventSource({ rpcUrl: rpcUrl.split(",").map((s) => s.trim()), contractIds });
  return refillEventLog(target, rpc, startLedger);
}

async function rebuild(target: PrismaClient, targetUrl: string, rpcUrl: string, startLedger: number) {
  migrate(targetUrl);
  const eventsRefetched = await refetchChainHistory(target, rpcUrl, startLedger);
  const replay = await replayEventLog(
    target,
    new ChainEventLogSource(target, { skipEventIds: await resolvedPoisonEventIds(target) }),
    { decoder: sorobanNativeXdrDecoder, factoryAddress: env.VAULT_FACTORY_ADDRESS }
  );
  if (replay.cursor) {
    await new LedgerService(target).updateIndexerCheckpoint({
      latestLedger: ledgerOfEventId(replay.cursor) ?? startLedger,
      lastProcessedEventId: replay.cursor,
      success: true
    });
  }
  return { eventsRefetched, ...replay, verdict: replay.haltedOnQuarantine ? "HALTED_ON_QUARANTINE" : "REBUILT" };
}

async function drill(target: PrismaClient, targetUrl: string, rpcUrl: string, startLedger: number) {
  if (!env.BACKUP_DIR) throw new Error("BACKUP_DIR must be set: the drill restores the latest backup");

  const restore = await new BackupService({ backupDir: env.BACKUP_DIR, databaseUrl: env.DATABASE_URL, logger }).runRestoreDrill(targetUrl);
  if (!restore.success) throw new Error(`backup restore failed: ${restore.error}`);
  migrate(targetUrl);

  const eventsRefetched = await refetchChainHistory(target, rpcUrl, startLedger);

  const live = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } });
  try {
    const report = await live.$transaction(
      async (snapshot) => {
        const checkpoint = await snapshot.indexerCheckpoint.findUnique({ where: { id: "singleton" } });
        if (!checkpoint?.lastProcessedEventId) throw new Error("live indexer has no checkpoint to compare against");
        const horizon = { fromEventId: firstEventIdOfLedger(startLedger), toEventId: checkpoint.lastProcessedEventId };

        // Replay only what live has certainly applied, then validate.
        const replay = await replayEventLog(
          target,
          new ChainEventLogSource(target, { toEventId: horizon.toEventId, skipEventIds: await resolvedPoisonEventIds(target) }),
          { decoder: sorobanNativeXdrDecoder, factoryAddress: env.VAULT_FACTORY_ADDRESS }
        );
        const tables = await diffChainState(snapshot, target, horizon);
        return { horizon, replay, tables };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 60 * 60 * 1000, maxWait: 10_000 }
    );

    const mismatched = report.tables.reduce((n, t) => n + t.mismatched, 0);
    return {
      backupFile: restore.restore?.filePath,
      eventsRefetched,
      ...report,
      mismatched,
      rpoLostIntents: report.tables.find((t) => t.table === "action_ledger")?.missingInTarget ?? 0,
      verdict: mismatched === 0 ? "PASS" : "FAIL"
    };
  } finally {
    await live.$disconnect();
  }
}

async function run(): Promise<number> {
  const { targetUrl, startLedger, mode } = parseArgs();
  if (!env.SOROBAN_RPC_URL) throw new Error("SOROBAN_RPC_URL must be set: recovery rebuilds chain state from RPC");
  if (mode === "drill" && isSameDatabase(env.DATABASE_URL, targetUrl)) {
    throw new Error("--target-url must not be the live database in drill mode");
  }

  const startedAt = Date.now();
  const target = new PrismaClient({ datasources: { db: { url: targetUrl } } });
  try {
    const result =
      mode === "drill"
        ? await drill(target, targetUrl, env.SOROBAN_RPC_URL, startLedger)
        : await rebuild(target, targetUrl, env.SOROBAN_RPC_URL, startLedger);
    const report = { mode, startLedger, ...result, durationMs: Date.now() - startedAt };
    console.log(JSON.stringify(report, null, 2));
    logger.info({ event: `dr_${mode}.completed`, report }, "disaster-recovery run completed");
    return report.verdict === "PASS" || report.verdict === "REBUILT" ? 0 : 1;
  } finally {
    await target.$disconnect();
  }
}

run()
  .then((code) => process.exit(code))
  .catch((err) => {
    logger.error({ err }, "disaster-recovery run failed");
    console.error("disaster-recovery run failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
