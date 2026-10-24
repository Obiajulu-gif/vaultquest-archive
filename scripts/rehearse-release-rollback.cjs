#!/usr/bin/env node
"use strict";

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function parseSafeDatabaseUrls(sourceUrl, restoreUrl) {
  if (!sourceUrl || !restoreUrl) {
    throw new Error("Set RELEASE_TEST_DATABASE_URL and RELEASE_ROLLBACK_DATABASE_URL.");
  }
  const source = new URL(sourceUrl);
  const restore = new URL(restoreUrl);
  if (!["postgres:", "postgresql:"].includes(source.protocol) || !["postgres:", "postgresql:"].includes(restore.protocol)) {
    throw new Error("Rollback rehearsal requires PostgreSQL connection URLs.");
  }
  const unsafeParameters = ["host", "hostaddr", "service", "servicefile"];
  if (
    unsafeParameters.some((parameter) => source.searchParams.has(parameter) || restore.searchParams.has(parameter))
  ) {
    throw new Error("Connection URL overrides are not permitted for rollback rehearsal.");
  }
  const allowedHosts = new Set(["localhost", "127.0.0.1", "::1", "postgres"]);
  if (!allowedHosts.has(source.hostname) || !allowedHosts.has(restore.hostname)) {
    throw new Error("Rollback rehearsal only permits local disposable PostgreSQL hosts.");
  }
  const sourceName = decodeURIComponent(source.pathname.slice(1));
  const restoreName = decodeURIComponent(restore.pathname.slice(1));
  if (!/_test$/.test(sourceName) || !/_rollback_test$/.test(restoreName)) {
    throw new Error("Source database must end in _test and restore database must end in _rollback_test.");
  }
  if (
    source.hostname === restore.hostname &&
    source.port === restore.port &&
    sourceName === restoreName
  ) {
    throw new Error("Source and restore databases must be different.");
  }
  return { sourceUrl, restoreUrl };
}

function run(command, args, label) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
  } catch (error) {
    const status = error && typeof error.status === "number" ? error.status : "unknown";
    throw new Error(`${label} failed (exit ${status}).`);
  }
}

function query(url, sql, label) {
  return run("psql", [
    url,
    "--no-psqlrc",
    "--tuples-only",
    "--no-align",
    "--set=ON_ERROR_STOP=1",
    "--command",
    sql,
  ], label).trim();
}

function rehearse(env = process.env) {
  const { sourceUrl, restoreUrl } = parseSafeDatabaseUrls(
    env.RELEASE_TEST_DATABASE_URL,
    env.RELEASE_ROLLBACK_DATABASE_URL,
  );
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vaultquest-release-rollback-"));
  const archive = path.join(tempDir, "pre-rollback.dump");
  const query = [
    "SELECT migration_name FROM _prisma_migrations",
    "WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL",
    "ORDER BY migration_name",
  ].join(" ");

  try {
    const restoreObjects = query(
      restoreUrl,
      [
        "SELECT",
        "(SELECT COUNT(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')) +",
        "(SELECT COUNT(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public') +",
        "(SELECT COUNT(*) FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typrelid = 0 AND t.typtype IN ('e', 'd', 'c', 'r', 'm'))",
      ].join(" "),
      "Rollback target safety check",
    );
    if (restoreObjects !== "0") {
      throw new Error("Rollback target is not empty; refusing to overwrite it.");
    }

    query(restoreUrl, "DROP SCHEMA public CASCADE; CREATE SCHEMA public", "Rollback target schema preparation");
    run("pg_dump", ["--format=custom", "--no-owner", "--no-acl", "--file", archive, sourceUrl], "Pre-release backup");
    run("pg_restore", ["--list", archive], "Backup archive integrity check");
    run("pg_restore", ["--no-owner", "--no-acl", "--dbname", restoreUrl, archive], "Rollback restore");

    const migrationHistoryQuery = [
      "SELECT migration_name FROM _prisma_migrations",
      "WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL",
      "ORDER BY migration_name",
    ].join(" ");
    const sourceMigrations = query(sourceUrl, migrationHistoryQuery, "Source migration verification");
    const restoredMigrations = query(restoreUrl, migrationHistoryQuery, "Restored migration verification");
    if (!sourceMigrations || sourceMigrations !== restoredMigrations) {
      throw new Error("Restored migration history does not match the pre-release database.");
    }

    const tablesQuery = "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename";
    const sourceTables = query(sourceUrl, tablesQuery, "Source table verification").split(/\r?\n/).filter(Boolean);
    const restoredTables = query(restoreUrl, tablesQuery, "Restored table verification").split(/\r?\n/).filter(Boolean);
    if (sourceTables.length === 0 || JSON.stringify(sourceTables) !== JSON.stringify(restoredTables)) {
      throw new Error("Restored table list does not match the pre-release database.");
    }
    for (const table of sourceTables) {
      const quotedTable = `"${table.replace(/"/g, '""')}"`;
      const countQuery = `SELECT COUNT(*) FROM public.${quotedTable}`;
      const sourceCount = query(sourceUrl, countQuery, `Source row verification for ${table}`);
      const restoredCount = query(restoreUrl, countQuery, `Restored row verification for ${table}`);
      if (sourceCount !== restoredCount) {
        throw new Error(`Restored row count does not match for ${table}.`);
      }
    }
    console.log(
      `Rollback rehearsal passed: restored ${sourceMigrations.split(/\r?\n/).length} migration records and verified ${sourceTables.length} table row counts.`,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try {
    rehearse();
  } catch (error) {
    console.error(`Rollback rehearsal failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

module.exports = { parseSafeDatabaseUrls, query, rehearse };
