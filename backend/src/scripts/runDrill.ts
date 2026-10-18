#!/usr/bin/env tsx
/**
 * CLI entry point for incident drills
 * 
 * Usage:
 *   npm run drill -- --type stuck_deposit --environment sandbox
 *   npm run drill:all -- --environment test
 */

import { PrismaClient } from "@prisma/client";
import { IncidentDrillExecutor, type DrillConfig, type IncidentType } from "../operations/incidentDrill.js";
import { LedgerService } from "../services/ledger.js";
import { PendingRecoveryService } from "../services/pendingRecovery.js";
import { QuestService } from "../services/questService.js";
import { StellarIndexer } from "../services/stellarIndexer.js";
import { createLogger } from "../logger.js";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const logger = createLogger(process.env.LOG_LEVEL ?? "info");

interface CliArgs {
  type?: IncidentType | "all";
  environment: "test" | "sandbox";
  autoRollback?: boolean;
  output?: string;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const parsed: Partial<CliArgs> = { autoRollback: true };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    if (arg === "--type" && args[i + 1]) {
      parsed.type = args[++i] as IncidentType | "all";
    } else if (arg === "--environment" && args[i + 1]) {
      parsed.environment = args[++i] as "test" | "sandbox";
    } else if (arg === "--no-rollback") {
      parsed.autoRollback = false;
    } else if (arg === "--output" && args[i + 1]) {
      parsed.output = args[++i];
    }
  }

  if (!parsed.environment) {
    console.error("Error: --environment is required (test or sandbox)");
    process.exit(1);
  }

  return parsed as CliArgs;
}

async function setupDependencies(prisma: PrismaClient) {
  const ledger = new LedgerService(prisma);
  const quests = new QuestService(prisma);

  // Mock recovery service for drills
  const recovery = new PendingRecoveryService({
    store: {
      insertIfAbsent: async (recoveryCase) => ({
        created: true,
        recoveryCase: { ...recoveryCase, version: 1 },
      }),
      load: async () => null,
      update: async (current, next) => next,
      list: async () => [],
    },
    actions: {
      getAction: async (id) => {
        const action = await prisma.actionLedger.findUnique({ where: { id } });
        return action
          ? {
              id: action.id,
              walletAddress: action.walletAddress,
              actionType: action.actionType,
              status: action.status,
              txHash: action.txHash,
              createdAt: action.createdAt,
              updatedAt: action.updatedAt,
            }
          : null;
      },
      listStale: async (cutoff, limit) => {
        const actions = await prisma.actionLedger.findMany({
          where: {
            status: { in: ["pending", "submitted"] },
            updatedAt: { lte: cutoff },
          },
          take: limit,
          orderBy: { updatedAt: "asc" },
        });
        return actions.map((a) => ({
          id: a.id,
          walletAddress: a.walletAddress,
          actionType: a.actionType,
          status: a.status,
          txHash: a.txHash,
          createdAt: a.createdAt,
          updatedAt: a.updatedAt,
        }));
      },
      countStale: async (cutoff) => {
        return prisma.actionLedger.count({
          where: {
            status: { in: ["pending", "submitted"] },
            updatedAt: { lte: cutoff },
          },
        });
      },
    },
    audit: {
      record: async () => {},
    },
  });

  // Mock indexer
  const indexer = {
    tick: async () => ({
      processed: 10,
      imported: 8,
      duplicates: 2,
      quarantined: 0,
      cursor: "drill-cursor",
      latestLedger: 1000,
      chainLatestLedger: 1100,
      ingestedLedger: 1000,
    }),
  } as unknown as StellarIndexer;

  return { ledger, recovery, quests, indexer };
}

async function runSingleDrill(
  executor: IncidentDrillExecutor,
  type: IncidentType,
  environment: "test" | "sandbox",
  autoRollback: boolean
) {
  const config: DrillConfig = { type, environment, autoRollback };
  
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Running drill: ${type}`);
  console.log(`Environment: ${environment}`);
  console.log(`Auto-rollback: ${autoRollback}`);
  console.log(`${"=".repeat(60)}\n`);

  const result = await executor.execute(config);

  console.log(`\n${result.summary}`);
  console.log(`Duration: ${result.durationMs}ms`);
  console.log(`Steps executed: ${result.steps.length}`);
  console.log(`Verifications: ${result.verifications.filter(v => v.passed).length}/${result.verifications.length} passed`);

  if (!result.passed) {
    console.log("\n❌ Failed verifications:");
    for (const v of result.verifications.filter(v => !v.passed)) {
      console.log(`  - ${v.check}`);
      console.log(`    Expected: ${JSON.stringify(v.expected)}`);
      console.log(`    Actual: ${JSON.stringify(v.actual)}`);
      if (v.message) console.log(`    Message: ${v.message}`);
    }
  }

  return result;
}

async function main() {
  const args = parseArgs();
  const prisma = new PrismaClient();

  try {
    const deps = await setupDependencies(prisma);
    const executor = new IncidentDrillExecutor({ prisma, ...deps });

    const drillTypes: IncidentType[] =
      args.type === "all"
        ? ["stuck_deposit", "indexer_lag", "quest_race", "settlement_timeout", "reconciliation_drift"]
        : [args.type!];

    const results = [];

    for (const type of drillTypes) {
      const result = await runSingleDrill(
        executor,
        type,
        args.environment,
        args.autoRollback ?? true
      );
      results.push(result);
    }

    // Summary
    console.log(`\n${"=".repeat(60)}`);
    console.log("DRILL SUMMARY");
    console.log(`${"=".repeat(60)}`);
    console.log(`Total drills: ${results.length}`);
    console.log(`Passed: ${results.filter(r => r.passed).length}`);
    console.log(`Failed: ${results.filter(r => !r.passed).length}`);

    // Save results if output specified
    if (args.output) {
      const outputPath = resolve(args.output);
      writeFileSync(outputPath, JSON.stringify(results, null, 2));
      console.log(`\nResults saved to: ${outputPath}`);
    }

    // Exit with error code if any drill failed
    const exitCode = results.some(r => !r.passed) ? 1 : 0;
    process.exit(exitCode);

  } catch (err) {
    logger.error({ err }, "drill execution failed");
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
