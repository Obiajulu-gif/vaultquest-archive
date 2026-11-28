#!/usr/bin/env tsx
/**
 * Resumable orphan-repair command with durable checkpoints (#1149).
 *
 * The command wraps {@link ResumableRepairEngine} so operators can start,
 * resume, inspect, or list repair jobs without going through the HTTP API.
 * Checkpoints are written atomically to one JSON file per job, which means a
 * crashed or restarted process resumes from the last committed batch instead
 * of reprocessing records.
 *
 * Usage:
 *   pnpm --filter backend repair:orphans -- --actor-role operator --dry-run
 *   pnpm --filter backend repair:orphans -- --actor-role operator --batch-size 25
 *   pnpm --filter backend repair:orphans -- --resume --job-id <id> --actor-role admin
 *   pnpm --filter backend repair:orphans -- --status --job-id <id> --actor-role auditor
 *   pnpm --filter backend repair:orphans -- --list --actor-role auditor --json
 *   pnpm --filter backend repair:orphans -- --input fixtures/repair.json --dry-run --actor-role auditor
 *
 * Authorization:
 *   - `admin` and `operator` may start and resume repair jobs.
 *   - `admin`, `operator`, and `auditor` may inspect checkpoints.
 *   - `viewer` is rejected before any state is read or written.
 *
 * Failure and recovery behavior:
 *   - A record-level failure is isolated and recorded on the checkpoint; the
 *     batch continues and the job can be resumed later.
 *   - If the process dies mid-batch, the previous checkpoint remains intact
 *     because files are replaced with an atomic rename.
 *   - Resume is idempotent: resuming a completed job returns its checkpoint
 *     without running any phase again.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { AppError } from "../errors.js";
import { ERROR_CODES } from "../constants.js";
import {
  FileRepairCheckpointStore,
  InMemoryRepairDataSource,
  PrismaRepairDataSource,
  REPAIR_PHASES,
  ResumableRepairEngine,
  type RepairCheckpoint,
  type RepairCheckpointStore,
  type RepairDataSource,
  type RepairPhase,
  type StartRepairOptions,
  type StaleActionRecord,
  type StaleEventRecord,
  type StaleSettlementRecord
} from "../services/resumableRepairJob.js";

export const REPAIR_ACTOR_ROLES = ["admin", "operator", "auditor", "viewer"] as const;
export type RepairActorRole = (typeof REPAIR_ACTOR_ROLES)[number];

export type OrphanRepairCommand = "start" | "resume" | "status" | "list";

export interface OrphanRepairCliOptions {
  command: OrphanRepairCommand;
  jobId?: string;
  checkpointDir?: string;
  input?: string;
  dryRun?: boolean;
  batchSize?: number;
  phases?: RepairPhase[];
  actorId?: string;
  actorRole?: RepairActorRole;
  json?: boolean;
}

export interface OrphanRepairDependencies {
  engine?: ResumableRepairEngine;
  checkpointStore?: RepairCheckpointStore;
  dataSource?: RepairDataSource;
}

interface RepairInputFile {
  actions?: Array<Omit<StaleActionRecord, "updatedAt"> & { updatedAt: string }>;
  events?: Array<Omit<StaleEventRecord, "receivedAt"> & { receivedAt: string }>;
  settlements?: Array<Omit<StaleSettlementRecord, "updatedAt"> & { updatedAt: string }>;
}

const DEFAULT_CHECKPOINT_DIR = resolve(process.cwd(), ".orphan-repair-checkpoints");

export function authorizeRepairActor(
  role: RepairActorRole,
  { mutation }: { mutation: boolean }
): RepairActorRole {
  if (!REPAIR_ACTOR_ROLES.includes(role)) {
    throw new AppError(ERROR_CODES.INVALID_PAYLOAD, 400, `Unknown actor role "${role}".`);
  }
  if (mutation) {
    if (role !== "admin" && role !== "operator") {
      throw new AppError(
        ERROR_CODES.FORBIDDEN,
        403,
        `Role "${role}" cannot start or resume repair jobs.`
      );
    }
    return role;
  }
  if (role === "viewer") {
    throw new AppError(
      ERROR_CODES.FORBIDDEN,
      403,
      `Role "viewer" cannot inspect repair checkpoints.`
    );
  }
  return role;
}

export function parseArgs(args: string[]): OrphanRepairCliOptions {
  const options: OrphanRepairCliOptions = { command: "start" };
  const next = (index: number, flag: string): string => {
    const value = args[index];
    if (value === undefined || value.startsWith("--")) {
      throw new AppError(ERROR_CODES.INVALID_PAYLOAD, 400, `${flag} requires a value.`);
    }
    return value;
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--resume":
        options.command = "resume";
        break;
      case "--status":
        options.command = "status";
        break;
      case "--list":
        options.command = "list";
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--job-id":
        options.jobId = next(++i, arg);
        break;
      case "--checkpoint-dir":
        options.checkpointDir = next(++i, arg);
        break;
      case "--input":
        options.input = next(++i, arg);
        break;
      case "--batch-size": {
        const raw = next(++i, arg);
        const batchSize = Number.parseInt(raw, 10);
        if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 200) {
          throw new AppError(
            ERROR_CODES.INVALID_PAYLOAD,
            400,
            `--batch-size must be an integer between 1 and 200 (received "${raw}").`
          );
        }
        options.batchSize = batchSize;
        break;
      }
      case "--phases": {
        const raw = next(++i, arg);
        const phases = raw.split(",").map((phase) => phase.trim()).filter(Boolean);
        const invalid = phases.filter((phase) => !REPAIR_PHASES.includes(phase as RepairPhase));
        if (invalid.length > 0) {
          throw new AppError(
            ERROR_CODES.INVALID_PAYLOAD,
            400,
            `Unknown repair phase(s): ${invalid.join(", ")}.`
          );
        }
        options.phases = phases as RepairPhase[];
        break;
      }
      case "--actor-id":
        options.actorId = next(++i, arg);
        break;
      case "--actor-role": {
        const raw = next(++i, arg);
        if (!REPAIR_ACTOR_ROLES.includes(raw as RepairActorRole)) {
          throw new AppError(
            ERROR_CODES.INVALID_PAYLOAD,
            400,
            `--actor-role must be one of: ${REPAIR_ACTOR_ROLES.join(", ")}.`
          );
        }
        options.actorRole = raw as RepairActorRole;
        break;
      }
      default:
        throw new AppError(ERROR_CODES.INVALID_PAYLOAD, 400, `Unknown argument "${arg}".`);
    }
  }

  return options;
}

export async function loadRepairDataSource(
  inputPath?: string
): Promise<{ dataSource: RepairDataSource; prisma?: PrismaClient }> {
  if (!inputPath) {
    const prisma = new PrismaClient();
    return { dataSource: new PrismaRepairDataSource(prisma), prisma };
  }

  const raw = await readFile(resolve(inputPath), "utf8");
  const parsed = JSON.parse(raw) as RepairInputFile;
  const dataSource = new InMemoryRepairDataSource();
  dataSource.actions = (parsed.actions ?? []).map((record) => ({
    ...record,
    updatedAt: new Date(record.updatedAt)
  }));
  dataSource.events = (parsed.events ?? []).map((record) => ({
    ...record,
    receivedAt: new Date(record.receivedAt)
  }));
  dataSource.settlements = (parsed.settlements ?? []).map((record) => ({
    ...record,
    updatedAt: new Date(record.updatedAt)
  }));
  return { dataSource };
}

export async function runOrphanRepairCommand(
  options: OrphanRepairCliOptions,
  dependencies: OrphanRepairDependencies = {}
): Promise<RepairCheckpoint | RepairCheckpoint[] | null> {
  const actorRole = options.actorRole ?? "viewer";
  const mutation = options.command === "start" || options.command === "resume";
  authorizeRepairActor(actorRole, { mutation });

  const checkpointStore =
    dependencies.checkpointStore ??
    new FileRepairCheckpointStore(options.checkpointDir ?? DEFAULT_CHECKPOINT_DIR);

  if (options.command === "status") {
    if (!options.jobId) {
      throw new AppError(ERROR_CODES.INVALID_PAYLOAD, 400, "--job-id is required with --status.");
    }
    return checkpointStore.get(options.jobId);
  }

  if (options.command === "list") {
    return checkpointStore.list({ limit: 50 });
  }

  let createdPrisma: PrismaClient | undefined;
  try {
    let engine = dependencies.engine;
    if (!engine) {
      let dataSource = dependencies.dataSource;
      if (!dataSource) {
        const loaded = await loadRepairDataSource(options.input);
        dataSource = loaded.dataSource;
        createdPrisma = loaded.prisma;
      }
      engine = new ResumableRepairEngine({ dataSource, checkpointStore });
    }

    if (options.command === "resume") {
      if (!options.jobId) {
        throw new AppError(ERROR_CODES.INVALID_PAYLOAD, 400, "--job-id is required with --resume.");
      }
      return engine.resumeJob(options.jobId, { batchSize: options.batchSize });
    }

    const startOptions: StartRepairOptions = {
      dryRun: options.dryRun ?? false,
      batchSize: options.batchSize,
      phases: options.phases
    };
    return engine.startJob(startOptions);
  } finally {
    if (createdPrisma) {
      await createdPrisma.$disconnect();
    }
  }
}

export function formatCheckpoint(checkpoint: RepairCheckpoint): string {
  const breakdown = Object.entries(checkpoint.stats.phaseBreakdown)
    .map(
      ([phase, stats]) =>
        `  ${phase}: scanned=${stats.scanned} repaired=${stats.repaired} failed=${stats.failed}`
    )
    .join("\n");

  return [
    `Repair job: ${checkpoint.jobId}`,
    `Status: ${checkpoint.status}`,
    `Phase: ${checkpoint.currentPhase}`,
    `Cursor: ${checkpoint.cursor ?? "(start)"}`,
    `Dry run: ${checkpoint.dryRun}`,
    `Batch size: ${checkpoint.batchSize}`,
    `Scanned: ${checkpoint.stats.scannedCount}`,
    `Repaired: ${checkpoint.stats.repairedCount}`,
    `Failed: ${checkpoint.stats.failedCount}`,
    "Phase breakdown:",
    breakdown,
    `Errors: ${checkpoint.errors.length}`,
    `Created: ${checkpoint.createdAt}`,
    `Updated: ${checkpoint.updatedAt}`,
    checkpoint.completedAt ? `Completed: ${checkpoint.completedAt}` : "",
    checkpoint.lastError ? `Last error: ${checkpoint.lastError}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const result = await runOrphanRepairCommand(options);

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (Array.isArray(result)) {
    if (result.length === 0) {
      console.log("No repair checkpoints found.");
      return;
    }
    for (const checkpoint of result) {
      console.log(formatCheckpoint(checkpoint));
      console.log("---");
    }
    return;
  }

  if (!result) {
    console.log("No repair checkpoint found.");
    return;
  }

  console.log(formatCheckpoint(result));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then(() => process.exit(0))
    .catch((err: any) => {
      const statusCode = typeof err?.statusCode === "number" ? err.statusCode : 1;
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(statusCode >= 400 && statusCode < 500 ? 2 : 1);
    });
}
