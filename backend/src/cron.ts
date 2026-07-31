import cron from "node-cron";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { Logger } from "pino";
import { sweepOrphans } from "./services/reconciler.js";
import { QuestService } from "./services/questService.js";
import { BackupService } from "./services/backupService.js";
import { NotificationService } from "./services/notificationService.js";
import type { StellarIndexer } from "./services/stellarIndexer.js";
import { pingDatabase } from "./db.js";
import type { LedgerService } from "./services/ledger.js";
import { LeaseService } from "./services/leaseService.js";

// #506 — one worker id per process, reused across every job lease this
// process acquires, so ownership/takeover metrics can be attributed to a
// specific process instance.
const WORKER_ID = `${process.env.HOSTNAME ?? "worker"}-${randomUUID().slice(0, 8)}`;

// #506 — heartbeat interval as a fraction of a job's TTL. Renewing at 1/3
// of the TTL gives up to two missed heartbeats of slack (e.g. a transient
// DB blip) before the lease can actually lapse, while still renewing
// often enough that a long-running tick's lease essentially never expires
// out from under it while the tick is genuinely still alive.
const HEARTBEAT_FRACTION = 3;

/**
 * Runs `fn` only if `jobName`'s lease is successfully acquired for this
 * process — i.e. no other worker currently holds an unexpired lease for
 * the same job. Skips (and logs) rather than running when the lease
 * can't be acquired, so overlapping ticks across replicas (or a slow tick
 * of the same job) never run concurrently. The lease is intentionally
 * NOT released on failure — see LeaseService.releaseJobLease's comment —
 * so a crashed tick forces a cooldown instead of an immediate retry loop.
 *
 * While `fn` runs, a heartbeat periodically renews the lease (guarded by
 * both workerId and fencingToken — see LeaseService.renewJobLease) so a
 * tick that legitimately runs longer than the TTL never loses its lease
 * to a takeover while it's still alive and making progress. If a
 * heartbeat renewal ever fails (lease already expired and taken over by
 * another worker — real split-brain risk, not a transient blip), this
 * worker no longer holds the lease and must stop treating itself as the
 * owner: the heartbeat sets a flag that fn can't directly observe today
 * (job bodies aren't yet fencing-token-aware per call), so at minimum we
 * stop renewing and surface it loudly in logs rather than silently
 * continuing as if nothing happened.
 */
async function withJobLease(
  leases: LeaseService,
  jobName: string,
  ttlMs: number,
  logger: Logger,
  fn: () => Promise<void>
): Promise<void> {
  const handle = await leases.acquireJobLease({ jobName, workerId: WORKER_ID, ttlMs });
  if (!handle) {
    logger.info({ jobName }, "job lease held by another worker, skipping this tick");
    return;
  }

  let fencingToken = handle.fencingToken;
  let lostLease = false;
  const heartbeat = setInterval(() => {
    void (async () => {
      const renewed = await leases.renewJobLease(jobName, WORKER_ID, fencingToken, ttlMs).catch((err) => {
        logger.warn({ jobName, err }, "job lease heartbeat renewal errored");
        return false;
      });
      if (!renewed) {
        if (!lostLease) {
          lostLease = true;
          logger.error(
            { jobName },
            "job lease heartbeat failed to renew — lease was taken over by another worker while this tick is still running"
          );
        }
        return;
      }
      // A successful renewal under the *same* fencing token confirms no
      // takeover happened; the token itself doesn't change on renewal
      // (only on acquisition/takeover), so it stays valid for the next
      // heartbeat unchanged.
    })();
  }, Math.max(1000, Math.floor(ttlMs / HEARTBEAT_FRACTION)));
  // Don't let the heartbeat timer keep the process alive on its own.
  heartbeat.unref?.();

  try {
    await fn();
    clearInterval(heartbeat);
    if (lostLease) {
      // The lease was taken over mid-tick and another worker may already
      // be running (or about to run) the same job — do not release,
      // since releasing now could hand a "clean" lease straight to that
      // other worker while this tick's just-committed side effects are
      // still settling. Let expiry/normal takeover handle it.
      logger.warn({ jobName }, "job tick completed after losing its lease mid-run; not releasing");
      return;
    }
    await leases.releaseJobLease(jobName, WORKER_ID);
  } catch (err) {
    clearInterval(heartbeat);
    logger.error({ jobName, err }, "job tick failed while holding lease");
    // Deliberately not released — see releaseJobLease's doc comment.
    throw err;
  }
}

export function startReconcilerCron(opts: {
  prisma: PrismaClient;
  ttlMinutes: number;
  logger: Logger;
  schedule?: string;
}): cron.ScheduledTask {
  const schedule = opts.schedule ?? "*/1 * * * *";
  const leases = new LeaseService(opts.prisma);
  // Lease TTL is a few schedule intervals, not one — a slow-but-alive
  // reconciler tick renewing partway through shouldn't get pre-empted by
  // its own lease expiring (see startIndexerCron/startQuestCron for the
  // same reasoning applied to their own schedules).
  const leaseTtlMs = 5 * 60 * 1000;
  const task = cron.schedule(schedule, async () => {
    try {
      await withJobLease(leases, "reconciler-sweep", leaseTtlMs, opts.logger, async () => {
        const result = await sweepOrphans(opts.prisma, { ttlMinutes: opts.ttlMinutes });
        opts.logger.info({ result }, "reconciler sweep complete");
      });
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
  const leases = new LeaseService(opts.prisma);
  const leaseTtlMs = 5 * 60 * 1000;

  const task = cron.schedule(schedule, async () => {
    const since = new Date(Date.now() - lookbackMinutes * 60 * 1000);
    try {
      await withJobLease(leases, "quest-evaluation", leaseTtlMs, opts.logger, async () => {
        const result = await questService.evaluateRecent(since);
        // #505 — grant processing runs under the same lease as the sweep
        // that creates grant intents; RewardGrant's own idempotencyKey
        // unique constraint is the real double-grant guard (see
        // createRewardGrantIfAbsent), the shared lease is just the
        // first, cheaper line of defense against overlapping ticks.
        const grants = await questService.processGrants();
        opts.logger.info({ result, grants }, "quest evaluation sweep complete");
      });
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
  const leases = new LeaseService(opts.prisma);
  const leaseTtlMs = 5 * 60 * 1000;
  const task = cron.schedule(schedule, async () => {
    try {
      await withJobLease(leases, "stellar-indexer", leaseTtlMs, opts.logger, async () => {
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
      });
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
  prisma: PrismaClient;
}): cron.ScheduledTask {
  const schedule = opts.schedule ?? "0 2 * * *"; // default: daily at 02:00
  const svc = new BackupService({
    backupDir: opts.backupDir,
    databaseUrl: opts.databaseUrl,
    retainDays: opts.retainDays,
    pgDumpPath: opts.pgDumpPath,
    logger: opts.logger
  });
  const leases = new LeaseService(opts.prisma);
  // Backups run once daily and pg_dump can legitimately take a while on a
  // large database — a generous TTL avoids a still-running dump losing
  // its lease to a "takeover" from the next day's schedule (which
  // wouldn't even fire for ~24h anyway, but keeps this consistent with
  // the other jobs' reasoning).
  const leaseTtlMs = 60 * 60 * 1000;

  const task = cron.schedule(schedule, async () => {
    try {
      await withJobLease(leases, "db-backup", leaseTtlMs, opts.logger, async () => {
        const result = await svc.run();
        opts.logger.info({ result }, "backup: completed");
      });
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
  const leases = new LeaseService(opts.prisma);
  const leaseTtlMs = 5 * 60 * 1000;

  const task = cron.schedule(schedule, async () => {
    try {
      await withJobLease(leases, "notification-reminders", leaseTtlMs, opts.logger, async () => {
        const created = await notificationService.generateReminders();
        opts.logger.info({ created }, "notification reminder sweep complete");
      });
    } catch (err) {
      opts.logger.error({ err }, "notification reminder sweep failed");
    }
  });
  return task;
}
