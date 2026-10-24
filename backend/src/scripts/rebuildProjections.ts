import { parseArgs } from "node:util";
import { PrismaClient } from "@prisma/client";
import { AppError } from "../errors.js";
import { LedgerService } from "../services/ledger.js";
import { LeaseService } from "../services/leaseService.js";
import { AuditTrailService } from "../services/auditTrail.js";
import { PrismaAuditTrailStore } from "../services/governanceStores.js";
import { sorobanNativeXdrDecoder } from "../services/stellarIndexer.js";
import { LeaseIndexerFence, PrismaProjectionRebuildStore, PrismaProjectionTarget, ProjectionRebuildService } from "../services/projectionRebuild.js";

async function main() {
  const { values } = parseArgs({ options: {
    execute: { type: "boolean", default: false }, resume: { type: "string" },
    reason: { type: "string" }, actor: { type: "string" }, "allow-downgrade": { type: "boolean", default: false },
  } });
  if ((values.resume || values["allow-downgrade"]) && !values.execute) throw AppError.validation("resume and downgrade flags require --execute");
  if (values.execute && (!values.actor?.trim() || (!values.resume && (values.reason?.trim().length ?? 0) < 3))) {
    throw AppError.validation("execution requires --actor and a reason of at least three characters (resume requires --actor)");
  }
  const prisma = new PrismaClient();
  try {
    const svc = new ProjectionRebuildService({
      runs: new PrismaProjectionRebuildStore(prisma),
      target: new PrismaProjectionTarget(prisma, new LedgerService(prisma), {
        decoder: sorobanNativeXdrDecoder, factoryAddress: process.env.VAULT_FACTORY_ADDRESS,
      }),
      fence: new LeaseIndexerFence(new LeaseService(prisma)),
      audit: new AuditTrailService(new PrismaAuditTrailStore(prisma)),
    });
    if (!values.execute) {
      console.log(JSON.stringify({ readOnly: true, ...await svc.plan() }, null, 2));
      return;
    }
    const actor = { subject: values.actor!.trim(), role: "maintainer" as const };
    const execution = values.resume ? await svc.resume(values.resume, actor)
      : await svc.start({ actor, reason: values.reason!.trim(), allowDowngrade: values["allow-downgrade"] });
    const run = await execution.done;
    console.log(JSON.stringify({ runId: run.id, status: run.status, cursor: run.cursor,
      eventsReplayed: run.eventsReplayed, errorCode: run.errorCode,
      ...(run.status === "failed" ? { nextStep: "Inspect the authenticated rebuild report; restore missing events or fix the decoder/write error, then use --execute --resume <runId> --actor <operator>." } : {}),
    }, null, 2));
    if (run.status !== "completed") process.exitCode = 1;
  } finally { await prisma.$disconnect(); }
}
main().catch((error) => {
  console.error(JSON.stringify({ status: "failed", message: error instanceof AppError ? error.message
    : "Check database connectivity, migrations and CLI arguments; retry with the same resume ID after repair." }));
  process.exitCode = 2;
});
