import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(__dirname, "../..");
const require = createRequire(import.meta.url);
interface GateReport {
  ok: boolean;
  errors: string[];
}
const gate = require("../../scripts/release-readiness.cjs") as {
  listReleaseMigrations(dir?: string): string[];
  validateEvidence(evidence: unknown, options?: { expectedMigrations?: string[] }): GateReport;
  formatReport(report: GateReport): string;
  writeEvidence(outputPath: string, env: Record<string, string>): unknown;
  main(args: string[]): number;
};
interface RecoveryEvidence {
  rehearsedAt: string;
  archiveSha256: string;
  migrations: string[];
  tables: number;
}
type Runner = (command: string, args: string[], label: string) => string;
const rollback = require("../../scripts/rehearse-release-rollback.cjs") as {
  parseSafeDatabaseUrls(sourceUrl: string, restoreUrl: string): {
    sourceUrl: string;
    restoreUrl: string;
  };
  rehearse(env: Record<string, string>, runner?: Runner): RecoveryEvidence;
  main(args: string[], env: Record<string, string>): number;
};

interface ReleaseEvidence {
  schemaVersion: number;
  commit: string;
  runUrl: string;
  checks: Record<string, { status: string; evidence: string; recovery?: Partial<RecoveryEvidence> }>;
}

const RELEASE_MIGRATIONS = gate.listReleaseMigrations();

function completeEvidence(): ReleaseEvidence {
  return {
    schemaVersion: 2,
    commit: "a".repeat(40),
    runUrl: "https://github.com/example/vaultquest/actions/runs/123",
    checks: {
      migration: { status: "passed", evidence: "Migrate deploy and post-checks passed" },
      security: { status: "passed", evidence: "Audit and secret scan passed" },
      smoke: { status: "passed", evidence: "Backend smoke tests passed" },
      rollback: {
        status: "passed",
        evidence: "Database backup restore verified",
        recovery: { archiveSha256: "c".repeat(64), migrations: [...RELEASE_MIGRATIONS], tables: 40 },
      },
    },
  };
}

const ENV = {
  RELEASE_TEST_DATABASE_URL: "postgresql://postgres:pw@localhost:5432/vaultquest_release_test",
  RELEASE_ROLLBACK_DATABASE_URL: "postgresql://postgres:pw@localhost:5432/vaultquest_rollback_test",
};

/** Stands in for psql/pg_dump/pg_restore against a two-table database. */
function fakePostgres(overrides: { restoreObjects?: string; restoredCount?: string } = {}) {
  const calls: string[] = [];
  const runner: Runner = (command, args) => {
    calls.push(command);
    if (command === "pg_dump") {
      writeFileSync(args[args.indexOf("--file") + 1]!, "PGDMP fake archive");
      return "";
    }
    if (command === "pg_restore") return "";
    const [url, sql] = [args[0]!, args.at(-1)!];
    const restore = url === ENV.RELEASE_ROLLBACK_DATABASE_URL;
    if (sql.includes("pg_class")) return overrides.restoreObjects ?? "0";
    if (sql.startsWith("DROP SCHEMA")) return "";
    if (sql.includes("_prisma_migrations")) return "20260101000000_init\n20260927000001_add_feature_flags\n";
    if (sql.includes("pg_tables")) return "feature_flags\nusers\n";
    if (sql.includes("COUNT(*)")) return restore ? overrides.restoredCount ?? "3" : "3";
    throw new Error(`unexpected SQL: ${sql}`);
  };
  return { runner, calls };
}

describe("release readiness evidence gate", () => {
  it("accepts complete evidence and provides an operator-readable pass result", () => {
    const report = gate.validateEvidence(completeEvidence());

    expect(report).toEqual({ ok: true, errors: [] });
    expect(gate.formatReport(report)).toContain("migration, security, smoke, and rollback");
  });

  it.each(["migration", "security", "smoke", "rollback"])(
    "blocks release when the %s result is missing or not passing",
    (requiredCheck) => {
      const evidence = completeEvidence();
      const check = evidence.checks[requiredCheck];
      if (!check) throw new Error(`Unknown test check: ${requiredCheck}`);
      check.status = "failed";

      const report = gate.validateEvidence(evidence);

      expect(report.ok).toBe(false);
      expect(report.errors.join("\n")).toContain(`${requiredCheck} check is missing or did not pass`);
      expect(gate.formatReport(report)).toContain("Release readiness gate failed");
    },
  );

  it("blocks missing evidence, malformed provenance, and unsupported schema versions", () => {
    const evidence = completeEvidence();
    evidence.schemaVersion = 1; // pre-#1136 evidence has no recovery section
    evidence.commit = "not-a-commit";
    evidence.runUrl = "https://example.invalid";
    const rollbackCheck = evidence.checks.rollback;
    if (!rollbackCheck) throw new Error("Rollback check fixture is missing.");
    rollbackCheck.evidence = "  ";

    const report = gate.validateEvidence(evidence);

    expect(report.ok).toBe(false);
    expect(report.errors).toEqual(expect.arrayContaining([
      "schemaVersion must be 2.",
      "commit must be a 40-character Git commit SHA.",
      "runUrl must identify the GitHub Actions run that produced this evidence.",
      "rollback check is missing its verification evidence.",
    ]));
  });

  it("writes provenance-bound evidence and accepts it through the CLI validator", () => {
    const directory = mkdtempSync(join(tmpdir(), "vaultquest-release-gate-test-"));
    const evidencePath = join(directory, "evidence.json");
    const recoveryPath = join(directory, "recovery-evidence.json");
    writeFileSync(recoveryPath, JSON.stringify(completeEvidence().checks.rollback!.recovery));
    try {
      const evidence = gate.writeEvidence(evidencePath, {
        RECOVERY_EVIDENCE_PATH: recoveryPath,
        GITHUB_SHA: "b".repeat(40),
        GITHUB_REPOSITORY: "example/vaultquest",
        GITHUB_RUN_ID: "456",
        MIGRATION_CHECK_RESULT: "passed",
        MIGRATION_CHECK_EVIDENCE: "migration checks",
        SECURITY_CHECK_RESULT: "passed",
        SECURITY_CHECK_EVIDENCE: "security checks",
        SMOKE_CHECK_RESULT: "passed",
        SMOKE_CHECK_EVIDENCE: "smoke checks",
        ROLLBACK_CHECK_RESULT: "passed",
        ROLLBACK_CHECK_EVIDENCE: "restore rehearsal",
      });

      expect(gate.validateEvidence(evidence).ok).toBe(true);
      expect(gate.main(["--evidence", evidencePath])).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("blocks a release whose recovery evidence is missing or malformed", () => {
    const missing = completeEvidence();
    delete missing.checks.rollback!.recovery;
    expect(gate.validateEvidence(missing).errors).toContain("rollback check is missing its recovery evidence.");

    const malformed = completeEvidence();
    malformed.checks.rollback!.recovery = { archiveSha256: "nope", tables: 0, migrations: [] };
    expect(gate.validateEvidence(malformed).errors).toEqual(expect.arrayContaining([
      "recovery evidence must include the backup archive SHA-256.",
      "recovery evidence must report at least one verified table.",
      "recovery evidence must list the restored migrations.",
    ]));
  });

  it("blocks a release when the restore did not cover a migration shipped in it", () => {
    const evidence = completeEvidence();
    const report = gate.validateEvidence(evidence, { expectedMigrations: [...RELEASE_MIGRATIONS, "29990101000000_next"] });
    expect(report.ok).toBe(false);
    expect(report.errors).toEqual(["recovery evidence does not cover release migration(s): 29990101000000_next."]);
    expect(RELEASE_MIGRATIONS.length).toBeGreaterThan(0); // the default list is read from backend/prisma/migrations
  });

  it("fails closed when the recovery evidence file the workflow names is missing", () => {
    const directory = mkdtempSync(join(tmpdir(), "vaultquest-release-gate-test-"));
    try {
      expect(() => gate.writeEvidence(join(directory, "evidence.json"), { RECOVERY_EVIDENCE_PATH: join(directory, "absent.json") }))
        .toThrow(/ENOENT/);
      expect(gate.validateEvidence(gate.writeEvidence(join(directory, "no-recovery.json"), {})).errors)
        .toContain("rollback check is missing its recovery evidence.");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rehearses backup and restore and returns recovery evidence the gate accepts", () => {
    const { runner, calls } = fakePostgres();
    const recovery = rollback.rehearse(ENV, runner);

    expect(recovery).toEqual({
      rehearsedAt: expect.any(String),
      archiveSha256: createHash("sha256").update("PGDMP fake archive").digest("hex"),
      migrations: ["20260101000000_init", "20260927000001_add_feature_flags"],
      tables: 2,
    });
    expect(calls.filter((c) => c !== "psql")).toEqual(["pg_dump", "pg_restore", "pg_restore"]);
    const evidence = completeEvidence();
    evidence.checks.rollback!.recovery = recovery;
    expect(gate.validateEvidence(evidence, { expectedMigrations: recovery.migrations }).ok).toBe(true);
  });

  it("refuses to restore over a non-empty target and fails on a row-count mismatch", () => {
    const occupied = fakePostgres({ restoreObjects: "12" });
    expect(() => rollback.rehearse(ENV, occupied.runner)).toThrow(/not empty; refusing/);
    expect(occupied.calls).not.toContain("pg_dump");

    expect(() => rollback.rehearse(ENV, fakePostgres({ restoredCount: "2" }).runner))
      .toThrow("Restored row count does not match for feature_flags.");
  });

  it("writes no evidence file when the rehearsal CLI fails", () => {
    const directory = mkdtempSync(join(tmpdir(), "vaultquest-release-gate-test-"));
    const out = join(directory, "recovery-evidence.json");
    try {
      expect(rollback.main(["--evidence-out"], {})).toBe(1);
      expect(rollback.main(["--evidence-out", out], {})).toBe(1); // no database URLs
      expect(existsSync(out)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects production or non-isolated rollback database targets", () => {
    expect(() => rollback.parseSafeDatabaseUrls(
      "postgresql://user:password@db.production.example/vaultquest_test",
      "postgresql://user:password@localhost/vaultquest_rollback_test",
    )).toThrow(/local disposable PostgreSQL hosts/);
    expect(() => rollback.parseSafeDatabaseUrls(
      "postgresql://user:password@localhost/vaultquest_rollback_test",
      "postgresql://user:password@localhost/vaultquest_rollback_test",
    )).toThrow(/different/);
    expect(() => rollback.parseSafeDatabaseUrls(
      "postgresql://user:password@localhost/vaultquest",
      "postgresql://user:password@localhost/vaultquest_rollback_test",
    )).toThrow(/must end in _test/);
    expect(() => rollback.parseSafeDatabaseUrls(
      "postgresql://user:password@localhost/vaultquest_test?hostaddr=203.0.113.10",
      "postgresql://user:password@localhost/vaultquest_rollback_test",
    )).toThrow(/overrides are not permitted/);
    expect(() => rollback.parseSafeDatabaseUrls(
      "https://localhost/vaultquest_test",
      "postgresql://user:password@localhost/vaultquest_rollback_test",
    )).toThrow(/PostgreSQL connection URLs/);
  });

  it("requires the release draft job to depend on every completed gate", () => {
    const workflow = readFileSync(resolve(ROOT, ".github/workflows/release-tagging.yml"), "utf8");
    const auditWorkflow = readFileSync(resolve(ROOT, ".github/workflows/security.yml"), "utf8");

    expect(workflow).toMatch(/release_readiness:[\s\S]*?name: Release readiness gate/);
    expect(workflow).toMatch(/draft_release:\s*\n\s+needs: release_readiness/);
    expect(workflow).toContain("pnpm audit --audit-level=critical");
    expect(workflow).toContain("migrationSafetyCli.ts");
    for (const testFile of [
      "tests/security.spec.ts",
      "tests/smoke.spec.ts",
      "tests/release-readiness-gate.spec.ts",
      "tests/migration-safety.spec.ts",
    ]) {
      expect(workflow).toContain(testFile);
    }
    expect(workflow).toContain("--testNamePattern=");
    expect(workflow).toContain("rehearse-release-rollback.cjs --evidence-out recovery-evidence.json");
    expect(workflow).toContain("RECOVERY_EVIDENCE_PATH: recovery-evidence.json");
    expect(auditWorkflow).toContain("pnpm audit --audit-level=critical");
    expect(auditWorkflow).not.toContain("pnpm audit --audit-level=critical || true");
  });

  it("keeps the pull-request release-gate regression check passing", () => {
    expect(() => execFileSync(
      process.execPath,
      [resolve(ROOT, "scripts/check-release-readiness.js")],
      { cwd: ROOT, stdio: "pipe" },
    )).not.toThrow();
    expect(readFileSync(resolve(ROOT, ".github/pull_request_template.md"), "utf8"))
      .toContain("node scripts/check-release-readiness.js");
  });

  it("documents migration, security, smoke, rollback, and recovery requirements", () => {
    const checklist = readFileSync(resolve(ROOT, "docs/release-readiness-checklist.md"), "utf8");

    for (const section of ["Tests", "Migration", "Security", "Rollback", "Documentation", "Maintainer sign-off"]) {
      expect(checklist.toLowerCase()).toContain(section.toLowerCase());
    }
    expect(checklist.toLowerCase()).toContain("urgent");
    expect(checklist.toLowerCase()).toContain("post-mortem");
  });
});
