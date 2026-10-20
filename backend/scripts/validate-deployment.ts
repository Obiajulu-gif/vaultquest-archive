#!/usr/bin/env tsx
/**
 * Deployment preflight validation script
 * Checks schema version compatibility and release readiness before deployment
 * 
 * Usage:
 *   npm run validate:deployment
 *   npm run validate:deployment -- --release
 *   npm run validate:deployment -- --release --urgent
 *   
 * Exit codes:
 *   0 - Validation passed
 *   1 - Validation failed (incompatible schemas)
 */

import { PrismaClient } from "@prisma/client";
import { SchemaVersionService } from "../src/services/schemaVersionService.js";
import { SCHEMA_VERSIONS } from "../src/constants.js";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

type ChecklistItem = {
  id: string;
  label: string;
  required: boolean;
  verify: () => { ok: boolean; detail?: string };
};

const args = process.argv.slice(2);
const isReleaseMode = args.includes("--release");
const isUrgent = args.includes("--urgent");

async function main() {
  const prisma = new PrismaClient();
  const schemaVersionService = new SchemaVersionService(prisma);

  console.log("🔍 VaultQuest Deployment Validation");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  try {
    console.log("Checking schema versions...\n");

    const validation = await schemaVersionService.validateSchemaVersions();
    const versionInfo = await schemaVersionService.getVersionInfo();

    console.log("📊 Version Information:");
    console.log(`  Database Schema:`);
    console.log(`    Current:   ${versionInfo.database.current}`);
    console.log(`    Expected:  ${versionInfo.database.expected}`);
    console.log(`    Supported: ${versionInfo.database.supported.join(", ")}`);
    console.log();
    console.log(`  Indexer Schema:`);
    console.log(`    Current:   ${versionInfo.indexer.current}`);
    console.log(`    Expected:  ${versionInfo.indexer.expected}`);
    console.log(`    Supported: ${versionInfo.indexer.supported.join(", ")}`);
    console.log();

    if (!validation.valid) {
      console.error("❌ VALIDATION FAILED\n");
      console.error("Schema version incompatibility detected:");
      validation.issues.forEach((issue, idx) => {
        console.error(`  ${idx + 1}. ${issue}`);
      });
      console.error();
      console.error("🚫 Deployment blocked. Please upgrade schemas to compatible versions.\n");
      console.error("📖 See backend/docs/SCHEMA_VERSIONS.md for upgrade instructions.");
      
      process.exit(1);
    }

    console.log("✅ VALIDATION PASSED");
    console.log("   All schema versions are compatible.");
    console.log("   Safe to deploy.\n");

    if (isReleaseMode) {
      const releaseOk = await runReleaseReadinessChecklist();
      if (!releaseOk) {
        console.error("❌ RELEASE READINESS FAILED\n");
        console.error("🚫 Deployment blocked. Complete the release readiness checklist.\n");
        console.error("📖 See backend/docs/RELEASE_READINESS.md for sign-off expectations.");
        process.exit(1);
      }
      console.log("✅ RELEASE READINESS PASSED");
      console.log("   All required checklist items satisfied.\n");
    }
    
    process.exit(0);
  } catch (error) {
    console.error("❌ VALIDATION ERROR\n");
    console.error("Failed to validate schema versions:");
    console.error(error);
    console.error();
    console.error("🚫 Deployment blocked due to validation error.\n");
    
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();

/**
 * Release readiness checklist for high-risk changes.
 * Covers tests, docs, migration, config, and rollback.
 * In --urgent mode, non-required items may be waived with a documented exception.
 */
async function runReleaseReadinessChecklist(): Promise<boolean> {
  console.log("📋 Release Readiness Checklist");
  console.log("──────────────────────────────");
  if (isUrgent) {
    console.log("⚠️  Urgent mode: non-required items may be waived with documented exception.\n");
  } else {
    console.log();
  }

  const repoRoot = resolve(__dirname, "..", "..");
  const backendRoot = resolve(__dirname, "..");

  const readIfExists = (p: string): string | null =>
    existsSync(p) ? readFileSync(p, "utf8") : null;

  const checklist: ChecklistItem[] = [
    {
      id: "tests",
      label: "Automated tests added/updated for the change",
      required: true,
      verify: () => {
        const pkg = readIfExists(resolve(backendRoot, "package.json"));
        const hasTestScript = !!pkg && /"test"\s*:/.test(pkg);
        return {
          ok: hasTestScript,
          detail: hasTestScript
            ? "backend test script present"
            : "backend package.json missing a test script",
        };
      },
    },
    {
      id: "docs",
      label: "Contributor-facing docs updated (or N/A justified)",
      required: true,
      verify: () => {
        const docs = [
          resolve(backendRoot, "docs", "SCHEMA_VERSIONS.md"),
          resolve(backendRoot, "docs", "RELEASE_READINESS.md"),
        ];
        const present = docs.filter((d) => existsSync(d));
        return {
          ok: present.length > 0,
          detail:
            present.length > 0
              ? `found ${present.length} doc(s)`
              : "no release/schema docs found",
        };
      },
    },
    {
      id: "migration",
      label: "Database migration reviewed and reversible",
      required: true,
      verify: () => {
        const migrationsDir = resolve(backendRoot, "prisma", "migrations");
        const hasMigrations = existsSync(migrationsDir);
        return {
          ok: hasMigrations,
          detail: hasMigrations
            ? "prisma migrations directory present"
            : "no prisma migrations directory found",
        };
      },
    },
    {
      id: "config",
      label: "Configuration/env changes documented",
      required: true,
      verify: () => {
        const envExample = resolve(backendRoot, ".env.example");
        const hasEnvExample = existsSync(envExample);
        return {
          ok: hasEnvExample,
          detail: hasEnvExample
            ? ".env.example present"
            : ".env.example missing; document required env vars",
        };
      },
    },
    {
      id: "rollback",
      label: "Rollback plan documented",
      required: true,
      verify: () => {
        const rollbackDoc = resolve(backendRoot, "docs", "RELEASE_READINESS.md");
        const content = readIfExists(rollbackDoc);
        const ok = !!content && /rollback/i.test(content);
        return {
          ok,
          detail: ok
            ? "rollback section found in RELEASE_READINESS.md"
            : "rollback plan not documented",
        };
      },
    },
    {
      id: "signoff",
      label: "Maintainer sign-off recorded",
      required: !isUrgent,
      verify: () => {
        const signoff = process.env.VAULTQUEST_MAINTAINER_SIGNOFF;
        const ok = !!signoff && signoff.trim().length > 0;
        return {
          ok,
          detail: ok
            ? `sign-off by ${signoff}`
            : "set VAULTQUEST_MAINTAINER_SIGNOFF to record maintainer approval",
        };
      },
    },
  ];

  let allRequiredOk = true;
  const failures: string[] = [];

  for (const item of checklist) {
    let result: { ok: boolean; detail?: string };
    try {
      result = item.verify();
    } catch (err) {
      result = { ok: false, detail: `verification error: ${String(err)}` };
    }

    const status = result.ok ? "✅" : item.required ? "❌" : "⚠️ ";
    console.log(`${status} [${item.id}] ${item.label}`);
    if (result.detail) {
      console.log(`     ${result.detail}`);
    }

    if (!result.ok) {
      if (item.required) {
        allRequiredOk = false;
        failures.push(item.id);
      } else if (isUrgent) {
        console.log(`     waived (urgent mode)`);
      }
    }
  }

  console.log();

  if (isUrgent && failures.length > 0) {
    console.log("⚠️  Urgent exception path engaged.");
    console.log("   Document the exception in the PR description and notify maintainers.");
    console.log("   Required items still failing: " + failures.join(", "));
    console.log();
  }

  return allRequiredOk;
}
