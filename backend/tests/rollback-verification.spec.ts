import { describe, it, expect } from "vitest";
import {
  parseMigrationSql,
  verifyRollback,
  readMigrationLedger,
  formatRollbackReport,
  type LedgerStatus,
  type MigrationDatabase,
} from "../src/scripts/migrationSafety";

/**
 * Rollback verification (#1000): after a failed or reverted migration, the
 * schema must be fully reverted (or fully applied), never half-way, and
 * Prisma's migration ledger must agree with it.
 */
interface FakeState {
  tables: string[];
  indexes: string[];
  columns: string[];
  ledger: LedgerStatus;
  /** Substring of a query that should fail, to simulate an unreachable database. */
  failOn?: string;
}

function fakeDb(state: FakeState): MigrationDatabase {
  return {
    async query(text: string, params: unknown[] = []) {
      if (state.failOn && text.includes(state.failOn)) throw new Error("simulated failure");
      if (text.includes("_prisma_migrations")) {
        if (state.ledger === "absent") return { rows: [] };
        return {
          rows: [
            {
              finished_at: state.ledger === "applied" ? new Date() : null,
              rolled_back_at: state.ledger === "rolled-back" ? new Date() : null,
            },
          ],
        };
      }
      if (text.includes("pg_class")) {
        const [name, kinds] = params as [string, string[]];
        const set = kinds.includes("r") ? state.tables : state.indexes;
        return { rows: set.includes(name) ? [{ one: 1 }] : [] };
      }
      if (text.includes("information_schema.columns")) {
        const [table, column] = params as [string, string];
        return { rows: state.columns.includes(`${table}.${column}`) ? [{ one: 1 }] : [] };
      }
      return { rows: [] };
    },
  };
}

const PLAN = parseMigrationSql(
  "20261017000000_example",
  `
  CREATE TABLE "widgets" ("id" TEXT NOT NULL);
  CREATE INDEX "widgets_id_idx" ON "widgets" ("id");
  ALTER TABLE "orders" ADD COLUMN "widget_id" TEXT;
  ALTER TABLE "orders" DROP COLUMN "legacy_note";
  `,
);

const APPLIED: FakeState = {
  tables: ["widgets"],
  indexes: ["widgets_id_idx"],
  columns: ["orders.widget_id"],
  ledger: "applied",
};
const REVERTED: FakeState = {
  tables: [],
  indexes: [],
  columns: ["orders.legacy_note"],
  ledger: "rolled-back",
};

describe("verifyRollback (#1000)", () => {
  it("verifies a clean rollback", async () => {
    const report = await verifyRollback(fakeDb(REVERTED), PLAN);
    expect(report.state).toBe("reverted");
    expect(report.ok).toBe(true);
    expect(report.checks.every((c) => c.signal === "reverted")).toBe(true);
  });

  it("fails when the rollback did not take effect", async () => {
    const report = await verifyRollback(fakeDb(APPLIED), PLAN);
    expect(report.state).toBe("applied");
    expect(report.ok).toBe(false);
    expect(report.guidance.join(" ")).toContain("rollback did not take effect");
  });

  it("verifies a fully applied migration when applied is expected", async () => {
    const report = await verifyRollback(fakeDb(APPLIED), PLAN, "applied");
    expect(report.ok).toBe(true);
  });

  it("detects a partial migration and names both halves", async () => {
    const partial: FakeState = { ...APPLIED, indexes: [], columns: ["orders.widget_id"], ledger: "failed" };
    const report = await verifyRollback(fakeDb(partial), PLAN);
    expect(report.state).toBe("partial");
    expect(report.ok).toBe(false);
    const text = report.guidance.join(" ");
    expect(text).toContain("table widgets");
    expect(text).toContain("index widgets_id_idx");
  });

  it("treats a dropped object that is still present as evidence of a revert", async () => {
    const state: FakeState = { ...REVERTED, columns: ["orders.legacy_note"] };
    const report = await verifyRollback(fakeDb(state), PLAN);
    const dropped = report.checks.find((c) => c.name === "column orders.legacy_note");
    expect(dropped).toMatchObject({ present: true, signal: "reverted" });
  });

  it("ignores absence of an object dropped with IF EXISTS", async () => {
    const plan = parseMigrationSql("x", 'DROP TABLE IF EXISTS "old_widgets";');
    const report = await verifyRollback(fakeDb({ ...REVERTED, columns: [] }), plan);
    expect(report.checks[0].signal).toBe("ambiguous");
    expect(report.state).toBe("unverifiable");
    expect(report.ok).toBe(false);
  });

  it("lets the last statement win when a migration creates then drops an object", async () => {
    const plan = parseMigrationSql("x", 'CREATE TABLE "t" ("id" TEXT);\nDROP TABLE "t";');
    const absent = await verifyRollback(fakeDb({ ...REVERTED, columns: [] }), plan, "applied");
    expect(absent.state).toBe("applied");
  });

  it("is unverifiable when a probe cannot run", async () => {
    const report = await verifyRollback(fakeDb({ ...REVERTED, failOn: "pg_class" }), PLAN);
    expect(report.state).toBe("unverifiable");
    expect(report.ok).toBe(false);
  });

  it("is unverifiable for a data-only migration", async () => {
    const plan = parseMigrationSql("x", 'UPDATE "users" SET "tier" = \'free\';');
    const report = await verifyRollback(fakeDb(REVERTED), plan);
    expect(report.checks).toHaveLength(0);
    expect(report.state).toBe("unverifiable");
  });

  it("tells the operator to resolve a failed ledger record once the schema is clean", async () => {
    const report = await verifyRollback(fakeDb({ ...REVERTED, ledger: "failed" }), PLAN);
    expect(report.state).toBe("reverted");
    expect(report.ok).toBe(false);
    expect(report.guidance.join(" ")).toContain("prisma migrate resolve --rolled-back 20261017000000_example");
  });

  it("flags a ledger that still records a reverted migration as applied", async () => {
    const report = await verifyRollback(fakeDb({ ...REVERTED, ledger: "applied" }), PLAN);
    expect(report.ok).toBe(false);
    expect(report.guidance.join(" ")).toContain("ledger still records the migration as applied");
  });

  it("points at the ledger when the schema is applied but Prisma disagrees", async () => {
    const report = await verifyRollback(fakeDb({ ...APPLIED, ledger: "failed" }), PLAN, "applied");
    expect(report.ok).toBe(false);
    expect(report.guidance.join(" ")).toContain("prisma migrate resolve --applied");
  });

  it("warns that row data is not verified after reverting destructive changes", async () => {
    const report = await verifyRollback(fakeDb(REVERTED), PLAN);
    expect(report.guidance.join(" ")).toContain("row data is not verified");
  });

  it("does not require ledger access to classify the schema", async () => {
    const report = await verifyRollback(fakeDb({ ...REVERTED, failOn: "_prisma_migrations" }), PLAN);
    expect(report.ledger).toBe("unknown");
    expect(report.state).toBe("reverted");
    expect(report.ok).toBe(true);
  });

  it("formats a readable report", async () => {
    const text = formatRollbackReport(await verifyRollback(fakeDb(APPLIED), PLAN));
    expect(text).toContain("Expected: reverted");
    expect(text).toContain("Observed: applied");
    expect(text).toContain("Rollback verification FAILED.");
  });
});

describe("readMigrationLedger (#1000)", () => {
  it.each(["applied", "failed", "rolled-back", "absent"] as const)("reads %s", async (ledger) => {
    const db = fakeDb({ tables: [], indexes: [], columns: [], ledger });
    expect(await readMigrationLedger(db, "x")).toBe(ledger);
  });
});
