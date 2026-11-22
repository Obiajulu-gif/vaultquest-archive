import { PrismaClient } from "@prisma/client";
import { getEnv } from "../env.js";

type QueryClient = Pick<PrismaClient, "$transaction">;
type Check = { name: string; count: number; remediation: string };

const REQUIRED_TABLES = [
  "action_ledger",
  "chain_events",
  "indexer_checkpoints",
  "pool_registry",
  "saved_pools",
  "vault_settlements",
  "user_quests",
  "reward_grants",
];

/**
 * Read-only post-restore validation. It deliberately reports counts and
 * table names only; no wallet addresses, transaction hashes, or payloads.
 */
export async function validateRestoredDatabase(prisma: QueryClient) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    const existing = await tx.$queryRawUnsafe<Array<{ table_name: string | null }>>(
      "SELECT t.table_name FROM unnest($1::text[]) AS t(table_name) WHERE to_regclass('public.' || t.table_name) IS NOT NULL",
      REQUIRED_TABLES,
    );
    const present = new Set(existing.map((row) => row.table_name));
    const missingTables = REQUIRED_TABLES.filter((table) => !present.has(table));
    const checks: Check[] = [];
    const run = async (name: string, sql: string, remediation: string, requires: string[]) => {
      if (requires.some((table) => !present.has(table))) return;
      const rows = await tx.$queryRawUnsafe<Array<{ count: bigint | number }>>(sql);
      checks.push({ name, count: Number(rows[0]?.count ?? 0), remediation });
    };

    await run(
      "confirmed actions missing transaction reference",
      "SELECT COUNT(*)::bigint AS count FROM action_ledger WHERE status = 'confirmed' AND (tx_hash IS NULL OR tx_hash = '')",
      "Compare against the chain event log and restore the transaction hash only from verified chain data.",
      ["action_ledger"],
    );
    await run(
      "confirmed actions missing verified event payload",
      "SELECT COUNT(*)::bigint AS count FROM action_ledger WHERE status = 'confirmed' AND verified_payload IS NULL",
      "Reconcile each action against chain_events; do not trust client-submitted action_payload as confirmation.",
      ["action_ledger"],
    );
    await run(
      "settlement state and resolution timestamp mismatch",
      "SELECT COUNT(*)::bigint AS count FROM vault_settlements WHERE (state = 'Resolved' AND resolved_at IS NULL) OR (state <> 'Resolved' AND resolved_at IS NOT NULL)",
      "Inspect settlement and chain records before correcting state; never infer successful payment from the database alone.",
      ["vault_settlements"],
    );
    await run(
      "reward grants marked granted without grant timestamp",
      "SELECT COUNT(*)::bigint AS count FROM reward_grants WHERE status = 'granted' AND granted_at IS NULL",
      "Verify the reward transaction on chain, then repair the grant record through the supported reconciliation workflow.",
      ["reward_grants"],
    );
    await run(
      "saved pools without a pool registry entry",
      "SELECT COUNT(*)::bigint AS count FROM saved_pools s WHERE NOT EXISTS (SELECT 1 FROM pool_registry p WHERE p.pool_address = s.pool_id)",
      "Confirm whether the pool exists on chain and is indexed; avoid deleting saved user references during recovery.",
      ["saved_pools", "pool_registry"],
    );
    await run(
      "chain events without a transaction hash",
      "SELECT COUNT(*)::bigint AS count FROM chain_events WHERE tx_hash IS NULL OR tx_hash = ''",
      "Refetch the affected event range from Soroban RPC and compare before modifying the event log.",
      ["chain_events"],
    );
    await run(
      "duplicate quest identities",
      "SELECT COUNT(*)::bigint AS count FROM (SELECT wallet_address, quest_id FROM user_quests GROUP BY wallet_address, quest_id HAVING COUNT(*) > 1) duplicates",
      "Preserve the newest verified progress record and reconcile reward grants before manually resolving duplicates.",
      ["user_quests"],
    );
    await run(
      "reward grants without a matching user quest",
      "SELECT COUNT(*)::bigint AS count FROM reward_grants g WHERE NOT EXISTS (SELECT 1 FROM user_quests q WHERE q.wallet_address = g.wallet_address AND q.quest_id = g.quest_id)",
      "Compare the grant with its idempotency key and chain payment records before restoring or removing either row.",
      ["reward_grants", "user_quests"],
    );

    const failed = checks.filter((check) => check.count > 0);
    return {
      readOnly: true,
      status: missingTables.length || failed.length ? "needs_review" : "valid",
      checkedAt: new Date().toISOString(),
      missingTables,
      checks,
      failureCount: missingTables.length + failed.length,
    };
  }, { isolationLevel: "RepeatableRead" });
}

async function main() {
  const env = getEnv();
  const prisma = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } });
  try {
    // `--rebuild-derived` runs the full restore-verification pipeline: the
    // read-only invariants below plus derived-view rebuild, staleness repair
    // dispatch, and mismatch verification with explicit repair steps.
    if (process.argv.includes("--rebuild-derived")) {
      const { verifyRestoredDatabase } = await import("../services/restoreVerificationService.js");
      const report = await verifyRestoredDatabase(prisma, { rebuildDerived: true });
      console.log(JSON.stringify(report, null, 2));
      if (report.failureCount) process.exitCode = 1;
      return;
    }

    const report = await validateRestoredDatabase(prisma);
    console.log(JSON.stringify(report, null, 2));
    if (report.failureCount) process.exitCode = 1;
  } catch (error) {
    // Prisma errors can contain connection strings. Print only a stable class
    // and a generic hint; never serialize the error object or DATABASE_URL.
    console.error(JSON.stringify({
      status: "unavailable",
      readOnly: true,
      errorType: error instanceof Error ? error.name : "UnknownError",
      hint: "Check database connectivity and schema migrations, then retry.",
    }, null, 2));
    process.exitCode = 2;
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1]?.endsWith("validateRestore.ts")) void main();
