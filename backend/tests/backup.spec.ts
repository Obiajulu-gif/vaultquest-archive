/**
 * Unit tests for BackupService (issue #275).
 *
 * All external I/O (pg_dump spawn, filesystem operations) is injected so
 * no real database, pg_dump binary, or filesystem writes are needed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  BackupService,
  type SpawnFn,
  type FsAdapter
} from "../src/services/backupService.js";

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeSpawn(exitCode = 0, stderr = ""): SpawnFn {
  return vi.fn().mockResolvedValue({ exitCode, stderr });
}

function makeFs(overrides: Partial<FsAdapter> = {}): FsAdapter {
  return {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    readdir: vi.fn().mockResolvedValue([]),
    mtimeMs: vi.fn().mockResolvedValue(null),
    unlink: vi.fn().mockResolvedValue(undefined),
    ...overrides
  };
}

const DATABASE_URL = "postgres://user:secret@db.example.com:5432/vaultquest";
const BACKUP_DIR = "/backups";

// Fixed timestamp for deterministic filename assertions
const FIXED_NOW = new Date("2026-06-28T02:00:00.000Z");

// ─── BackupService.run() ──────────────────────────────────────────────────────

describe("BackupService.run()", () => {
  it("creates the backup directory and calls pg_dump with correct args", async () => {
    const spawn = makeSpawn(0);
    const fs = makeFs();

    const svc = new BackupService({
      backupDir: BACKUP_DIR,
      databaseUrl: DATABASE_URL,
      spawn,
      fs,
      now: () => FIXED_NOW
    });

    const result = await svc.run();

    // Directory was ensured
    expect(fs.mkdir).toHaveBeenCalledWith(BACKUP_DIR);

    // pg_dump was invoked once
    expect(spawn).toHaveBeenCalledTimes(1);
    const [cmd, args, env] = (spawn as ReturnType<typeof vi.fn>).mock.calls[0];

    expect(cmd).toBe("pg_dump");

    // Connection arguments
    expect(args).toContain("--host");
    expect(args).toContain("db.example.com");
    expect(args).toContain("--port");
    expect(args).toContain("5432");
    expect(args).toContain("--username");
    expect(args).toContain("user");
    expect(args).toContain("--dbname");
    expect(args).toContain("vaultquest");

    // Output path contains backup dir and timestamp filename
    expect(args).toContain("--file");
    const fileIdx = args.indexOf("--file");
    expect(args[fileIdx + 1]).toContain(BACKUP_DIR);
    expect(args[fileIdx + 1]).toMatch(/backup-2026-06-28T02-00-00\.sql\.gz$/);

    // Password passed via env, not CLI
    expect(env.PGPASSWORD).toBe("secret");

    // Result shape
    expect(result.filePath).toMatch(/backup-2026-06-28T02-00-00\.sql\.gz$/);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.pruned).toBe(0);
  });

  it("uses a custom pg_dump path when pgDumpPath is provided", async () => {
    const spawn = makeSpawn(0);
    const svc = new BackupService({
      backupDir: BACKUP_DIR,
      databaseUrl: DATABASE_URL,
      pgDumpPath: "/usr/local/bin/pg_dump",
      spawn,
      fs: makeFs(),
      now: () => FIXED_NOW
    });

    await svc.run();

    const [cmd] = (spawn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(cmd).toBe("/usr/local/bin/pg_dump");
  });

  it("throws when pg_dump exits with a non-zero code", async () => {
    const svc = new BackupService({
      backupDir: BACKUP_DIR,
      databaseUrl: DATABASE_URL,
      spawn: makeSpawn(1, "connection refused"),
      fs: makeFs(),
      now: () => FIXED_NOW
    });

    await expect(svc.run()).rejects.toThrow("pg_dump exited with code 1");
  });

  it("does not include password in CLI args (only in env)", async () => {
    const spawn = makeSpawn(0);
    const svc = new BackupService({
      backupDir: BACKUP_DIR,
      databaseUrl: DATABASE_URL,
      spawn,
      fs: makeFs(),
      now: () => FIXED_NOW
    });

    await svc.run();

    const [, args] = (spawn as ReturnType<typeof vi.fn>).mock.calls[0];
    // No argument should contain the raw password
    for (const arg of args as string[]) {
      expect(arg).not.toContain("secret");
    }
  });

  it("handles DATABASE_URL with no password gracefully", async () => {
    const spawn = makeSpawn(0);
    const svc = new BackupService({
      backupDir: BACKUP_DIR,
      databaseUrl: "postgres://user@localhost/vaultquest",
      spawn,
      fs: makeFs(),
      now: () => FIXED_NOW
    });

    await svc.run();

    const [, , env] = (spawn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(env.PGPASSWORD).toBeUndefined();
  });
});

// ─── BackupService.buildFilename() ───────────────────────────────────────────

describe("BackupService.buildFilename()", () => {
  it("generates a timestamped .sql.gz filename", () => {
    const svc = new BackupService({
      backupDir: BACKUP_DIR,
      databaseUrl: DATABASE_URL,
      now: () => FIXED_NOW
    });

    const name = svc.buildFilename();
    expect(name).toBe("backup-2026-06-28T02-00-00.sql.gz");
  });

  it("replaces colons in ISO timestamps with dashes", () => {
    const svc = new BackupService({
      backupDir: BACKUP_DIR,
      databaseUrl: DATABASE_URL,
      now: () => new Date("2026-12-31T23:59:59.000Z")
    });
    expect(svc.buildFilename()).toBe("backup-2026-12-31T23-59-59.sql.gz");
  });
});

// ─── BackupService.pruneOldBackups() ─────────────────────────────────────────

describe("BackupService.pruneOldBackups()", () => {
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;

  it("deletes backup files older than retainDays", async () => {
    const retainDays = 7;
    const now = FIXED_NOW;
    const oldMtime = now.getTime() - retainDays * ONE_DAY_MS - 1; // 1ms past cutoff
    const freshMtime = now.getTime() - ONE_DAY_MS; // 1 day old — within window

    const fs = makeFs({
      readdir: vi.fn().mockResolvedValue([
        "backup-2026-06-20T02-00-00.sql.gz", // old
        "backup-2026-06-27T02-00-00.sql.gz", // fresh
        "unrelated-file.txt"                 // should be ignored
      ]),
      mtimeMs: vi.fn().mockImplementation(async (p: string) => {
        if (p.includes("2026-06-20")) return oldMtime;
        if (p.includes("2026-06-27")) return freshMtime;
        return null;
      })
    });

    const svc = new BackupService({
      backupDir: BACKUP_DIR,
      databaseUrl: DATABASE_URL,
      retainDays,
      fs,
      now: () => now
    });

    const pruned = await svc.pruneOldBackups();

    expect(pruned).toBe(1);
    expect(fs.unlink).toHaveBeenCalledTimes(1);
    const [deletedPath] = (fs.unlink as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(deletedPath).toContain("2026-06-20");
    expect(fs.unlink).not.toHaveBeenCalledWith(expect.stringContaining("2026-06-27"));
  });

  it("ignores non-backup files", async () => {
    const fs = makeFs({
      readdir: vi.fn().mockResolvedValue([
        "README.md",
        "latest.sql",
        "backup-2026-06-20T02-00-00.sql.gz"
      ]),
      mtimeMs: vi.fn().mockResolvedValue(0) // far in past
    });

    const svc = new BackupService({
      backupDir: BACKUP_DIR,
      databaseUrl: DATABASE_URL,
      retainDays: 7,
      fs,
      now: () => FIXED_NOW
    });

    const pruned = await svc.pruneOldBackups();

    // Only the matching backup file gets removed
    expect(pruned).toBe(1);
    const deletedPaths = (fs.unlink as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: string[]) => c[0]
    );
    expect(deletedPaths.every((p: string) => p.endsWith(".sql.gz"))).toBe(true);
  });

  it("returns 0 when no files exceed the retention window", async () => {
    const now = FIXED_NOW;
    const freshMtime = now.getTime() - ONE_DAY_MS;

    const fs = makeFs({
      readdir: vi.fn().mockResolvedValue(["backup-2026-06-27T02-00-00.sql.gz"]),
      mtimeMs: vi.fn().mockResolvedValue(freshMtime)
    });

    const svc = new BackupService({
      backupDir: BACKUP_DIR,
      databaseUrl: DATABASE_URL,
      retainDays: 7,
      fs,
      now: () => now
    });

    const pruned = await svc.pruneOldBackups();
    expect(pruned).toBe(0);
    expect(fs.unlink).not.toHaveBeenCalled();
  });

  it("returns 0 and does not throw when readdir fails", async () => {
    const fs = makeFs({
      readdir: vi.fn().mockRejectedValue(new Error("ENOENT"))
    });

    const svc = new BackupService({
      backupDir: BACKUP_DIR,
      databaseUrl: DATABASE_URL,
      fs,
      now: () => FIXED_NOW
    });

    await expect(svc.pruneOldBackups()).resolves.toBe(0);
  });

  it("continues pruning after an individual unlink failure", async () => {
    const now = FIXED_NOW;
    const oldMtime = 0; // epoch = always old

    const fs = makeFs({
      readdir: vi.fn().mockResolvedValue([
        "backup-2026-06-01T02-00-00.sql.gz",
        "backup-2026-06-02T02-00-00.sql.gz"
      ]),
      mtimeMs: vi.fn().mockResolvedValue(oldMtime),
      unlink: vi
        .fn()
        .mockRejectedValueOnce(new Error("EPERM"))
        .mockResolvedValueOnce(undefined)
    });

    const svc = new BackupService({
      backupDir: BACKUP_DIR,
      databaseUrl: DATABASE_URL,
      retainDays: 7,
      fs,
      now: () => now
    });

    // Should not throw; failed unlink is logged and skipped
    const pruned = await svc.pruneOldBackups();
    expect(pruned).toBe(1); // only the second file was successfully deleted
  });
});

// ─── startBackupCron wiring (light smoke) ─────────────────────────────────────

describe("startBackupCron", () => {
  it("exports startBackupCron from cron.ts without error", async () => {
    const { startBackupCron } = await import("../src/cron.js");
    expect(typeof startBackupCron).toBe("function");
  });
});
