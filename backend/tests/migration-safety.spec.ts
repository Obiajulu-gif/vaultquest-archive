import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  parseMigrationSql,
  previewMigration,
  runPostChecks,
  rollbackNotes,
  formatPreview,
  formatPostChecks,
  listMigrationIds,
  readMigrationPlan,
  type MigrationDatabase,
} from "../src/scripts/migrationSafety.js";

/**
 * Migration safety framework (#790): preview before writes, post-checks that
 * detect an incomplete rollout, and rollback/forward-fix guidance.
 *
 * The plan is built from the repository's real migrations where possible, and
 * from inline SQL for the specific shapes the framework must recognise.
 */
const MIGRATIONS_DIR = path.join(__dirname, "../prisma/migrations");

interface FakeState {
  tables: Set<string>;
  indexes: Set<string>;
  columns: Set<string>;
  rowCounts: Record<string, number>;
  nullCounts: Record<string, number>;
  failOn: string;
}

function fakeDb(state: FakeState): MigrationDatabase {
  return {
    async query(text: string, params: unknown[] = []) {
      if (state.failOn && text.includes(state.failOn)) {
        throw new Error(`simulated failure: ${state.failOn}`);
      }
      if (text.includes("pg_class")) {
        const [name, kinds] = params as [string, string[]];
        const wantsTable = kinds.includes("r");
        const exists = wantsTable ? state.tables.has(name) : state.indexes.has(name);
        return { rows: exists ? [{ "?column": 1 }] : [] };
      }
      if (text.includes("information_schema.columns")) {
        const [table, column] = params as [string, string];
        return { rows: state.columns.has(`${table}.${column}`) ? [{ "?column": 1 }] : [] };
      }
      if (text.includes("IS NULL")) {
        const table = /FROM "([^"]+)"/.exec(text)?.[1] ?? "";
        return { rows: [{ count: state.nullCounts[table] ?? 0 }] };
      }
      if (text.includes("COUNT(*)::int AS count FROM")) {
        const table = /FROM "([^"]+)"/.exec(text)?.[1] ?? "";
        return { rows: [{ count: state.rowCounts[table] ?? 0 }] };
      }
      return { rows: [] };
    },
  };
}

function emptyState(): FakeState {
  return {
    tables: new Set(),
    indexes: new Set(),
    columns: new Set(),
    rowCounts: {},
    nullCounts: {},
    failOn: "",
  };
}

describe("migration planning (#790)", () => {
  it("parses every statement form used by the repository's migrations", () => {
    const sql = `
      -- a comment that must be ignored
      CREATE TABLE IF NOT EXISTS "widgets" ("id" TEXT NOT NULL);
      ALTER TABLE "widgets" ADD COLUMN IF NOT EXISTS "owner" TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS "widgets_owner_idx" ON "widgets" ("owner");
      UPDATE "widgets" SET "owner" = 'unknown' WHERE "owner" IS NULL;
      ALTER TABLE .widgets" ALTER COLUMN "owner" SET NOT NULL;
      ALTER TABLE .widgets" DROP COLUMN IF EXISTS "legacy";
      DROP TABLE IF EXISTS "old_widgets" CASCADE;
      DROP INDEX IF EXISTS "widgets_stale_idx";
    `;
    const plan = parseMigrationSql("20260927_test", sql);
    const kinds = plan.actions.map((a) => a.kind);

    expect(kinds).toEqual([
      "create-table",
      "add-column",
      "create-index",
      "data-update",
      "alter-column",
      "drop-column",
      "drop-table",
      "drop-index",
    ]);
    expect(plan.isEmpty).toBe(false);
  });

  it("parses the real change-history migration added for #787", () => {
    const plan = readMigrationPlan(MIGRATIONS_DIR, "20260927000000_add_record_change_history");
    const table = plan.actions.find((a) => a.kind === "create-table");

    expect(table?.name).toBe("record_change_history");
    expect(plan.creates.length).toBeGreaterThanOrEqual(1);
    expect(plan.destructive).toHaveLength(0);
  });

  it("parses every migration folder in the repository without throwing", () => {
    const ids = listMigrationIds(MIGRATIONS_DIR);
    expect(ids.length).toBeGreaterThan(10);
    for (const id of ids) {
      expect(() => readMigrationPlan(MIGRATIONS_DIR, id)).not.toThrow();
    }
  });

  it("flags a backfill with no WHERE clause as rewriting every row", () => {
    const plan = parseMigrationSql("x", 'UPDATE "users" SET "tier" = \'free\';');
    expect(plan.dataChanges).toMatchObject([{ rewritesAllRows: true }]);
  });

  it("does not flag a targeted backfill as a full rewrite", () => {
    const plan = parseMigrationSql("x", 'UPDATE "users" SET "tier" = \'free\' WHERE "tier" IS NULL;');
    expect(plan.dataChanges).toMatchObject([{ rewritesAllRows: false }]);
  });

  it("treats an unrecognised statement as other rather than guessing", () => {
    const plan = parseMigrationSql("x", "VACUUM ANALYZE;");
    expect(plan.actions).toMatchObject([{ kind: "other" }]);
  });
});

describe("preview before writes (#790)", () => {
  let state: FakeState;

  beforeEach(() => {
    state = emptyState();
  });

  const plan = parseMigrationSql(
    "20260927_preview",
    `
      CREATE TABLE IF NOT EXISTS "vault_notes" ("id" TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS "vault_notes_idx" ON "vault_notes" ("id");
      ALTER TABLE "action_ledger" ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 0;
      UPDATE "action_ledger" SET "version" = 1 WHERE "version" IS NULL;
    `,
  );

  it("reports what would be created on an empty database", async () => {
    const preview = await previewMigration(plan, fakeDb(state));

    expect(preview.wouldCreate).toEqual(
      expect.arrayContaining(["vault_notes", "vault_notes_idx", "action_ledger.version"]),
    );
    expect(preview.noop).toBe(false);
  });

  it("reports affected records before any write", async () => {
    state.rowCounts.action_ledger = 5_000;
    const preview = await previewMigration(plan, fakeDb(state));

    const affected = preview.affectedRecords.find((r) => r.table === "action_ledger");
    expect(affected?.rowCount).toBe(5_000);
    // The statement has a WHERQE clause, so only a subset is rewritten.
    expect(affected?.matchingRows).toBe(null);
  });

  it("skips objects that already exist and detects a no-op", async () => {
    state.tables.add("vault_notes");
    state.indexes.add("vault_notes_idx");
    state.columns.add("action_ledger.version");

    const preview = await previewMigration(plan, fakeDb(state));
    expect(preview.alreadyPresent).toHaveLength(3);
    expect(preview.wouldCreate).toHaveLength(0);
  });

  it("reports 'unknown' rather than a false zero when a count is unavailable", async () => {
    state.failOn = "COUNT(*)";
    const preview = await previewMigration(plan, fakeDb(state));

    expect(preview.affectedRecords.every((r) => r.rowCount === null)).toBe(true);
  });

  it("only lists destructive statements whose object still exists", async () => {
    const dropPlan = parseMigrationSql(
      "20260927_drop",
      'ALTER TABLE "action_ledger" DROP COLUMN IF EXISTS "legacy"; DROP TABLE IF EXISTS "gone" CASCADE;',
    );

    state.columns.add("action_ledger.legacy");
    const preview = await previewMigration(dropPlan, fakeDb(state));

    // "gone" is already absent, so only the column drop is reported.
    expect(preview.wouldRunDestructive.map((a) => a.name)).toEqual(["action_ledger.legacy"]);
  });

  it("prints rollback guidance", async () => {
    const notes = rollbackNotes(plan);
    expect(notes.some((n) => /pre-migration pg_dump/.test(n))).toBe(true);
    expect(formatPreview(await previewMigration(plan, fakeDb(state)))).toContain("Rollback");
  });
});

describe("post-checks — successful migration (#790)", () => {
  let state: FakeState;

  const plan = parseMigrationSql(
    "20260927_post",
    `
      CREATE TABLE IF NOT EXISTS "pools" ("id" TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS "pools_idx" ON "pools" ("id");
      ALTER TABLE "action_ledger" ADD COLUMN IF NOT EXISTS "version" INTEGER;
    `,
  );

  beforeEach(() => {
    state = emptyState();
    state.tables.add("pools");
    state.indexes.add("pools_idx");
    state.columns.add("action_ledger.version");
  });

  it("passes when every planned object exists", async () => {
    const report = await runPostChecks(fakeDb(state), plan);

    expect(report.ok).toBe(true);
    expect(report.failures).toHaveLength(0);
    expect(report.checks.length).toBeGreaterThanOrEqual(3);
    expect(formatPostChecks(report)).toContain("All post-checks passed.");
  });
});

describe("post-checks — failed / partial migration (#790)", () => {
  let state: FakeState;

  const plan = parseMigrationSql(
    "20260927_post",
    `
      CREATE TABLE IF NOT EXISTS "pools" ("id" TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS "pools_idx" ON "pools" ("id");
      ALTER TABLE "action_ledger" ADD COLUMN IF NOT EXISTS "version" INTEGER;
      ALTER TABLE "action_ledger" ALTER COLUMN "version" SET NOT NULL;
    `,
  );

  beforeEach(() => {
    state = emptyState();
  });

  it("detects a table that never landed", async () => {
    state.indexes.add("pools_idx");
    state.columns.add("action_ledger.version");

    const report = await runPostChecks(fakeDb(state), plan);
    expect(report.ok).toBe(false);
    expect(report.failures.map((f) => f.name)).toContain("table pools exists");
  });

  it("detects an index that silently did not get created", async () => {
    state.tables.add("pools");
    state.columns.add("action_ledger.version");

    const report = await runPostChecks(fakeDb(state), plan);
    expect(report.failures.map((f) => f.name)).toContain("index pools_idx exists");
  });

  it("detects a column the migration was supposed to add", async () => {
    state.tables.add("pools");
    state.indexes.add("pools_idx");

    const report = await runPostChecks(fakeDb(state), plan);
    expect(report.failures.map((f) => f.name)).toContain("column action_ledger.version exists");
  });

  it("detects NULL rows left behind by an incomplete backfill", async () => {
    state.tables.add("pools");
    state.indexes.add("pools_idx");
    state.columns.add("action_ledger.version");
    state.nullCounts.action_ledger = 17;

    const report = await runPostChecks(fakeDb(state), plan);
    const failure = report.failures.find((c) => c.name.includes("no NULL rows"));
    expect(failure).toBeTruthy();
    expect(failure?.detail).toContain("17");
  });

  it("confirms a satisfied NOT NULL constraint", async () => {
    state.tables.add("pools");
    state.indexes.add("pools_idx");
    state.columns.add("action_ledger.version");
    state.nullCounts.action_ledger = 0;

    const report = await runPostChecks(fakeDb(state), plan);
    expect(report.ok).toBe(true);
  });

  it("flags a check it could not run as a failure, not a pass", async () => {
    state.tables.add("pools");
    state.indexes.add("pools_idx");
    state.columns.add("action_ledger.version");
    state.failOn = "IS NULL";

    const report = await runPostChecks(fakeDb(state), plan);
    expect(report.ok).toBe(false);
    expect(report.failures.some((f) => /could not verify/.test(f.detail))).toBe(true);
  });
});

/**
 * Release readiness checklist (#791): high-risk changes must pass a consistent
 * checklist covering tests, migration, config, rollback, and documentation.
 */
describe("release readiness checklist (#791)", () => {
  const ROOT = path.resolve(__dirname, "../..");
  const checklistPath = path.join(ROOT, "docs/release-readiness-checklist.md");
  const validatorPath = path.join(ROOT, "scripts/release-readiness.cjs");

  it("ships a checklist template covering all required areas", () => {
    expect(fs.existsSync(checklistPath)).toBe(true);
    const doc = fs.readFileSync(checklistPath, "utf-8");

    for (const section of [
      "Tests",
      "Migration",
      "Configuration",
      "Rollback",
      "Documentation",
      "Maintainer sign-off",
    ]) {
      expect(doc.toLowerCase()).toContain(section.toLowerCase());
    }
  });

  it("documents exception handling for urgent fixes", () => {
    const doc = fs.readFileSync(checklistPath, "utf-8").toLowerCase();
    expect(doc).toContain("urgent");
    expect(doc).toContain("exception");
    expect(doc).toContain("post-mortem");
  });

  it("provides an automated validator that runs locally and in CI", () => {
    expect(fs.existsSync(validatorPath)).toBe((true));
    const source = fs.readFileSync(validatorPath, "utf-8");
    expect(source).toMatch(/function validateEvidence/);
    expect(source).toMatch(/function formatReport/);
  });
});
