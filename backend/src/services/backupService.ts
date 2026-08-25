/**
 * PostgreSQL backup service (issue #275).
 *
 * Shells out to `pg_dump` to create a compressed SQL dump of the database,
 * writes it to a configurable directory, and prunes files older than a
 * retention window.
 *
 * All external I/O (spawn, fs operations) is injected so the service is fully
 * unit-testable without a real database or filesystem.
 */

import { join } from "node:path";
import type { Logger } from "pino";

// ─── Injectable I/O interfaces ────────────────────────────────────────────────

export interface SpawnResult {
  exitCode: number;
  stderr: string;
}

/**
 * Minimal subset of `child_process.spawn` used by BackupService.
 * The default implementation wraps Node's built-in `spawn`.
 */
export type SpawnFn = (
  command: string,
  args: string[],
  env: Record<string, string | undefined>
) => Promise<SpawnResult>;

export interface FsAdapter {
  /** Create directory (and parents) if it does not exist. */
  mkdir(dir: string): Promise<void>;
  /** Write text content to a file path. */
  writeFile(path: string, content: string): Promise<void>;
  /** List file names in a directory. */
  readdir(dir: string): Promise<string[]>;
  /** Get the modification time of a file. Returns null on error. */
  mtimeMs(path: string): Promise<number | null>;
  /** Delete a file. */
  unlink(path: string): Promise<void>;
}

// ─── Defaults using Node builtins ─────────────────────────────────────────────

export function defaultSpawn(
  command: string,
  args: string[],
  env: Record<string, string | undefined>
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    // Dynamic import so the module can be loaded in test environments that
    // stub the entire spawn function.
    import("node:child_process").then(({ spawn }) => {
      const proc = spawn(command, args, {
        env: { ...process.env, ...env },
        stdio: ["ignore", "ignore", "pipe"]
      });

      const stderrChunks: Buffer[] = [];
      proc.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

      proc.on("close", (code) => {
        resolve({
          exitCode: code ?? 1,
          stderr: Buffer.concat(stderrChunks).toString("utf8").trim()
        });
      });
    });
  });
}

import { mkdir, writeFile, readdir, stat, unlink } from "node:fs/promises";

export const defaultFsAdapter: FsAdapter = {
  async mkdir(dir) {
    await mkdir(dir, { recursive: true });
  },
  async writeFile(path, content) {
    await writeFile(path, content, "utf8");
  },
  async readdir(dir) {
    return readdir(dir);
  },
  async mtimeMs(path) {
    try {
      const s = await stat(path);
      return s.mtimeMs;
    } catch {
      return null;
    }
  },
  async unlink(path) {
    await unlink(path);
  }
};

// ─── BackupResult ─────────────────────────────────────────────────────────────

export interface BackupResult {
  /** Absolute path of the created dump file. */
  filePath: string;
  /** Bytes written (0 when content is a shell command output rather than direct write). */
  durationMs: number;
  /** Number of old backup files pruned during this run. */
  pruned: number;
}

// ─── BackupServiceOptions ─────────────────────────────────────────────────────

export interface BackupServiceOptions {
  /** Absolute path to the directory where dumps are stored. */
  backupDir: string;
  /**
   * Full PostgreSQL connection string.
   * Parsed to extract host, port, database, username, and password.
   */
  databaseUrl: string;
  /**
   * Retain backup files created within this many days.
   * Files older than this are deleted during each `run()` call.
   * @default 7
   */
  retainDays?: number;
  /** Path to the `pg_dump` binary. @default "pg_dump" */
  pgDumpPath?: string;
  logger?: Logger;
  /** Injected spawn — override in tests. */
  spawn?: SpawnFn;
  /** Injected fs adapter — override in tests. */
  fs?: FsAdapter;
  /** Override current time for retention calculations (tests). */
  now?: () => Date;
}

// ─── BackupService ────────────────────────────────────────────────────────────

/**
 * Runs a `pg_dump` backup and prunes files beyond the retention window.
 */
export class BackupService {
  private readonly backupDir: string;
  private readonly databaseUrl: string;
  private readonly retainDays: number;
  private readonly pgDumpPath: string;
  private readonly logger?: Logger;
  private readonly spawn: SpawnFn;
  private readonly fs: FsAdapter;
  private readonly now: () => Date;

  constructor(opts: BackupServiceOptions) {
    this.backupDir = opts.backupDir;
    this.databaseUrl = opts.databaseUrl;
    this.retainDays = opts.retainDays ?? 7;
    this.pgDumpPath = opts.pgDumpPath ?? "pg_dump";
    this.logger = opts.logger;
    this.spawn = opts.spawn ?? defaultSpawn;
    this.fs = opts.fs ?? defaultFsAdapter;
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * Runs one backup cycle:
   *  1. Ensures the backup directory exists.
   *  2. Runs `pg_dump` with the parsed connection details.
   *  3. Prunes backup files older than `retainDays`.
   *
   * @returns Metadata about the completed backup.
   * @throws  If `pg_dump` exits with a non-zero code.
   */
  async run(): Promise<BackupResult> {
    const start = Date.now();

    await this.fs.mkdir(this.backupDir);

    const filename = this.buildFilename();
    const filePath = join(this.backupDir, filename);

    const { pgEnv, pgArgs } = this.buildPgDumpArgs(filePath);

    this.logger?.info({ filePath }, "backup: starting pg_dump");

    const { exitCode, stderr } = await this.spawn(this.pgDumpPath, pgArgs, pgEnv);

    if (exitCode !== 0) {
      this.logger?.error({ exitCode, stderr }, "backup: pg_dump failed");
      throw new Error(`pg_dump exited with code ${exitCode}: ${stderr}`);
    }

    const durationMs = Date.now() - start;
    this.logger?.info({ filePath, durationMs }, "backup: pg_dump succeeded");

    const pruned = await this.pruneOldBackups();

    return { filePath, durationMs, pruned };
  }

  /**
   * Generates a timestamped filename for the dump.
   * Format: `backup-YYYY-MM-DDTHH-MM-SS.sql.gz`
   */
  buildFilename(): string {
    const ts = this.now()
      .toISOString()
      .replace(/:/g, "-")
      .replace(/\..+$/, "");
    return `backup-${ts}.sql.gz`;
  }

  /**
   * Deletes backup files in `backupDir` whose modification time is older than
   * `retainDays`. Only files matching the `backup-*.sql.gz` pattern are touched.
   */
  async pruneOldBackups(): Promise<number> {
    const cutoffMs = this.now().getTime() - this.retainDays * 24 * 60 * 60 * 1000;
    let pruned = 0;

    let entries: string[];
    try {
      entries = await this.fs.readdir(this.backupDir);
    } catch {
      return 0;
    }

    for (const entry of entries) {
      if (!entry.startsWith("backup-") || !entry.endsWith(".sql.gz")) continue;

      const fullPath = join(this.backupDir, entry);
      const mtime = await this.fs.mtimeMs(fullPath);

      if (mtime !== null && mtime < cutoffMs) {
        try {
          await this.fs.unlink(fullPath);
          pruned += 1;
          this.logger?.info({ file: entry }, "backup: pruned old backup");
        } catch (err) {
          this.logger?.warn({ err, file: entry }, "backup: failed to prune file");
        }
      }
    }

    return pruned;
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  /**
   * Parses `databaseUrl` into `pg_dump` CLI arguments and the `PGPASSWORD`
   * env var so credentials are never passed on the command line.
   *
   * Supported formats:
   *   postgres://user:pass@host:port/dbname
   *   postgresql://user:pass@host:port/dbname
   */
  private buildPgDumpArgs(outputPath: string): {
    pgArgs: string[];
    pgEnv: Record<string, string | undefined>;
  } {
    const url = new URL(this.databaseUrl);

    const host = url.hostname || "localhost";
    const port = url.port || "5432";
    const database = url.pathname.replace(/^\//, "") || "postgres";
    const username = url.username || "postgres";
    const password = decodeURIComponent(url.password || "");

    const pgArgs = [
      "--host", host,
      "--port", port,
      "--username", username,
      "--dbname", database,
      "--format", "custom",   // pg_restore-compatible compressed format
      "--no-password",        // read password from env only
      "--file", outputPath
    ];

    const pgEnv: Record<string, string | undefined> = {
      PGPASSWORD: password || undefined
    };

    return { pgArgs, pgEnv };
  }
}
