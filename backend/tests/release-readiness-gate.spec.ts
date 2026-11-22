import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
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
  validateEvidence(evidence: unknown): GateReport;
  formatReport(report: GateReport): string;
  writeEvidence(outputPath: string, env: Record<string, string>): unknown;
  main(args: string[]): number;
};
const rollback = require("../../scripts/rehearse-release-rollback.cjs") as {
  parseSafeDatabaseUrls(sourceUrl: string, restoreUrl: string): {
    sourceUrl: string;
    restoreUrl: string;
  };
};

interface ReleaseEvidence {
  schemaVersion: number;
  commit: string;
  runUrl: string;
  checks: Record<string, { status: string; evidence: string }>;
}

function completeEvidence(): ReleaseEvidence {
  return {
    schemaVersion: 1,
    commit: "a".repeat(40),
    runUrl: "https://github.com/example/vaultquest/actions/runs/123",
    checks: {
      migration: { status: "passed", evidence: "Migrate deploy and post-checks passed" },
      security: { status: "passed", evidence: "Audit and secret scan passed" },
      smoke: { status: "passed", evidence: "Backend smoke tests passed" },
      rollback: { status: "passed", evidence: "Database backup restore verified" },
    },
  };
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
    evidence.schemaVersion = 2;
    evidence.commit = "not-a-commit";
    evidence.runUrl = "https://example.invalid";
    const rollbackCheck = evidence.checks.rollback;
    if (!rollbackCheck) throw new Error("Rollback check fixture is missing.");
    rollbackCheck.evidence = "  ";

    const report = gate.validateEvidence(evidence);

    expect(report.ok).toBe(false);
    expect(report.errors).toEqual(expect.arrayContaining([
      "schemaVersion must be 1.",
      "commit must be a 40-character Git commit SHA.",
      "runUrl must identify the GitHub Actions run that produced this evidence.",
      "rollback check is missing its verification evidence.",
    ]));
  });

  it("writes provenance-bound evidence and accepts it through the CLI validator", () => {
    const directory = mkdtempSync(join(tmpdir(), "vaultquest-release-gate-test-"));
    const evidencePath = join(directory, "evidence.json");
    try {
      const evidence = gate.writeEvidence(evidencePath, {
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
    expect(workflow).toContain("rehearse-release-rollback.cjs");
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
