#!/usr/bin/env npx tsx
import { promises as fs } from 'fs';
import path from 'path';
import {
  FileCheckpointStore,
  OrphanRecord,
  OrphanRepairAdapter,
  OrphanRepairAuthorizationError,
  OrphanRepairCheckpointError,
  RepairActorRole,
  rollbackOrphanRepair,
  runOrphanRepair,
} from '../lib/orphan-repair';

interface CliArgs {
  runId: string;
  checkpointFile: string;
  inputFile?: string;
  batchSize: number;
  maxRetries: number;
  resume: boolean;
  dryRun: boolean;
  rollback: boolean;
  retryDeadLettered: boolean;
  stopOnFailure: boolean;
  actorId: string;
  actorRole: RepairActorRole;
  json: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    runId: `orphan-repair-${Date.now()}`,
    checkpointFile: path.resolve(process.cwd(), '.orphan-repair-checkpoint.json'),
    batchSize: 10,
    maxRetries: 3,
    resume: false,
    dryRun: false,
    rollback: false,
    retryDeadLettered: false,
    stopOnFailure: false,
    actorId: process.env.ORPHAN_REPAIR_ACTOR_ID || 'cli-operator',
    actorRole: (process.env.ORPHAN_REPAIR_ACTOR_ROLE as RepairActorRole) || 'viewer',
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case '--run-id':
        args.runId = next;
        i += 1;
        break;
      case '--checkpoint-file':
        args.checkpointFile = path.resolve(next);
        i += 1;
        break;
      case '--input':
        args.inputFile = path.resolve(next);
        i += 1;
        break;
      case '--batch-size':
        args.batchSize = Number.parseInt(next, 10);
        i += 1;
        break;
      case '--max-retries':
        args.maxRetries = Number.parseInt(next, 10);
        i += 1;
        break;
      case '--actor-id':
        args.actorId = next;
        i += 1;
        break;
      case '--actor-role':
        args.actorRole = next as RepairActorRole;
        i += 1;
        break;
      case '--resume':
        args.resume = true;
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--rollback':
        args.rollback = true;
        break;
      case '--retry-dead-lettered':
        args.retryDeadLettered = true;
        break;
      case '--stop-on-failure':
        args.stopOnFailure = true;
        break;
      case '--json':
        args.json = true;
        break;
      default:
        break;
    }
  }
  return args;
}

function createJsonFileAdapter(inputFile?: string): OrphanRepairAdapter {
  return {
    async listOrphans(): Promise<OrphanRecord[]> {
      if (!inputFile) {
        return [];
      }
      const raw = await fs.readFile(inputFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        throw new Error(`Input file ${inputFile} must contain a JSON array of orphan records.`);
      }
      return parsed as OrphanRecord[];
    },
    async repairRecord(record) {
      return {
        action: record.entityType === 'session' ? 'purge' : 'relink',
        previousState: { parentId: record.parentId, reason: record.reason },
      };
    },
    async rollbackRecord() {
      // File-backed CLI dry/local adapter records rollback completion in checkpoint.
    },
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const checkpointStore = new FileCheckpointStore(args.checkpointFile);
  const adapter = createJsonFileAdapter(args.inputFile);
  const actor = { id: args.actorId, role: args.actorRole };

  try {
    if (args.rollback) {
      const report = await rollbackOrphanRepair({
        runId: args.runId,
        actor,
        adapter,
        checkpointStore,
      });
      if (args.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(
          `[orphan-repair] Rolled back run ${report.runId}: ${report.rolledBackCount} record(s) reverted (status=${report.status}).`
        );
      }
      return;
    }

    const report = await runOrphanRepair({
      runId: args.runId,
      actor,
      adapter,
      checkpointStore,
      batchSize: args.batchSize,
      maxRetries: args.maxRetries,
      dryRun: args.dryRun,
      resume: args.resume,
      retryDeadLettered: args.retryDeadLettered,
      stopOnFailure: args.stopOnFailure,
    });

    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(
        `[orphan-repair] Run ${report.runId} finished with status=${report.status} ` +
          `(succeeded=${report.succeededTotal}/${report.totalRecords}, failed=${report.failedTotal}, skipped=${report.skippedAlreadyCompleted}).`
      );
    }

    if (report.status === 'failed' || report.status === 'paused') {
      process.exitCode = 1;
    }
  } catch (err: unknown) {
    if (err instanceof OrphanRepairAuthorizationError) {
      console.error(`[orphan-repair] Authorization error: ${err.message}`);
      process.exitCode = 2;
      return;
    }
    if (err instanceof OrphanRepairCheckpointError) {
      console.error(`[orphan-repair] Checkpoint error: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    console.error(
      `[orphan-repair] Unexpected error: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exitCode = 1;
  }
}

main();
