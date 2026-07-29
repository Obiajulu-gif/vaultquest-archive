import cron from "node-cron";
import type { PrismaClient } from "@prisma/client";
import type { Logger } from "pino";
import { sweepOrphans } from "./services/reconciler.js";
import { QuestService } from "./services/questService.js";
import { BackupService } from "./services/backupService.js";
import { NotificationService } from "./services/notificationService.js";
import type { StellarIndexer } from "./services/stellarIndexer.js";
import { pingDatabase } from "./db.js";
import { LedgerService } from "./services/ledger.js";

export function startReconcilerCron(opts: {
  prisma: PrismaClient;
  ttlMinutes: number;
  logger: Logger;
  schedule?: string;
}): cron.ScheduledTask {
  const schedule = opts.schedule ?? "*/1 * * * *";
  const task = cron.schedule(schedule, async () => {
    try {
      const result = await sweepOrphans(opts.prisma, { ttlMinutes: opts.ttlMinutes });
      opts.logger.info({ result }, "reconciler sweep complete");
    } catch (err) {
      opts.logger.error({ err }, "reconciler sweep failed");
    }
  });
  return task;
}

/**
 * Periodically re-evaluates savings quests for wallets with recently confirmed
 * ledger activity (#26). The lookback window is kept slightly larger than the
 * schedule interval so a slow tick never skips a wallet.
 */
export function startQuestCron(opts: {
  prisma: PrismaClient;
  logger: Logger;
  schedule?: string;
  lookbackMinutes?: number;
}): cron.ScheduledTask {
  const schedule = opts.schedule ?? "*/2 * * * *";
  const lookbackMinutes = opts.lookbackMinutes ?? 10;
  const questService = new QuestService(opts.prisma);

  const task = cron.schedule(schedule, async () => {
    const since = new Date(Date.now() - lookbackMinutes * 60 * 1000);
    try {
      const result = await questService.evaluateRecent(since);
      opts.logger.info({ result }, "quest evaluation sweep complete");
    } catch (err) {
      opts.logger.error({ err }, "quest evaluation sweep failed");
    }
  });
  return task;
}

/**
 * Drives the Stellar indexer daemon on a schedule (#indexer). Each tick polls
 * Horizon for new contract events and reconciles them into the ledger. The
 * tick is skipped when the database is unreachable so we never fetch events we
 * cannot persist.
 */
export function startIndexerCron(opts: {
  prisma: PrismaClient;
  indexer: StellarIndexer;
  ledger: LedgerService;
  logger: Logger;
  schedule?: string;
}): cron.ScheduledTask {
  const schedule = opts.schedule ?? "*/1 * * * *";
  const task = cron.schedule(schedule, async () => {
    try {
      if (!(await pingDatabase(opts.prisma))) {
        opts.logger.warn({}, "indexer tick skipped: database unreachable");
        return;
      }
      const result = await opts.indexer.tick();
      opts.logger.info({ result }, "indexer tick complete");

      // Persist cursor/ledger progress so a restart resumes exactly where the
      // last successful tick left off instead of replaying or skipping events.
      if (result.latestLedger !== null) {
        await opts.ledger.updateIndexerCheckpoint({
          latestLedger: result.latestLedger,
          lastProcessedEventId: result.cursor,
          success: true
        });
      }
    } catch (err) {
      opts.logger.error({ err }, "indexer tick failed");
      try {
        const existing = await opts.ledger.getIndexerCheckpoint();
        await opts.ledger.updateIndexerCheckpoint({
          latestLedger: existing?.latestLedger ?? 0,
          success: false,
          lastError: err instanceof Error ? err.message : String(err)
        });
      } catch {
        // best-effort; don't let checkpoint persistence mask the original error
      }
    }
  });
  return task;
}

/**
 * Runs automated PostgreSQL backups on a schedule (issue #275).
 *
 * Each tick calls `BackupService.run()` which shells out to `pg_dump` and
 * prunes files older than `retainDays`. The cron is only started when
 * `BACKUP_DIR` is set in the environment.
 */
export function startBackupCron(opts: {
  backupDir: string;
  databaseUrl: string;
  retainDays?: number;
  pgDumpPath?: string;
  logger: Logger;
  schedule?: string;
}): cron.ScheduledTask {
  const schedule = opts.schedule ?? "0 2 * * *"; // default: daily at 02:00
  const svc = new BackupService({
    backupDir: opts.backupDir,
    databaseUrl: opts.databaseUrl,
    retainDays: opts.retainDays,
    pgDumpPath: opts.pgDumpPath,
    logger: opts.logger
  });

  const task = cron.schedule(schedule, async () => {
    try {
      const result = await svc.run();
      opts.logger.info({ result }, "backup: completed");
    } catch (err) {
      opts.logger.error({ err }, "backup: failed");
    }
  });
  return task;
}

/**
 * Periodically generates maturity / claim-window reminder notifications
 * (issue #446). `leadHours` controls how far ahead of a position's lock/draw
 * date a reminder is created; generation is idempotent so re-running never
 * duplicates notifications.
 */
export function startNotificationReminderCron(opts: {
  prisma: PrismaClient;
  leadHours: number;
  logger: Logger;
  schedule?: string;
}): cron.ScheduledTask {
  const schedule = opts.schedule ?? "*/5 * * * *";
  const notificationService = new NotificationService(opts.prisma, opts.leadHours);

  const task = cron.schedule(schedule, async () => {
    try {
      const created = await notificationService.generateReminders();
      opts.logger.info({ created }, "notification reminder sweep complete");
    } catch (err) {
      opts.logger.error({ err }, "notification reminder sweep failed");
    }
  });
  return task;
}
