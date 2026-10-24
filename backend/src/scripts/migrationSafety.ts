/**
 * Migration safety framework for the Prisma migration folders (#790).
 *
 * `prisma migrate deploy` applies SQL and reports success, but the folders here
 * are hand-maintained and several of them are destructive (a dropped column, a
 * dropped table) or rewrite rows. Nothing in the current toolchain tells an
 * operator, before the write, how many records a statement will touch, or
 * afterwards whether the database actually converged.
 *
 * This module adds the three missing pieces, all operating on the SQL in
 * `prisma/migrations/<id>/migration.sql`:
 *
 *  1. **Preview / dry-run** — {@link parseMigrationSql} builds a plan and
 *     {@link previewMigration} intersects it with the live database, so affected
 *     records are reported *before* any write.
 *  2. **Post-checks** — {@link runPostChecks} verifies the objects a migration
 *     claims to provide actually exist, and that backfills completed.
 *  3. **Rollback / forward-fix** — {@link rollbackNotes} describes how to reverse
 *     each risky statement or what the forward fix is.
 *
 * The database is reached through {@link MigrationDatabase} so the whole
 * framework is testable without Postgres.
 *
 *  4. **Duplicate detection** — {@link detectDuplicates} checks user-submitted
 *     records against canonical fields, flagging exact duplicates as blocking
 *     and near duplicates as ambiguous for maintainer review.
 *
 *  5. **Rollback verification** — {@link verifyRollback} classifies the schema
 *     after a failed or reverted migration as fully reverted, fully applied or
 *     partial, and cross-checks Prisma's migration ledger (#1000).
 */

import * as fs from "fs";
import * as path from "path";

export type MigrationActionKind =
  | "create-table"
  | "drop-table"
  | "create-index"
  | "drop-index"
  | "add-column"
  | "drop-column"
  | "alter-column"
  | "data-update"
  | "other"
  | "duplicate-check";

export interface PlannedAction {
  kind: MigrationActionKind;
  name: string;
  table?: string;
  column?: string;
  /** Removes an object or column. */
  destructive: boolean;
  /** Rewrites rows. */
  touchesData: boolean;
  /** Rewrites every row in the table (backfill with no WHERE). */
  rewritesAllRows: boolean;
  sql: string;
}

export interface MigrationPlan {
  migrationId: string;
  actions: PlannedAction[];
  creates: PlannedAction[];
  destructive: PlannedAction[];
  dataChanges: PlannedAction[];
  /** Nothing in the plan would create or alter anything. */
  isEmpty: boolean;
}

export interface AffectedRecords {
  table: string;
  /** null when the live count could not be determined (missing table, no grants). */
  rowCount: number | null;
  /** Rows the statement's WHERE clause would match, when determinable. */
  matchingRows: number | null;
  columns: string[];
}

export type DuplicateSeverity = "exact" | "near" | "none";

export interface DuplicateKey {
  /** Canonical field names that together form the duplicate key. */
  fields: string[];
  /** Normalization applied before comparison. */
  normalize: (value: string) => string;
}

export interface DuplicateCandidate {
  /** Stable identifier for the record being checked. */
  id: string;
  /** Raw field values keyed by canonical field name. */
  values: Record<string, string | null | undefined>;
}

export interface DuplicateMatch {
  /** The candidate record that was checked. */
  candidate: DuplicateCandidate;
  /** The existing record it matched, if any. */
  existing: DuplicateCandidate | null;
  severity: DuplicateSeverity;
  /** Human-readable explanation of the match. */
  reason: string;
  /** Fields that contributed to the match. */
  matchedFields: string[];
}

export interface DuplicateReport {
  /** Exact duplicates block submission. */
  blocking: DuplicateMatch[];
  /** Near duplicates require maintainer review. */
  review: DuplicateMatch[];
  /** Candidates with no match. */
  clean: DuplicateMatch[];
  /** True when nothing blocks submission. */
  ok: boolean;
}

export interface MigrationPreview {
  plan: MigrationPlan;
  alreadyPresent: string[];
  wouldCreate: string[];
  wouldRunDestructive: PlannedAction[];
  affectedRecords: AffectedRecords[];
  rollbackNotes: string[];
  /** True when applying would be a no-op (schema already converged). */
  noop: boolean;
}

export interface MigrationDatabase {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export interface PostCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface PostCheckReport {
  ok: boolean;
  checks: PostCheck[];
  failures: PostCheck[];
}

export interface DuplicateReviewResolution {
  candidateId: string;
  existingId: string | null;
  decision: "allow" | "reject";
  reviewer: string;
  note?: string;
}

const normalize = (sql: string) => sql.replace(/\s+/g, " ").trim();

const identifier = (after?: string): string => {
  if (!after) return "";
  const match = after.match(/"([^"]+)"|([A-Za-z_][\w$]*)/);
  return match ? (match[1] ?? match[2] ?? "") : "";
  return match?.[1] ?? match?.[2] ?? "";
};

/**
 * Default canonical key for VaultQuest user-submitted records: the vault
 * address plus the prize draw identifier, normalized to lowercase and with
 * surrounding whitespace removed. Callers may override for other record types.
 */
export const DEFAULT_DUPLICATE_KEY: DuplicateKey = {
  fields: ["vaultAddress", "drawId"],
  normalize: (value: string) => value.trim().toLowerCase(),
};

/**
 * Parses a migration file into a classified plan. Recognises the DDL forms used
 * across `prisma/migrations`; anything unrecognised becomes `other` rather than
 * being guessed at, and still shows up in the plan.
 */
export function parseMigrationSql(migrationId: string, sql: string): MigrationPlan {
  const actions: PlannedAction[] = [];
  const withoutComments = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");

  for (const raw of withoutComments.split(";")) {
    const statement = normalize(raw);
    if (!statement) continue;
    let match: RegExpExecArray | null;

    if ((match = /^CREATE TABLE (IF NOT EXISTS )?"?([^"\s(]+)"?/i.exec(statement))) {
      const name = identifier(statement.replace(/^CREATE TABLE (IF NOT EXISTS )?/i, ""));
      actions.push({
        kind: "create-table",
        name,
        table: name,
        destructive: false,
        touchesData: false,
        rewritesAllRows: false,
        sql: statement,
      });
      continue;
    }

    if ((match = /^DROP TABLE (IF EXISTS )?"?([^"\s;]+)"?/i.exec(statement))) {
      const name = identifier(statement.replace(/^DROP TABLE (IF EXISTS )?/i, ""));
      actions.push({
        kind: "drop-table",
        name,
        table: name,
        destructive: true,
        touchesData: true,
        rewritesAllRows: true,
        sql: statement,
      });
      continue;
    }

    if ((match = /^CREATE (UNIQUE )?INDEX (IF NOT EXISTS )?"?([^"\s(]+)"?/i.exec(statement))) {
      const name = identifier(statement.replace(/^CREATE (UNIQUE )?INDEX (IF NOT EXISTS )?/i, ""));
      const onTable = / ON "?([A-Za-z_][\w$]*)"?/i.exec(statement);
      actions.push({
        kind: "create-index",
        name,
        table: onTable?.[1] ? identifier(onTable[1]) : undefined,
        destructive: false,
        touchesData: false,
        rewritesAllRows: false,
        sql: statement,
      });
      continue;
    }

    if ((match = /^DROP INDEX (IF EXISTS )?"?([^"\s;]+)"?/i.exec(statement))) {
      const name = identifier(statement.replace(/^DROP INDEX (IF EXISTS )?/i, ""));
      actions.push({
        kind: "drop-index",
        name,
        destructive: true,
        touchesData: false,
        rewritesAllRows: false,
        sql: statement,
      });
      continue;
    }

    if ((match = /^ALTER TABLE "?([^"\s]+)"? ADD COLUMN (IF NOT EXISTS )?"?([^"\s]+)"?/i.exec(statement))) {
      const table = identifier(match[1]);
      const column = identifier(match[3]);
      const table = identifier(match[1] ?? "");
      const column = identifier(match[3] ?? "");
      actions.push({
        kind: "add-column",
        name: `${table}.${column}`,
        table,
        column,
        destructive: false,
        touchesData: false,
        rewritesAllRows: false,
        sql: statement,
      });
      continue;
    }

    if ((match = /^ALTER TABLE "?([^"\s]+)"? DROP COLUMN (IF EXISTS )?"?([^"\s]+)"?/i.exec(statement))) {
      const table = identifier(match[1]);
      const column = identifier(match[3]);
      const table = identifier(match[1] ?? "");
      const column = identifier(match[3] ?? "");
      actions.push({
        kind: "drop-column",
        name: `${table}.${column}`,
        table,
        column,
        destructive: true,
        touchesData: true,
        rewritesAllRows: true,
        sql: statement,
      });
      continue;
    }

    if ((match = /^ALTER TABLE "?([^"\s]+)"? ALTER COLUMN "?([^"\s]+)"? (.+)/i.exec(statement))) {
      const table = identifier(match[1]);
      const column = identifier(match[2]);
      const table = identifier(match[1] ?? "");
      const column = identifier(match[2] ?? "");
      const alteration = match[3] ?? "";
      const isNotNull = /SET NOT NULL/i.test(alteration);
      actions.push({
        kind: "alter-column",
        name: `${table}.${column}`,
        table,
        column,
        destructive: false,
        // SET NOT NULL can fail (or rewrite) when nulls remain.
        touchesData: isNotNull,
        rewritesAllRows: false,
        sql: statement,
      });
      continue;
    }

    if ((match = /^UPDATE "?([^"\s]+)"?/i.exec(statement))) {
      const table = identifier(match[1]);
      const table = identifier(match[1] ?? "");
      const hasWhere = /\bWHERE\b/i.test(statement);
      actions.push({
        kind: "data-update",
        name: table,
        table,
        destructive: false,
        touchesData: true,
        rewritesAllRows: !hasWhere,
        sql: statement,
      });
      continue;
    }

    actions.push({
      kind: "other",
      name: statement.slice(0, 60),
      destructive: false,
      touchesData: false,
      rewritesAllRows: false,
      sql: statement,
    });
  }

  const creates = actions.filter((a) => ["create-table", "create-index", "add-column"].includes(a.kind));
  const destructive = actions.filter((a) => a.destructive);
  const dataChanges = actions.filter((a) => a.touchesData);

  return {
    migrationId,
    actions,
    creates,
    destructive,
    dataChanges,
    isEmpty: actions.length === 0,
  };
}

export function readMigrationPlan(
  migrationsDir: string,
  migrationId: string,
): MigrationPlan {
  const file = path.join(migrationsDir, migrationId, "migration.sql");
  return parseMigrationSql(migrationId, fs.readFileSync(file, "utf-8"));
}

export function listMigrationIds(migrationsDir: string): string[] {
  return fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{8,}/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

async function relationExists(db: MigrationDatabase, name: string, kind: "table" | "index"): Promise<boolean> {
  const res = await db.query(
    `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relname = $1 AND c.relkind = ANY($2::char[]) AND n.nspname = current_schema() LIMIT 1`,
    [name, kind === "table" ? ["r", "p"] : ["i"]],
  );
  return res.rows.length > 0;
}

async function columnExists(db: MigrationDatabase, table: string, column: string): Promise<boolean> {
  const res = await db.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2 LIMIT 1`,
    [table, column],
  );
  return res.rows.length > 0;
}

async function countRows(db: MigrationDatabase, table: string): Promise<number | null> {
  try {
    const res = await db.query(`SELECT COUNT(*)::int AS count FROM "${table}"`);
    const value = res.rows[0]?.count;
    return typeof value === "number" ? value : null;
  } catch {
    return null;
  }
}

/**
 * Reports what a migration would do, issuing only SELECTs. Safe to run against
 * production.
 */
export async function previewMigration(
  plan: MigrationPlan,
  db: MigrationDatabase,
): Promise<MigrationPreview> {
  const alreadyPresent: string[] = [];
  const wouldCreate: string[] = [];
  const affectedRecords: AffectedRecords[] = [];

  for (const action of plan.actions) {
    if (action.kind === "create-table" && action.table) {
      (await relationExists(db, action.table, "table"))
        ? alreadyPresent.push(action.name)
        : wouldCreate.push(action.name);
    } else if (action.kind === "create-index" && action.name) {
      (await relationExists(db, action.name, "index"))
        ? alreadyPresent.push(action.name)
        : wouldCreate.push(action.name);
    } else if (action.kind === "add-column" && action.table && action.column) {
      (await columnExists(db, action.table, action.column))
        ? alreadyPresent.push(action.name)
        : wouldCreate.push(action.name);
    }
  }

  // One row count per table touched by a data-changing statement.
  const seen = new Set<string>();
  for (const action of plan.dataChanges) {
    if (!action.table || seen.has(action.table)) continue;
    seen.add(action.table);
    affectedRecords.push({
      table: action.table,
      rowCount: await countRows(db, action.table),
      matchingRows: action.rewritesAllRows ? await countRows(db, action.table) : null,
      columns: action.column ? [action.column] : [],
    });
  }

  return {
    plan,
    alreadyPresent,
    wouldCreate,
    wouldRunDestructive: await resolveDestructive(plan.destructive, db),
    affectedRecords,
    rollbackNotes: rollbackNotes(plan),
    noop: wouldCreate.length === 0 && plan.dataChanges.length === 0 && plan.destructive.length === 0,
  };
}

async function resolveDestructive(
  actions: PlannedAction[],
  db: MigrationDatabase,
): Promise<PlannedAction[]> {
  const present: PlannedAction[] = [];
  for (const action of actions) {
    if (action.kind === "drop-table" && action.table) {
      if (await relationExists(db, action.table, "table")) present.push(action);
      continue;
    }
    if (action.kind === "drop-column" && action.table && action.column) {
      if (await columnExists(db, action.table, action.column)) present.push(action);
      continue;
    }
    present.push(action);
  }
  return present;
}

/** Operator-facing rollback or forward-fix guidance per risky statement. */
export function rollbackNotes(plan: MigrationPlan): string[] {
  const notes: string[] = [];

  for (const action of plan.destructive) {
    if (action.kind === "drop-column") {
      notes.push(
        `${action.name}: column values are unrecoverable without a dump. Re-add with ` +
          `ALTER TABLE "${action.table}" ADD COLUMN "${action.column}" <original type>; ` +
          `restore values from a pre-migration pg_dump.`,
      );
    }
    if (action.kind === "drop-table") {
      notes.push(
        `${action.name}: the table and its data are removed. Restore with a pre-migration ` +
          `pg_dump, or re-create the table and repopulate before re-running.`,
      );
    }
    if (action.kind === "drop-index") {
      notes.push(
        `${action.name}: only the index is lost. Recreate it from this migration's ` +
          `CREATE INDEX statement; no data is affected.`,
      );
    }
  }

  for (const action of plan.dataChanges) {
    if (action.kind === "data-update") {
      notes.push(
        `${action.name}: ${action.rewritesAllRows ? "every row is rewritten" : "matching rows are rewritten"} ` +
          `in place. Reverse by restoring the affected columns from a pre-migration pg_dump.`,
      );
    }
    if (action.kind === "alter-column" && action.touchesData) {
      notes.push(
        `${action.name}: SET NOT NULL fails if any NULL remains. Backfill first, then re-run; ` +
          `the migration is written to be re-runnable.`,
      );
    }
  }

  if (notes.length === 0) {
    notes.push("No destructive or data-rewriting statements — safe to apply and safe to re-run.");
  }
  return notes;
}

/**
 * Verifies convergence after a migration ran. Each object the plan creates is
 * checked independently so a partial failure names the specific object.
 */
export async function runPostChecks(db: MigrationDatabase, plan: MigrationPlan): Promise<PostCheckReport> {
  const checks: PostCheck[] = [];

  for (const action of plan.creates) {
    if (action.kind === "create-table" && action.table) {
      const exists = await relationExists(db, action.table, "table");
      checks.push({
        name: `table ${action.table} exists`,
        ok: exists,
        detail: exists ? "present" : "missing after migration",
      });
    } else if (action.kind === "create-index" && action.name) {
      const exists = await relationExists(db, action.name, "index");
      checks.push({
        name: `index ${action.name} exists`,
        ok: exists,
        detail: exists ? "present" : "missing after migration",
      });
    } else if (action.kind === "add-column" && action.table && action.column) {
      const exists = await columnExists(db, action.table, action.column);
      checks.push({
        name: `column ${action.table}.${action.column} exists`,
        ok: exists,
        detail: exists ? "present" : "missing after migration",
      });
    }
  }

  // A SET NOT NULL that "succeeded" while NULLs remain means a partial rollout.
  for (const action of plan.actions) {
    if (action.kind !== "alter-column" || !action.touchesData) continue;
    if (!action.table || !action.column) continue;
    try {
      const res = await db.query(
        `SELECT COUNT(*)::int AS count FROM "${action.table}" WHERE "${action.column}" IS NULL`,
      );
      const remaining = res.rows[0]?.count ?? 0;
      checks.push({
        name: `${action.table}.${action.column} has no NULL rows`,
        ok: remaining === 0,
        detail: remaining === 0 ? "constraint satisfied" : `${remaining} NULL row(s) remain`,
      });
    } catch {
      checks.push({
        name: `${action.table}.${action.column} verified`,
        ok: false,
        detail: "could not verify (table or column missing)",
      });
    }
  }

  const failures = checks.filter((c) => !c.ok);
  return { ok: failures.length === 0, checks, failures };
}

export type RollbackExpectation = "reverted" | "applied";
export type RollbackState = RollbackExpectation | "partial" | "unverifiable";
/** What an object's presence says about the migration: applied, reverted, or nothing reliable. */
export type RollbackSignal = "applied" | "reverted" | "ambiguous" | "unknown";
export type LedgerStatus = "applied" | "failed" | "rolled-back" | "absent" | "unknown";

export interface RollbackCheck {
  name: string;
  present: boolean | null;
  signal: RollbackSignal;
  detail: string;
}

export interface RollbackReport {
  migrationId: string;
  expected: RollbackExpectation;
  state: RollbackState;
  /** True only when the observed state matches the expectation and the ledger agrees. */
  ok: boolean;
  checks: RollbackCheck[];
  ledger: LedgerStatus;
  guidance: string[];
}

interface TrackedObject {
  kind: "table" | "index" | "column";
  name: string;
  table?: string;
  column?: string;
  /** Whether the object exists once the migration has been applied. */
  presentWhenApplied: boolean;
  /** A DROP ... IF EXISTS of an absent object is a no-op, so absence proves nothing. */
  ifExists: boolean;
}

/** Final intended state of every schema object the plan touches; later statements win. */
function trackedObjects(plan: MigrationPlan): TrackedObject[] {
  const objects = new Map<string, TrackedObject>();
  for (const action of plan.actions) {
    const ifExists = /\bIF EXISTS\b/i.test(action.sql);
    if ((action.kind === "create-table" || action.kind === "drop-table") && action.table) {
      objects.set(`table:${action.table}`, {
        kind: "table", name: action.table, table: action.table,
        presentWhenApplied: action.kind === "create-table", ifExists,
      });
    } else if ((action.kind === "create-index" || action.kind === "drop-index") && action.name) {
      objects.set(`index:${action.name}`, {
        kind: "index", name: action.name, presentWhenApplied: action.kind === "create-index", ifExists,
      });
    } else if ((action.kind === "add-column" || action.kind === "drop-column") && action.table && action.column) {
      objects.set(`column:${action.table}.${action.column}`, {
        kind: "column", name: `${action.table}.${action.column}`, table: action.table, column: action.column,
        presentWhenApplied: action.kind === "add-column", ifExists,
      });
    }
  }
  return [...objects.values()];
}

async function probe(db: MigrationDatabase, object: TrackedObject): Promise<boolean | null> {
  try {
    if (object.kind === "column") return await columnExists(db, object.table!, object.column!);
    return await relationExists(db, object.name, object.kind);
  } catch {
    return null;
  }
}

/** Reads Prisma's own migration ledger; `unknown` when it cannot be queried. */
export async function readMigrationLedger(db: MigrationDatabase, migrationId: string): Promise<LedgerStatus> {
  try {
    const res = await db.query(
      `SELECT finished_at, rolled_back_at FROM _prisma_migrations WHERE migration_name = $1 ORDER BY started_at DESC LIMIT 1`,
      [migrationId],
    );
    const row = res.rows[0];
    if (!row) return "absent";
    if (row.rolled_back_at) return "rolled-back";
    return row.finished_at ? "applied" : "failed";
  } catch {
    return "unknown";
  }
}

/**
 * Verifies the database after a failed migration or a rollback (#1000).
 *
 * Each object the plan creates or drops is probed and classified as evidence
 * the migration is applied or reverted. All-applied is `applied`, all-reverted
 * is `reverted`, a mix is `partial`, and a plan with no reliable evidence (or a
 * probe that could not run) is `unverifiable`. Anything but the expected state
 * fails the report, as does a Prisma ledger that disagrees with the schema.
 * Row data is never inspected, so data-changing statements always get guidance
 * to compare against a pre-migration dump.
 */
export async function verifyRollback(
  db: MigrationDatabase,
  plan: MigrationPlan,
  expected: RollbackExpectation = "reverted",
): Promise<RollbackReport> {
  const checks: RollbackCheck[] = [];
  for (const object of trackedObjects(plan)) {
    const present = await probe(db, object);
    const label = `${object.kind} ${object.name}`;
    if (present === null) {
      checks.push({ name: label, present, signal: "unknown", detail: "could not query the database" });
    } else if (present === object.presentWhenApplied) {
      const ambiguous = !present && object.ifExists;
      checks.push({
        name: label,
        present,
        signal: ambiguous ? "ambiguous" : "applied",
        detail: ambiguous
          ? "absent; DROP ... IF EXISTS makes this indistinguishable from never having existed"
          : present ? "present (as after the migration)" : "absent (as after the migration)",
      });
    } else {
      checks.push({
        name: label,
        present,
        signal: "reverted",
        detail: present ? "present (as before the migration)" : "absent (as before the migration)",
      });
    }
  }

  const signals = new Set(checks.map((c) => c.signal).filter((s) => s !== "ambiguous"));
  let state: RollbackState;
  if (signals.has("unknown") || signals.size === 0) state = "unverifiable";
  else if (signals.size === 2) state = "partial";
  else state = signals.has("applied") ? "applied" : "reverted";

  const ledger = await readMigrationLedger(db, plan.migrationId);
  const guidance: string[] = [];
  const names = (signal: RollbackSignal) => checks.filter((c) => c.signal === signal).map((c) => c.name).join(", ");
  const resolve = (flag: "--rolled-back" | "--applied") =>
    `npx prisma migrate resolve ${flag} ${plan.migrationId}`;

  if (state === "partial") {
    guidance.push(
      `Partial migration. Applied: ${names("applied")}. Reverted: ${names("reverted")}. ` +
        "Do not re-run blindly: either finish the rollback by hand (see rollback notes) or fix forward by re-applying the missing statements.",
    );
  } else if (state === "unverifiable") {
    guidance.push(
      "Schema state could not be determined (no reliable evidence, or the database could not be queried). " +
        "Treat the migration as unverified and inspect the schema manually.",
    );
  } else if (state !== expected) {
    guidance.push(
      expected === "reverted"
        ? "The schema is still fully migrated: the rollback did not take effect."
        : "The schema is fully reverted: the migration is not applied.",
    );
  }

  if (state === "reverted" && ledger === "failed") {
    guidance.push(`Schema is clean but Prisma still blocks deploys on the failed record. Run: ${resolve("--rolled-back")}`);
  } else if (state === "applied" && (ledger === "failed" || ledger === "absent" || ledger === "rolled-back")) {
    guidance.push(`Schema is migrated but Prisma's ledger says "${ledger}". After confirming, run: ${resolve("--applied")}`);
  } else if (state === "reverted" && ledger === "applied") {
    guidance.push("Schema is reverted but Prisma's ledger still records the migration as applied; the next deploy would skip it.");
  }

  if (state === "reverted" && (plan.destructive.length > 0 || plan.dataChanges.length > 0)) {
    guidance.push(
      "Schema objects are back, but row data is not verified here. Compare row counts and checksums against the pre-migration dump.",
    );
  }

  const ledgerAgrees =
    ledger === "unknown" ||
    (expected === "reverted" ? ledger !== "applied" && ledger !== "failed" : ledger === "applied");
  return { migrationId: plan.migrationId, expected, state, ok: state === expected && ledgerAgrees, checks, ledger, guidance };
}

/**
 * Builds a canonical, deterministic key string for a candidate using the
 * supplied {@link DuplicateKey}. Returns null when any canonical field is
 * missing, so incomplete records never collide with complete ones.
 */
export function canonicalKey(
  candidate: DuplicateCandidate,
  key: DuplicateKey = DEFAULT_DUPLICATE_KEY,
): string | null {
  const parts: string[] = [];
  for (const field of key.fields) {
    const raw = candidate.values[field];
    if (raw === null || raw === undefined) return null;
    const normalized = key.normalize(String(raw));
    if (normalized === "") return null;
    parts.push(normalized);
  }
  return parts.join("\u0000");
}

/**
 * Detects duplicates deterministically. Exact matches on the canonical key
 * block submission; near matches (same key fields but differing only by
 * punctuation or a single edit) enter review. False positives are avoided by
 * requiring every canonical field to be present and non-empty.
 */
export function detectDuplicates(
  candidates: DuplicateCandidate[],
  existing: DuplicateCandidate[],
  key: DuplicateKey = DEFAULT_DUPLICATE_KEY,
): DuplicateReport {
  const blocking: DuplicateMatch[] = [];
  const review: DuplicateMatch[] = [];
  const clean: DuplicateMatch[] = [];

  const existingByKey = new Map<string, DuplicateCandidate>();
  for (const record of existing) {
    const k = canonicalKey(record, key);
    if (k !== null && !existingByKey.has(k)) existingByKey.set(k, record);
  }

  for (const candidate of candidates) {
    const k = canonicalKey(candidate, key);
    if (k === null) {
      clean.push({
        candidate,
        existing: null,
        severity: "none",
        reason: "canonical fields incomplete; skipped duplicate check",
        matchedFields: [],
      });
      continue;
    }

    const exact = existingByKey.get(k);
    if (exact) {
      blocking.push({
        candidate,
        existing: exact,
        severity: "exact",
        reason: `exact duplicate on ${key.fields.join(", ")}`,
        matchedFields: key.fields,
      });
      continue;
    }

    const near = findNearDuplicate(candidate, existing, key);
    if (near) {
      review.push({
        candidate,
        existing: near.record,
        severity: "near",
        reason: near.reason,
        matchedFields: near.matchedFields,
      });
      continue;
    }

    clean.push({
      candidate,
      existing: null,
      severity: "none",
      reason: "no duplicate found",
      matchedFields: [],
    });
  }

  return {
    blocking,
    review,
    clean,
    ok: blocking.length === 0,
  };
}

function findNearDuplicate(
  candidate: DuplicateCandidate,
  existing: DuplicateCandidate[],
  key: DuplicateKey,
): { record: DuplicateCandidate; reason: string; matchedFields: string[] } | null {
  const candidateParts = key.fields.map((f) => key.normalize(String(candidate.values[f] ?? "")));
  for (const record of existing) {
    const recordParts = key.fields.map((f) => key.normalize(String(record.values[f] ?? "")));
    const matchedFields: string[] = [];
    let allClose = true;
    for (let i = 0; i < key.fields.length; i++) {
      const field = key.fields[i];
      const candidatePart = candidateParts[i];
      const existingPart = recordParts[i];
      if (field === undefined || candidatePart === undefined || existingPart === undefined) {
        allClose = false;
        break;
      }
      if (candidatePart === existingPart) {
        matchedFields.push(field);
        continue;
      }
      if (isNearMatch(candidatePart, existingPart)) {
        matchedFields.push(field);
        continue;
      }
      allClose = false;
      break;
    }
    if (allClose && matchedFields.length === key.fields.length) {
      return {
        record,
        reason: `near duplicate on ${key.fields.join(", ")} (edit distance <= 1)`,
        matchedFields,
      };
    }
  }
  return null;
}

function isNearMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let edits = 0;
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    edits++;
    if (edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  if (i < a.length || j < b.length) edits++;
  return edits <= 1;
}

/**
 * Applies a maintainer's review decision to a duplicate report. Allowed
 * near-duplicates are removed from the review queue; rejected ones are moved
 * to blocking so the submission is refused.
 */
export function resolveDuplicateReview(
  report: DuplicateReport,
  resolution: DuplicateReviewResolution,
): DuplicateReport {
  const review = report.review.filter((m) => m.candidate.id !== resolution.candidateId);
  const blocking = [...report.blocking];
  if (resolution.decision === "reject") {
    const rejected = report.review.find((m) => m.candidate.id === resolution.candidateId);
    if (rejected) {
      blocking.push({
        ...rejected,
        severity: "exact",
        reason: `rejected by ${resolution.reviewer}: ${resolution.note ?? "maintainer review"}`,
      });
    }
  }
  return {
    blocking,
    review,
    clean: report.clean,
    ok: blocking.length === 0,
  };
}

export function formatPreview(preview: MigrationPreview): string {
  const lines: string[] = [];
  lines.push(`Migration preview: ${preview.plan.migrationId}`);
  lines.push("=========================================");
  lines.push(`Statements parsed: ${preview.plan.actions.length}`);
  lines.push(`Would create:      ${preview.wouldCreate.length}`);
  lines.push(`Already present:   ${preview.alreadyPresent.length}`);
  lines.push(`Destructive:       ${preview.wouldRunDestructive.length}`);
  lines.push("");

  if (preview.wouldCreate.length > 0) {
    lines.push("Would create:");
    for (const name of preview.wouldCreate) lines.push(`  + ${name}`);
    lines.push("");
  }

  if (preview.wouldRunDestructive.length > 0) {
    lines.push("Destructive statements (review before applying):");
    for (const action of preview.wouldRunDestructive) lines.push(`  - ${action.name}`);
    lines.push("");
  }

  if (preview.affectedRecords.length > 0) {
    lines.push("Affected records:");
    for (const record of preview.affectedRecords) {
      const total = record.rowCount === null ? "unknown" : String(record.rowCount);
      const matching =
        record.matchingRows === null ? "subset (WHERE clause)" : String(record.matchingRows);
      lines.push(`  ~ ${record.table}: ${total} row(s) total, ${matching} affected`);
    }
    lines.push("");
  }

  lines.push("Rollback / forward-fix notes:");
  for (const note of preview.rollbackNotes) lines.push(`  - ${note}`);
  return lines.join("\n");
}

export function formatPostChecks(report: PostCheckReport): string {
  const lines: string[] = [];
  lines.push("Post-migration checks");
  lines.push("======================");
  for (const check of report.checks) {
    lines.push(`  ${check.ok ? "PASS" : "FAIL"}  ${check.name} — ${check.detail}`);
  }
  lines.push("");
  lines.push(report.ok ? "All post-checks passed." : `${report.failures.length} post-check(s) failed.`);
  return lines.join("\n");
}

export function formatRollbackReport(report: RollbackReport): string {
  const lines: string[] = [];
  lines.push(`Rollback verification: ${report.migrationId}`);
  lines.push("=========================================");
  lines.push(`Expected: ${report.expected}`);
  lines.push(`Observed: ${report.state}`);
  lines.push(`Prisma ledger: ${report.ledger}`);
  lines.push("");
  for (const check of report.checks) {
    lines.push(`  ${check.signal.toUpperCase().padEnd(9)} ${check.name} - ${check.detail}`);
  }
  if (report.guidance.length > 0) {
    lines.push("", "Guidance:");
    for (const note of report.guidance) lines.push(`  - ${note}`);
  }
  lines.push("", report.ok ? `Rollback verified: schema is ${report.expected}.` : "Rollback verification FAILED.");
  return lines.join("\n");
}

export function formatDuplicateReport(report: DuplicateReport): string {
  const lines: string[] = [];
  lines.push("Duplicate detection report");
  lines.push("==========================");
  lines.push(`Blocking (exact): ${report.blocking.length}`);
  lines.push(`Review (near):    ${report.review.length}`);
  lines.push(`Clean:            ${report.clean.length}`);
  lines.push("");

  if (report.blocking.length > 0) {
    lines.push("Blocking duplicates:");
    for (const match of report.blocking) {
      lines.push(`  ! ${match.candidate.id} — ${match.reason}`);
    }
    lines.push("");
  }

  if (report.review.length > 0) {
    lines.push("Ambiguous duplicates (maintainer review required):");
    for (const match of report.review) {
      lines.push(`  ? ${match.candidate.id} — ${match.reason}`);
    }
    lines.push("");
  }

  lines.push(
    report.ok
      ? "No blocking duplicates; safe to proceed."
      : `${report.blocking.length} blocking duplicate(s) must be resolved.`,
  );
  return lines.join("\n");
}
