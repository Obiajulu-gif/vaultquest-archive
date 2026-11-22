import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileRepairCheckpointStore,
  InMemoryRepairCheckpointStore,
  InMemoryRepairDataSource,
  type RepairCheckpoint
} from "../src/services/resumableRepairJob.js";
import {
  authorizeRepairActor,
  parseArgs,
  runOrphanRepairCommand
} from "../src/scripts/orphanRepair.js";

const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);

function action(id: string) {
  return {
    id,
    status: "submitted",
    txHash: `0x${id}`,
    updatedAt: twoHoursAgo
  };
}

function baseCheckpoint(jobId: string): RepairCheckpoint {
  const now = new Date().toISOString();
  return {
    jobId,
    currentPhase: "orphaned_actions",
    cursor: null,
    dryRun: false,
    batchSize: 50,
    status: "running",
    stats: {
      scannedCount: 0,
      repairedCount: 0,
      failedCount: 0,
      phaseBreakdown: {
        orphaned_actions: { scanned: 0, repaired: 0, failed: 0 },
        stale_pending_events: { scanned: 0, repaired: 0, failed: 0 },
        unresolved_settlements: { scanned: 0, repaired: 0, failed: 0 }
      }
    },
    errors: [],
    createdAt: now,
    updatedAt: now
  };
}

describe("resumable orphan-repair command with checkpoints (#1149)", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "orphan-repair-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("persists checkpoints atomically and rejects path traversal job ids", async () => {
    const store = new FileRepairCheckpointStore(directory);
    const checkpoint = baseCheckpoint("job-1");

    await store.save(checkpoint);

    const loaded = await store.get("job-1");
    expect(loaded?.jobId).toBe("job-1");
    expect(loaded?.status).toBe("running");

    const listed = await store.list();
    expect(listed).toHaveLength(1);
    expect(listed[0].jobId).toBe("job-1");

    await expect(store.get("../escape")).rejects.toThrow(/Invalid repair job id/);
    await expect(store.save(baseCheckpoint("../escape"))).rejects.toThrow(/Invalid repair job id/);
  });

  it("authorizes mutations for admin/operator and read-only inspection for auditor", () => {
    expect(authorizeRepairActor("admin", { mutation: true })).toBe("admin");
    expect(authorizeRepairActor("operator", { mutation: true })).toBe("operator");
    expect(authorizeRepairActor("auditor", { mutation: false })).toBe("auditor");

    expect(() => authorizeRepairActor("auditor", { mutation: true })).toThrow(/cannot start or resume/);
    expect(() => authorizeRepairActor("viewer", { mutation: false })).toThrow(/cannot inspect/);
  });

  it("parses resume/status flags and validates batch size and phases", () => {
    const parsed = parseArgs([
      "--resume",
      "--job-id",
      "job-1",
      "--actor-role",
      "admin",
      "--batch-size",
      "25",
      "--phases",
      "orphaned_actions,unresolved_settlements",
      "--checkpoint-dir",
      directory,
      "--json"
    ]);

    expect(parsed.command).toBe("resume");
    expect(parsed.jobId).toBe("job-1");
    expect(parsed.actorRole).toBe("admin");
    expect(parsed.batchSize).toBe(25);
    expect(parsed.phases).toEqual(["orphaned_actions", "unresolved_settlements"]);
    expect(parsed.json).toBe(true);

    expect(() => parseArgs(["--batch-size", "0"])).toThrow(/batch-size/);
    expect(() => parseArgs(["--phases", "not_a_phase"])).toThrow(/Unknown repair phase/);
    expect(() => parseArgs(["--actor-role", "root"])).toThrow(/actor-role/);
  });

  it("runs a dry-run from an input file without mutating records", async () => {
    const input = join(directory, "input.json");
    await writeFile(
      input,
      JSON.stringify({
        actions: [{ ...action("10000000-0000-4000-8000-000000000001"), updatedAt: twoHoursAgo.toISOString() }],
        events: [{ txHash: "0xevent", statusHint: "confirmed", receivedAt: twoHoursAgo.toISOString() }],
        settlements: [
          {
            id: "20000000-0000-4000-8000-000000000001",
            vaultId: "vault-1",
            state: "Unresolved",
            attempts: 2,
            updatedAt: twoHoursAgo.toISOString()
          }
        ]
      }),
      "utf8"
    );

    const result = await runOrphanRepairCommand(
      {
        command: "start",
        actorRole: "operator",
        dryRun: true,
        checkpointDir: directory,
        input
      },
      { checkpointStore: new FileRepairCheckpointStore(directory) }
    );

    expect(Array.isArray(result)).toBe(false);
    const checkpoint = result as RepairCheckpoint;
    expect(checkpoint.status).toBe("completed");
    expect(checkpoint.dryRun).toBe(true);
    expect(checkpoint.stats.scannedCount).toBe(3);
    expect(checkpoint.stats.repairedCount).toBe(3);

    const persisted = await new FileRepairCheckpointStore(directory).get(checkpoint.jobId);
    expect(persisted?.status).toBe("completed");
  });

  it("isolates a failed record and retries it when the job is resumed", async () => {
    const dataSource = new InMemoryRepairDataSource();
    dataSource.actions = [
      action("10000000-0000-4000-8000-000000000001"),
      action("10000000-0000-4000-8000-000000000002"),
      action("10000000-0000-4000-8000-000000000003")
    ];

    let failSecond = true;
    const originalRepair = dataSource.repairAction.bind(dataSource);
    dataSource.repairAction = async (id, status, reason) => {
      if (failSecond && id.endsWith("002")) {
        throw new Error("transient row lock");
      }
      return originalRepair(id, status, reason);
    };

    const checkpointStore = new InMemoryRepairCheckpointStore();
    const first = (await runOrphanRepairCommand(
      {
        command: "start",
        actorRole: "operator",
        batchSize: 1,
        phases: ["orphaned_actions"]
      },
      { dataSource, checkpointStore }
    )) as RepairCheckpoint;

    expect(first.status).toBe("completed");
    expect(first.stats.failedCount).toBe(1);
    expect(first.errors[0].recordId).toContain("002");
    expect(dataSource.actions[1].status).toBe("submitted");

    failSecond = false;
    await checkpointStore.save({
      ...first,
      status: "paused",
      cursor: "10000000-0000-4000-8000-000000000001"
    });

    const resumed = (await runOrphanRepairCommand(
      {
        command: "resume",
        jobId: first.jobId,
        actorRole: "admin",
        batchSize: 1
      },
      { dataSource, checkpointStore }
    )) as RepairCheckpoint;

    expect(resumed.status).toBe("completed");
    expect(resumed.stats.failedCount).toBe(1);
    expect(dataSource.actions.every((record) => record.status === "orphaned")).toBe(true);
  });

  it("returns a checkpoint by id and rejects unauthorized viewers", async () => {
    const checkpointStore = new InMemoryRepairCheckpointStore();
    const checkpoint = baseCheckpoint("job-42");
    await checkpointStore.save(checkpoint);

    const found = await runOrphanRepairCommand(
      { command: "status", jobId: "job-42", actorRole: "auditor" },
      { checkpointStore }
    );
    expect((found as RepairCheckpoint).jobId).toBe("job-42");

    await expect(
      runOrphanRepairCommand({ command: "status", jobId: "job-42", actorRole: "viewer" }, { checkpointStore })
    ).rejects.toThrow(/cannot inspect/);
  });
});
