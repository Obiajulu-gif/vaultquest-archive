import { PrismaClient } from "@prisma/client";
import { reconcileAll } from "../services/reconciler.js";
import { buildReconciliationReport } from "../services/reconciliationReport.js";

const args = new Set(process.argv.slice(2));

if (!args.has("--dry-run")) {
  console.error("Usage: pnpm reconcile:dry-run");
  console.error("The report command is intentionally read-only; repairs require the controlled proposal workflow.");
  process.exitCode = 2;
} else {
  const prisma = new PrismaClient();
  try {
    const result = await reconcileAll(prisma, { dryRun: true });
    const report = buildReconciliationReport(result);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
