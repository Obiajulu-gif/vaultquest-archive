/*
 * Migration safety CLI (#790).
 *
 *   tsx src/scripts/migrationSafety.ts --preview <migration-id>
 *   tsx src/scripts/migrationSafety.ts --check <migration-id> --post-checks
 *   tsx src/scripts/migrationSafety.ts --verify-rollback <migration-id> [--expect reverted|applied]
 *   tsx src/scripts/migrationSafety.ts --list
 *
 * `--preview` issues only SELECTs: it reports what a migration would create,
 * which statements are destructive, and how many records the data-changing
 * statements would touch — before anything is written.
 *
 * `--verify-rollback` classifies the schema after a failed or reverted
 * migration (reverted, applied or partial) and checks Prisma's migration
 * ledger; it fails unless the state matches `--expect` (default reverted).
 *
 * Exit codes:
 *   0 – preview produced, all post-checks passed, or rollback verified
 *   1 – a post-check or rollback verification failed, or the migration could not be read
 */

import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";
import { getPrisma, disconnectPrisma } from "../db.js";
import {
  parseMigrationSql,
  previewMigration,
  runPostChecks,
  verifyRollback,
  formatRollbackReport,
  formatPreview,
  formatPostChecks,
  listMigrationIds,
  type MigrationDatabase,
} from "./migrationSafety.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE,
 "../../prisma/migrations");

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

/**
 * Release readiness checklist coverage for high-risk changes (#790).
 *
 * The migration safety CLI is the automated portion of the release
 * readiness checklist. The checklist itself is documented in
 * docs/release-readiness.md and must be signed off by a maintainer for
 * high-risk changes. This module exposes the canonical checklist items
 * so that CI and local runs can validate that a PR declares them.
 */

export type ReleaseChecklistItemId =
  | "tests"
  | "docs"
  | "migration"
  | "config"
  | "rollback";

export interface ReleaseChecklistItem {
  id: ReleaseChecklistItemId;
  title: string;
  description: string;
  /** Whether this item is automated by the migration safety tooling. */
  automated: boolean;
}

/**
 * The canonical release readiness checklist for high-risk changes.
 *
 * Covers tests, docs, migration, config, and rollback as required by
 * the acceptance criteria. The `migration` item is validated automatically
 * by this CLI via `--preview` and `--check --post-checks`.
 */
export const RELEASE_READINESS_CHECKLIST: readonly ReleaseChecklistItem[] = [
  {
    id: "tests",
    title: "Tests pass locally and in CI",
    description:
      "Unit/integration tests covering the changed vault accounting, prize draw, " +
      "wallet flow, or dashboard code pass. Include the exact command and output.",
    automated: false,
  },
  {
    id: "docs",
    title: "Documentation updated",
    description:
      "Contributor-facing docs, API contracts, and operational runbooks reflect " +
      "the new behavior, setup, or migration steps.",
    automated: false,
  },
  {
    id: "migration",
    title: "Migration preview and post-checks pass",
    description:
      "Run `tsx src/scripts/migrationSafetyCli.ts --preview <id>` and " +
      "`--check <id> --post-checks`. Destructive statements and affected " +
      "row counts are reviewed before applying.",
    automated: true,
  },
  {
    id: "config",
    title: "Configuration changes are documented and defaulted",
    description:
      "New env vars, feature flags, or protocol reporting settings have safe " +
      "defaults, are listed in the PR description, and are added to env examples.",
    automated: false,
  },
  {
    id: "rollback",
    title: "Rollback plan is defined",
    description:
      "The PR describes how to revert the change (code and schema) and what " +
      "data recovery looks like if the migration is destructive.",
    automated: false,
  },
] as const;

export interface ReleaseChecklistStatus {
  id: ReleaseChecklistItemId;
  title: string;
  automated: boolean;
  /** Whether the item has been attested by the PR author/maintainer. */
  attested: boolean;
}

/**
 * Parse a comma-separated list of checklist ids from a `--attest` flag.
 * This lets CI verify that a PR declares the relevant release readiness
 * items without adding a separate config file.
 */
export function parseAttestations(raw: string | undefined): Set<ReleaseChecklistItemId> {
  const attested = new Set<ReleaseChecklistItemId>();
  if (!raw) return attested;
  const valid = new Set(RELEASE_READINESS_CHECKLIST.map((item) => item.id));
  for (const part of raw.split(",")) {
    const id = part.trim() as ReleaseChecklistItemId;
    if (!id) continue;
    if (!valid.has(id)) {
      throw new Error(
        `Unknown release checklist id "${id}". Expected one of ${[...valid].join(", ")}.`,
      );
    }
    attested.add(id);
  }
  return attested;
}

/**
 * Build the checklist status for a release, marking each item as attested
 * or not. The `migration` item is automated and is considered attested
 * only when the caller has confirmed the preview/post-checks ran.
 */
export function buildChecklistStatus(
  attested: Set<ReleaseChecklistItemId>,
  migrationVerified: boolean,
): ReleaseChecklistStatus[] {
  return RELEASE_READINESS_CHECKLIST.map((item) => ({
    id: item.id,
    title: item.title,
    automated: item.automated,
    attested:
      item.id === "migration" ? migrationVerified : attested.has(item.id),
  }));
}

/**
 * Format the checklist for terminal output. Returns the formatted text
 * and whether every item is attested.
 */
export function formatChecklist(statuses: ReleaseChecklistStatus[]): { text: string; ok: boolean } {
  const lines = statuses.map((s) => {
    const mark = s.attested ? "✅" : "❌";
    const auto = s.automated ? " (automated)" : "";
    return `${mark} ${s.title}${auto}`;
  });
  const ok = statuses.every((s) => s.attested);
  const header = ok
    ? "✅ Release readiness checklist complete."
    : "❌ Release readiness checklist incomplete.";
  return { text: [header, ...lines].join("\n"), ok };
}

async function main(): Promise<void> {
  if (process.argv.includes("--list")) {
    for (const id of listMigrationIds(MIGRATIONS_DIR)) console.log(id);
    return;
  }

  if (process.argv.includes("--checklist")) {
    const attested = parseAttestations(argValue("--attest"));
    const migrationVerified = process.argv.includes("--migration-verified");
    const statuses = buildChecklistStatus(attested, migrationVerified);
    const { text, ok } = formatChecklist(statuses);
    console.log(text);
    console.log("");
    if (!ok) {
      console.error(
        "🚨 High-risk changes require a maintainer sign-off. See docs/release-readiness.md.",
      );
      process.exit(1);
    }
    return;
  }

  const migrationId = argValue("--preview") ?? argValue("--check") ?? argValue("--verify-rollback");
  if (!migrationId) {
    console.error(
      "Usage: tsx src/scripts/migrationSafety.ts --preview <migration-id>\n" +
        "       tsx src/scripts/migrationSafety.ts --check <migration-id> --post-checks\n" +
        "       tsx src/scripts/migrationSafety.ts --verify-rollback <migration-id> [--expect reverted|applied]\n" +
        "       tsx src/scripts/migrationSafety.ts --list\n" +
        "       tsx src/scripts/migrationSafety.ts --checklist [--attest tests,docs,config,rollback] [--migration-verified]",
    );
    process.exit(1);
  }

  const file = path.join(MIGRATIONS_DIR, migrationId, "migration.sql");
  if (!fs.existsSync(file)) {
    console.error(`❌ No migration.sql at ${path.relative(process.cwd(), file)}`);
    process.exit(1);
  }

  const plan = parseMigrationSql(migrationId, fs.readFileSync(file, "utf-8"));
  const prisma = getPrisma();
  const db = prisma as unknown as MigrationDatabase;

  try {
    if (argValue("--verify-rollback")) {
      const expected = argValue("--expect") ?? "reverted";
      if (expected !== "reverted" && expected !== "applied") {
        console.error('--expect must be "reverted" or "applied"');
        process.exit(1);
      }
      const report = await verifyRollback(db, plan, expected);
      console.log(formatRollbackReport(report));
      console.log("");
      if (!report.ok) process.exit(1);
      return;
    }

    const preview = await previewMigration(plan, db);
    console.log(formatPreview(preview));
    console.log("");

    if (preview.noop) {
      console.log("ℹ  Nothing to do — the schema already has everything this migration adds.\n");
    }

    if (process.argv.includes("--post-checks")) {
      const report = await runPostChecks(db, plan);
      console.log(formatPostChecks(report));
      console.log("");
      if (!report.ok) process.exit(1);
    }
  } finally {
    await disconnectPrisma();
  }
}

const isMain =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("migrationSafetyCli.ts") ||
    process.argv[1].endsWith("migrationSafetyCli.js"));

if (isMain) {
  main().catch((error) => {
    console.error("Migration safety check failed:", error);
    process.exit(1);
  });
}
