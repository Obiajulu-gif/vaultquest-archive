import { buildApp } from "./app.js";
import { getEnv } from "./env.js";
import { getPrisma, pingDatabase } from "./db.js";
import { createLogger } from "./logger.js";
import {
  startReconcilerCron,
  startQuestCron,
  startIndexerCron,
  startBackupCron,
  startNotificationReminderCron
} from "./cron.js";
import { CacheService } from "./services/cacheService.js";
import { LedgerService } from "./services/ledger.js";
import {
  StellarIndexer,
  SorobanRpcEventSource,
  sorobanNativeXdrDecoder
} from "./services/stellarIndexer.js";
import { setAttestationInfo } from "./routes/health.js";
import type { ScheduledTask } from "node-cron";

let loadManifest: typeof import("../../../lib/deployment-manifest.js").loadManifest | undefined;
let validateManifestAgainstEnv: typeof import("../../../lib/deployment-manifest.js").validateManifestAgainstEnv | undefined;
try {
  const mod = await import("../../../lib/deployment-manifest.js");
  loadManifest = mod.loadManifest;
  validateManifestAgainstEnv = mod.validateManifestAgainstEnv;
} catch {
  // Manifest module not available — skip attestation (backward compatible)
}

const env = getEnv();
const logger = createLogger(env.LOG_LEVEL);

if (loadManifest && validateManifestAgainstEnv) {
  try {
    const manifest = loadManifest(env.DEPLOYMENT_MANIFEST_PATH);
    const mismatches = validateManifestAgainstEnv(manifest);
    if (mismatches.length > 0) {
      logger.fatal({ mismatches }, "Deployment manifest mismatch — refusing to start");
      process.exit(1);
    }
    setAttestationInfo({
      manifestVersion: manifest.version,
      environment: manifest.environment,
      network: manifest.network.name,
      buildSha: manifest.build.commitSha,
      verified: true,
    });
    logger.info(
      { version: manifest.version, environment: manifest.environment, network: manifest.network.name },
      "deployment manifest verified"
    );
    if (env.NETWORK_PASSPHRASE && env.NETWORK_PASSPHRASE !== manifest.network.passphrase) {
      logger.fatal(
        { envPassphrase: env.NETWORK_PASSPHRASE, manifestPassphrase: manifest.network.passphrase },
        "NETWORK_PASSPHRASE does not match deployment manifest — refusing to start"
      );
      process.exit(1);
    }
  } catch (err) {
    logger.error({ err }, "Failed to load deployment manifest — attestation skipped");
  }
} else if (env.DEPLOYMENT_MANIFEST_PATH) {
  logger.warn("DEPLOYMENT_MANIFEST_PATH set but manifest module unavailable — attestation skipped");
} else {
  logger.info("No deployment manifest configured — attestation skipped");
}
const prisma = getPrisma(env.DATABASE_URL);

// Initialize Cache Service (pointing to REDIS_URL if set, otherwise defaults to local Redis)
const cacheService = new CacheService(prisma, logger, process.env.REDIS_URL);

const app = buildApp({
  prisma,
  internalSecret: env.INTERNAL_SERVICE_SECRET,
  apiKey: env.API_KEY,
  logger,
  cacheService,
  categoriesCacheTtlSeconds: env.CATEGORIES_CACHE_TTL_SECONDS,
  reminderLeadHours: env.REMINDER_LEAD_HOURS
});

// Periodic write-behind sync task: sync checkpoint from cache to PostgreSQL database every 15 seconds
const cacheSyncInterval = setInterval(async () => {
  try {
    await cacheService.syncCheckpointToDb();
  } catch (err) {
    logger.error({ err }, "failed to sync indexer checkpoint from cache");
  }
}, 15000);
cacheSyncInterval.unref();

const cronTask = startReconcilerCron({
  prisma,
  ttlMinutes: env.ORPHAN_TTL_MINUTES,
  logger
});

const questCronTask = startQuestCron({ prisma, logger });

// Maturity / claim-window reminder notifications (issue #446).
const notificationCronTask = startNotificationReminderCron({
  prisma,
  leadHours: env.REMINDER_LEAD_HOURS,
  logger
});

// Stellar indexer daemon (#indexer). Only started when a Soroban RPC endpoint
// and at least one contract id are configured.
let indexerCronTask: ScheduledTask | undefined;
if (env.SOROBAN_RPC_URL && env.INDEXER_CONTRACT_IDS) {
  const staticContractIds = env.INDEXER_CONTRACT_IDS.split(",").map((s) => s.trim()).filter(Boolean);
  const indexerLedgerService = new LedgerService(prisma, cacheService);
  const indexer = new StellarIndexer({
    ledger: indexerLedgerService,
    source: new SorobanRpcEventSource({ rpcUrl: env.SOROBAN_RPC_URL.split(",").map((s) => s.trim()), contractIds: staticContractIds }),
    decoder: sorobanNativeXdrDecoder,
    logger,
    // #507: widen the static env list with any pools the factory has
    // registered on-chain, so a newly deployed pool starts being indexed
    // on the next tick without an env var change + restart.
    resolveContractIds: async () => {
      const registryAddresses = await indexerLedgerService.getActivePoolAddresses();
      return Array.from(new Set([...staticContractIds, ...registryAddresses]));
    },
    // #507: only a `fpooldep` event emitted by this exact contract is
    // trusted into the pool registry — see stellarIndexer.ts's
    // factoryAddress check ("spoofed pools" acceptance criterion). Left
    // undefined (fail closed, events logged and skipped) if not configured.
    factoryAddress: env.VAULT_FACTORY_ADDRESS
  });

  // Resume from the last persisted checkpoint instead of re-fetching from the
  // RPC's default window (which would either replay or gap-skip history).
  const checkpoint = await indexerLedgerService.getIndexerCheckpoint();
  if (checkpoint?.lastProcessedEventId) {
    indexer.setCursor(checkpoint.lastProcessedEventId);
  }

  indexerCronTask = startIndexerCron({ prisma, indexer, ledger: indexerLedgerService, logger });
  logger.info({ contractIds: staticContractIds, resumeCursor: checkpoint?.lastProcessedEventId ?? null }, "stellar indexer daemon started");
}

// Automated database backup cron (#275). Only started when BACKUP_DIR is set.
let backupCronTask: ScheduledTask | undefined;
if (env.BACKUP_DIR) {
  backupCronTask = startBackupCron({
    backupDir: env.BACKUP_DIR,
    databaseUrl: env.DATABASE_URL,
    retainDays: env.BACKUP_RETAIN_DAYS,
    schedule: env.BACKUP_SCHEDULE,
    logger,
    prisma
  });
  logger.info(
    { backupDir: env.BACKUP_DIR, schedule: env.BACKUP_SCHEDULE },
    "backup cron started"
  );
}

async function shutdown(signal: string) {
  logger.info({ signal }, "shutting down");
  clearInterval(cacheSyncInterval);
  cronTask.stop();
  questCronTask.stop();
  notificationCronTask.stop();
  indexerCronTask?.stop();
  backupCronTask?.stop();
  await app.close();
  await cacheService.disconnect();
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

pingDatabase(prisma).then((isConnected) => {
  if (!isConnected) {
    logger.error("failed to connect to database on startup. shutting down.");
    process.exit(1);
  }
  return app.listen({ port: env.PORT, host: "0.0.0.0" });
}).then((addr) => {
  if (addr) logger.info({ addr }, "listening");
}).catch((err) => {
  logger.error({ err }, "failed to start");
  process.exit(1);
});
