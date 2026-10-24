import type { PrismaClient } from "@prisma/client";
import { z } from "zod";

export const SNAPSHOT_SCHEMA = "vaultquest.backup-snapshot.v1";
export const SNAPSHOT_TABLES = ["users", "action_ledger", "chain_events", "indexer_checkpoints",
  "pool_registry", "saved_pools", "vault_settlements", "user_quests", "reward_grants"] as const;
type Table = typeof SNAPSHOT_TABLES[number];
type Row = Record<string, unknown>;
const envelope = z.object({
  schema: z.literal(SNAPSHOT_SCHEMA), capturedAt: z.string().datetime(),
  rowCounts: z.record(z.string(), z.number().int().nonnegative()),
  tables: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))),
}).strict();
export type BackupSnapshot = z.infer<typeof envelope>;
export interface SnapshotFinding {
  code: "MALFORMED_SNAPSHOT" | "MISSING_TABLE" | "MISSING_RECORD" | "DUPLICATE_KEY" | "ORPHAN_REFERENCE" | "INCONSISTENT_STATE";
  table?: Table;
  row?: number;
  invariant: string;
}

/** Logical validation companion to a pg_dump archive. Never modifies the file or a database. */
export function validateBackupSnapshot(input: unknown) {
  const parsed = envelope.safeParse(input);
  const findings: SnapshotFinding[] = [];
  if (!parsed.success) {
    return { schema: SNAPSHOT_SCHEMA, readOnly: true, status: "needs_review", failureCount: 1,
      findings: [{ code: "MALFORMED_SNAPSHOT", invariant: "snapshot envelope or schema version is invalid" }] };
  }
  const snapshot = parsed.data;
  const add = (code: SnapshotFinding["code"], table: Table, invariant: string, row?: number) =>
    findings.push({ code, table, invariant, ...(row === undefined ? {} : { row }) });
  for (const table of SNAPSHOT_TABLES) {
    if (!snapshot.tables[table] || snapshot.rowCounts[table] === undefined) add("MISSING_TABLE", table, "table and captured row count must be present");
    else if (snapshot.tables[table]!.length !== snapshot.rowCounts[table]) add("MISSING_RECORD", table, "row count differs from capture manifest");
  }
  const rows = (table: Table): Row[] => snapshot.tables[table] ?? [];
  const text = (r: Row, field: string) => typeof r[field] === "string" && (r[field] as string).trim().length > 0;
  const date = (v: unknown) => typeof v === "string" && Number.isFinite(Date.parse(v));
  const key = (r: Row, fields: string[]) => JSON.stringify(fields.map((f) => r[f]));
  const unique = (table: Table, fields: string[], optional = false) => {
    const seen = new Set<string>();
    rows(table).forEach((r, row) => {
      if (optional && fields.some((f) => r[f] == null)) return;
      if (fields.some((f) => !text(r, f))) { add("INCONSISTENT_STATE", table, `required key fields: ${fields.join(", ")}`, row); return; }
      const k = key(r, fields);
      if (seen.has(k)) add("DUPLICATE_KEY", table, `unique key: ${fields.join(", ")}`, row);
      seen.add(k);
    });
  };
  for (const table of SNAPSHOT_TABLES) unique(table, ["id"]);
  unique("users", ["walletAddress"], true);
  unique("users", ["email"], true);
  unique("action_ledger", ["idempotencyKey"]);
  unique("action_ledger", ["txHash"], true);
  unique("pool_registry", ["poolAddress"]);
  unique("saved_pools", ["walletAddress", "poolId"]);
  unique("user_quests", ["walletAddress", "questId"]);
  unique("reward_grants", ["idempotencyKey"]);
  const poolIds = new Set(rows("pool_registry").map((r) => r.poolAddress));
  const eventIds = new Set(rows("chain_events").map((r) => r.id));
  const quests = new Set(rows("user_quests").map((r) => key(r, ["walletAddress", "questId"])));
  rows("saved_pools").forEach((r, row) => {
    if (!poolIds.has(r.poolId)) add("ORPHAN_REFERENCE", "saved_pools", "saved pool must exist in pool_registry", row);
  });
  rows("reward_grants").forEach((r, row) => {
    if (!quests.has(key(r, ["walletAddress", "questId"]))) add("ORPHAN_REFERENCE", "reward_grants", "reward must reference a user quest", row);
    if (!["pending", "granted", "failed"].includes(String(r.status)) || (r.status === "granted" && !date(r.grantedAt))) {
      add("INCONSISTENT_STATE", "reward_grants", "reward status and grant timestamp must agree", row);
    }
  });
  rows("action_ledger").forEach((r, row) => {
    if (!["pending", "submitted", "confirmed", "failed", "reverted", "orphaned"].includes(String(r.status)) ||
      (r.status === "confirmed" && (!text(r, "txHash") || !date(r.confirmedAt) || (!r.redactedAt && r.verifiedPayload == null)))) {
      add("INCONSISTENT_STATE", "action_ledger", "confirmed actions require verified event evidence, transaction and timestamp", row);
    }
    if (r.sorobanEventId != null && !eventIds.has(r.sorobanEventId)) add("ORPHAN_REFERENCE", "action_ledger", "action event reference must exist in chain_events", row);
  });
  rows("chain_events").forEach((r, row) => {
    if (!text(r, "txHash") || !text(r, "contractId") || !Number.isSafeInteger(r.ledger) || Number(r.ledger) < 0 ||
      !Array.isArray(r.topicXdr) || r.topicXdr.some((t) => typeof t !== "string") || typeof r.valueXdr !== "string" || typeof r.successful !== "boolean") {
      add("INCONSISTENT_STATE", "chain_events", "raw event envelope must be replayable", row);
    }
  });
  rows("vault_settlements").forEach((r, row) => {
    if (!["Unresolved", "Resolving", "PendingVerification", "Resolved"].includes(String(r.state)) ||
      (r.state === "Resolved" ? !date(r.resolvedAt) : r.resolvedAt != null)) {
      add("INCONSISTENT_STATE", "vault_settlements", "settlement state and resolution timestamp must agree", row);
    }
  });
  return { schema: SNAPSHOT_SCHEMA, readOnly: true, status: findings.length ? "needs_review" : "valid",
    failureCount: findings.length, findings };
}

/** Capture a consistent, read-only snapshot of the fields used by these invariants. */
export async function captureBackupSnapshot(prisma: PrismaClient): Promise<BackupSnapshot> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    const tables: Record<string, unknown[]> = {
      users: await tx.user.findMany({ select: { id: true, walletAddress: true, email: true } }),
      action_ledger: await tx.actionLedger.findMany({ select: { id: true, idempotencyKey: true, status: true,
        txHash: true, sorobanEventId: true, confirmedAt: true, redactedAt: true, verifiedPayload: true } }),
      chain_events: await tx.chainEvent.findMany({ orderBy: { id: "asc" } }),
      indexer_checkpoints: await tx.indexerCheckpoint.findMany(),
      pool_registry: await tx.poolRegistry.findMany({ select: { id: true, poolAddress: true } }),
      saved_pools: await tx.savedPool.findMany({ select: { id: true, walletAddress: true, poolId: true } }),
      vault_settlements: await tx.vaultSettlement.findMany({ select: { id: true, state: true, resolvedAt: true } }),
      user_quests: await tx.userQuest.findMany({ select: { id: true, walletAddress: true, questId: true } }),
      reward_grants: await tx.rewardGrant.findMany({ select: { id: true, walletAddress: true, questId: true,
        idempotencyKey: true, status: true, grantedAt: true } }),
    };
    return JSON.parse(JSON.stringify({ schema: SNAPSHOT_SCHEMA, capturedAt: new Date().toISOString(),
      rowCounts: Object.fromEntries(Object.entries(tables).map(([table, data]) => [table, data.length])), tables })) as BackupSnapshot;
  }, { isolationLevel: "RepeatableRead", timeout: 120000 });
}
