import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { requirePermission, walletSessionResolver } from "../src/middleware/rbac.js";
import { importsRoutes } from "../src/routes/imports.js";
import { DataImportService, IMPORT_FORMAT_VERSION, IMPORT_MAX_ROWS, type ImportTarget } from "../src/services/dataImport.js";

const WALLET = "GALICE";

const row = (id: string, over: Record<string, unknown> = {}) => ({
  pool_id: id,
  pool_name: `Pool ${id}`,
  status: "open",
  tvl: "100",
  asset: "USDC",
  participant_count: 3,
  expected_yield: "4%",
  prize: null,
  opens_at: null,
  locks_at: null,
  draws_at: "2026-02-01T00:00:00.000Z",
  ...over,
});

const stored = (id: string, over: Record<string, unknown> = {}) => ({
  id: `r-${id}`,
  walletAddress: WALLET,
  poolId: id,
  poolName: `Pool ${id}`,
  status: "open",
  tvl: "100",
  asset: "USDC",
  participantCount: 3,
  expectedYield: "4%",
  prize: null,
  opensAt: null,
  locksAt: null,
  drawsAt: new Date("2026-02-01T00:00:00.000Z"),
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

/** Stateful in-memory target that counts writes. */
function target(initial: any[] = [], failOn: string[] = []) {
  const db = new Map<string, any>(initial.map((r) => [r.poolId, r]));
  const t = {
    writes: 0,
    findByPoolIds: vi.fn(async (_w: string, ids: string[]) => ids.flatMap((id) => (db.has(id) ? [db.get(id)] : []))),
    savePool: vi.fn(async (input: any) => {
      if (failOn.includes(input.pool.poolId)) throw new Error("db down");
      t.writes += 1;
      const created = !db.has(input.pool.poolId);
      const record = { ...stored(input.pool.poolId), ...input.pool };
      db.set(input.pool.poolId, record);
      return { record, created };
    }),
  };
  return t satisfies ImportTarget & { writes: number };
}

describe("DataImportService", () => {
  it("dry run classifies rows and performs no writes", async () => {
    const t = target([stored("same"), stored("changed")]);
    const report = await new DataImportService(t).run({
      wallet: WALLET,
      dryRun: true,
      records: [row("new"), row("same"), row("changed", { tvl: "999" })],
    });
    expect(report.dry_run).toBe(true);
    expect(report.summary).toEqual({ total: 3, create: 1, update: 1, skip: 1, error: 0 });
    expect(report.rows.map((r) => r.action)).toEqual(["create", "skip", "update"]);
    expect(t.savePool).not.toHaveBeenCalled();
    expect(t.writes).toBe(0);
    expect(report.rollback).toBeUndefined();
  });

  it("commit applies changes and reports rollback guidance", async () => {
    const t = target([stored("changed")]);
    const report = await new DataImportService(t).run({
      wallet: WALLET,
      dryRun: false,
      records: [row("new"), row("changed", { tvl: "999" })],
    });
    expect(report.summary).toMatchObject({ create: 1, update: 1, error: 0 });
    expect(report.rollback?.delete_pool_ids).toEqual(["new"]);
    expect(report.rollback?.restore_records).toEqual([expect.objectContaining({ pool_id: "changed", tvl: "100" })]);
  });

  it("is idempotent: re-running a committed import changes nothing", async () => {
    const t = target();
    const svc = new DataImportService(t);
    const records = [row("a"), row("b")];
    const first = await svc.run({ wallet: WALLET, dryRun: false, records });
    const second = await svc.run({ wallet: WALLET, dryRun: false, records });
    expect(first.summary).toMatchObject({ create: 2, skip: 0 });
    expect(second.summary).toMatchObject({ create: 0, update: 0, skip: 2 });
    expect(second.rows.every((r) => r.reason === "unchanged")).toBe(true);
    expect(t.writes).toBe(2);
  });

  it("reports invalid rows with field-level errors without blocking valid rows", async () => {
    const t = target();
    const report = await new DataImportService(t).run({
      wallet: WALLET,
      dryRun: false,
      records: [row("ok"), { pool_id: "bad", status: "nope" }, null, "junk", row("<b></b>", { pool_name: "<script>x</script>" })],
    });
    expect(report.summary).toMatchObject({ total: 5, create: 1, error: 4 });
    const bad = report.rows[1]!;
    expect(bad).toMatchObject({ action: "error", reason: "invalid", pool_id: "bad" });
    expect(bad.errors!.some((e) => e.startsWith("status"))).toBe(true);
    expect(report.rows[2]).toMatchObject({ pool_id: null, action: "error" });
    // sanitized-to-empty name is rejected rather than stored
    expect(report.rows[4]).toMatchObject({ action: "error", reason: "invalid" });
    expect(t.writes).toBe(1);
  });

  it("sanitizes markup out of stored text fields", async () => {
    const t = target();
    await new DataImportService(t).run({
      wallet: WALLET,
      dryRun: false,
      records: [row("x", { pool_name: "Nice <img src=x onerror=alert(1)> Pool" })],
    });
    expect(t.savePool.mock.calls[0]![0].pool.poolName).toBe("Nice Pool");
  });

  it("skips in-file duplicates (first occurrence wins)", async () => {
    const t = target();
    const report = await new DataImportService(t).run({
      wallet: WALLET,
      dryRun: false,
      records: [row("d", { tvl: "1" }), row("d", { tvl: "2" })],
    });
    expect(report.rows[1]).toMatchObject({ action: "skip", reason: "duplicate_in_file" });
    expect(t.savePool).toHaveBeenCalledTimes(1);
    expect(t.savePool.mock.calls[0]![0].pool.tvl).toBe("1");
  });

  it("handles partial write failure: other rows apply and the failure is reported", async () => {
    const t = target([], ["boom"]);
    const report = await new DataImportService(t).run({
      wallet: WALLET,
      dryRun: false,
      records: [row("a"), row("boom"), row("c")],
    });
    expect(report.summary).toMatchObject({ create: 2, error: 1 });
    expect(report.rows[1]).toMatchObject({ action: "error", reason: "write_failed", errors: ["A database error occurred"] });
    // rollback lists only what was actually created
    expect(report.rollback?.delete_pool_ids).toEqual(["a", "c"]);
  });

  it("does not write when every row is invalid or the import is empty", async () => {
    const t = target();
    const svc = new DataImportService(t);
    expect((await svc.run({ wallet: WALLET, dryRun: false, records: [] })).summary.total).toBe(0);
    expect((await svc.run({ wallet: WALLET, dryRun: false, records: [{}] })).summary.error).toBe(1);
    expect(t.savePool).not.toHaveBeenCalled();
  });

  it("rejects imports above the row limit", async () => {
    const records = Array.from({ length: IMPORT_MAX_ROWS + 1 }, (_, i) => row(`p${i}`));
    await expect(new DataImportService(target()).run({ wallet: WALLET, dryRun: true, records })).rejects.toMatchObject({
      statusCode: 400,
    });
  });
});

describe("POST /imports/saved-pools", () => {
  const walletAuth = {
    validateSession: vi.fn(async (t: string) => (t === "alice-token" ? { id: "1", walletAddress: WALLET } : null)),
  };
  function build(t = target()) {
    const app = Fastify();
    app.setErrorHandler(errorHandler as any);
    app.register(
      importsRoutes(new DataImportService(t), requirePermission("own.data.import", [walletSessionResolver(walletAuth)])),
    );
    return { app, t };
  }
  const post = (app: any, payload: unknown, token?: string) =>
    app.inject({ method: "POST", url: "/imports/saved-pools", payload, headers: token ? { authorization: `Bearer ${token}` } : {} });

  it("requires a valid wallet session", async () => {
    const { app, t } = build();
    expect((await post(app, { format_version: IMPORT_FORMAT_VERSION, records: [] })).statusCode).toBe(401);
    expect((await post(app, { format_version: IMPORT_FORMAT_VERSION, records: [] }, "forged")).statusCode).toBe(401);
    expect(t.savePool).not.toHaveBeenCalled();
  });

  it("defaults to a dry run", async () => {
    const { app, t } = build();
    const res = await post(app, { format_version: IMPORT_FORMAT_VERSION, records: [row("a")] }, "alice-token");
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ dry_run: true, wallet: WALLET, summary: { create: 1 } });
    expect(t.savePool).not.toHaveBeenCalled();
  });

  it("commits only with an explicit dry_run:false, always into the session wallet", async () => {
    const { app, t } = build();
    const res = await post(
      app,
      { format_version: IMPORT_FORMAT_VERSION, dry_run: false, wallet_address: "GVICTIM", records: [row("a")] },
      "alice-token",
    );
    expect(res.statusCode).toBe(200);
    expect(t.savePool.mock.calls[0]![0].walletAddress).toBe(WALLET);
  });

  it("rejects unsupported format versions and malformed bodies", async () => {
    const { app } = build();
    expect((await post(app, { format_version: "9.9.9", records: [] }, "alice-token")).statusCode).toBe(400);
    expect((await post(app, { format_version: IMPORT_FORMAT_VERSION }, "alice-token")).statusCode).toBe(400);
  });
});
