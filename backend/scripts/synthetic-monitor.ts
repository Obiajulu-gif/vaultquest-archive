/**
 * Runnable synthetic journey monitor (#monitor).
 *
 * Exercises the critical happy path in-process against the configured
 * database through the real HTTP surface (no server needed):
 *
 *   pnpm --filter @trustquest/backend monitor:synthetic
 *   # or
 *   npx tsx scripts/synthetic-monitor.ts
 *
 * Emits the full run result as JSON on stdout and exits non-zero on failure,
 * so it drops straight into cron, CI, or an alerting wrapper:
 *
 *   { "status": "pass", "total_duration_ms": 42, "steps": [...], "blame": null }
 *
 * Environment:
 *   DATABASE_URL, INTERNAL_SERVICE_SECRET   (required)
 *   SYNTHETIC_MONITOR_LATENCY_BUDGET_MS     (optional, default 5000)
 */
import { buildApp } from "../src/app.js";
import { getEnv } from "../src/env.js";
import { getPrisma, disconnectPrisma } from "../src/db.js";
import { getSyntheticMonitor } from "../src/services/syntheticMonitor.js";

async function main(): Promise<number> {
  const env = getEnv();
  const prisma = getPrisma(env.DATABASE_URL);

  const app = buildApp({
    prisma,
    internalSecret: env.INTERNAL_SERVICE_SECRET,
    monitorLatencyBudgetMs: env.SYNTHETIC_MONITOR_LATENCY_BUDGET_MS
  });

  try {
    await app.ready();
    const runner = getSyntheticMonitor(app);
    if (!runner) {
      console.error("synthetic monitor runner was not attached to the app");
      return 2;
    }

    const result = await runner.run();
    console.log(JSON.stringify(result, null, 2));
    return result.status === "fail" ? 1 : 0;
  } finally {
    await app.close();
    await disconnectPrisma();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error("synthetic monitor crashed:", err);
    process.exitCode = 2;
  });
