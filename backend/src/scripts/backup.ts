/**
 * Standalone database backup script (issue #275).
 *
 * Run manually or from a CI/deployment pipeline:
 *
 *   tsx src/scripts/backup.ts
 *
 * Reads the same env vars as the server process:
 *   DATABASE_URL      – PostgreSQL connection string (required)
 *   BACKUP_DIR        – Directory to store dump files (required)
 *   BACKUP_RETAIN_DAYS – Days of backups to keep (default 7)
 *
 * Exit codes:
 *   0  – backup succeeded
 *   1  – backup failed (error printed to stderr)
 */

import { getEnv } from "../env.js";
import { BackupService } from "../services/backupService.js";
import { createLogger } from "../logger.js";

const env = getEnv();
const logger = createLogger(env.LOG_LEVEL);

if (!env.BACKUP_DIR) {
  console.error(
    "backup: BACKUP_DIR is not set. Set it to an absolute path and re-run."
  );
  process.exit(1);
}

const svc = new BackupService({
  backupDir: env.BACKUP_DIR,
  databaseUrl: env.DATABASE_URL,
  retainDays: env.BACKUP_RETAIN_DAYS,
  logger
});

svc
  .run()
  .then((result) => {
    logger.info(result, "backup: finished");
    console.log(
      `backup: wrote ${result.filePath} in ${result.durationMs}ms, pruned ${result.pruned} old file(s)`
    );
    process.exit(0);
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err }, "backup: failed");
    console.error(`backup: failed — ${message}`);
    process.exit(1);
  });
