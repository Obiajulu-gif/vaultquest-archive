import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { requirePermission, walletSessionResolver } from "../src/middleware/rbac.js";
import type { Principal } from "../src/middleware/rbac.js";
import { exportsRoutes } from "../src/routes/exports.js";
import {
  DataExportService,
  EXPORT_RETENTION_HOURS,
  EXPORT_SCHEMA_VERSION,
  type ExportSource,
} from "../src/services/dataExport.js";

const ALICE = "GALICE";
const BOB = "GBOB";
const alice: Principal = { role: "user", subject: ALICE, walletAddress: ALICE };
const maintainer: Principal = { role: "maintainer", subject: "GADMIN", walletAddress: "GADMIN" };
const service: Principal = { role: "service", subject: "indexer" };

const action = (i: number, over: Record<string, unknown> = {}) => ({
  id: `a${i}`,
  idempotencyKey: `secret-key-${i}`,
  walletAddress: ALICE,
  actionType: "deposit",
  actionPayload: { vault_id: "v1", token: "USDC", amount: "10", memo: "private note" },
  verifiedPayload: null,
  status: "confirmed",
  txHash: `tx${i}`,
  sorobanEventId: null,
  correlationId: `corr-${i}`,
  errorCode: null,
  errorDetail: "internal detail",
  retryCount: 0,
  redactedAt: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  submittedAt: null,
  confirmedAt: null,
  ...over,
});
const pool = (id: string) => ({
  id: `row-${id}`,
  walletAddress: ALICE,
  poolId: id,
  poolName: "P",
  status: "open",
  tvl: "1",
  asset: "USDC",
  participantCount: 1,
  expectedYield: "4%",
  prize: null,
  opensAt: null,
  locksAt: null,
  drawsAt: new Date("2026-02-01T00:00:00Z"),
  createdAt: new Date(),
  updatedAt: new Date(),
});

/** In-memory paged source keyed by wallet, honouring cursor+limit like Prisma. */
function source(actions: any[], pools: any[]): ExportSource & { calls: string[] } {
  const calls: string[] = [];
  const paged = <T extends { id: string; walletAddress: string }>(rows: T[], wallet: string, cursor: string | null, limit: number) => {
    calls.push(wallet);
    const mine = rows.filter((r) => r.walletAddress === wallet);
    const start = cursor ? mine.findIndex((r) => r.id === cursor) + 1 : 0;
    const slice = mine.slice(start, start + limit + 1);
    const hasMore = slice.length > limit;
    const items = hasMore ? slice.slice(0, limit) : slice;
    return { items, nextCursor: hasMore ? items[items.length - 1]!.id : null };
  };
  return {
    calls,
    listActions: async ({ walletAddress, cursor, limit }) => paged(actions, walletAddress, cursor, limit) as any,
    listSavedPools: async (w, c, l) => paged(pools, w, c, l) as any,
  };
}

describe("DataExportService", () => {
  const now = new Date("2026-03-01T12:00:00Z");

  it("includes schema version, generation metadata, retention expiry and checksum", async () => {
    const svc = new DataExportService(source([action(1)], [pool("p1")]));
    const { metadata, data } = await svc.build({ principal: alice, now });
    expect(metadata).toMatchObject({
      schema_version: EXPORT_SCHEMA_VERSION,
      generated_at: now.toISOString(),
      retention_hours: EXPORT_RETENTION_HOURS,
      wallet: ALICE,
      generated_by_role: "user",
      truncated: false,
      record_counts: { actions: 1, saved_pools: 1 },
    });
    expect(metadata.expires_at).toBe(new Date(now.getTime() + EXPORT_RETENTION_HOURS * 3_600_000).toISOString());
    expect(metadata.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(data.saved_pools).toHaveLength(1);
  });

  it("produces a stable checksum for identical data and a different one otherwise", async () => {
    const a = await new DataExportService(source([action(1)], [])).build({ principal: alice, now });
    const b = await new DataExportService(source([action(1)], [])).build({ principal: alice, now });
    const c = await new DataExportService(source([action(2)], [])).build({ principal: alice, now });
    expect(a.metadata.checksum).toBe(b.metadata.checksum);
    expect(a.metadata.checksum).not.toBe(c.metadata.checksum);
  });

  it("exports only allowlisted fields (no keys, correlation ids, memos or error detail)", async () => {
    const { data } = await new DataExportService(source([action(1)], [])).build({ principal: alice });
    const json = JSON.stringify(data);
    for (const leaked of ["secret-key-1", "corr-1", "private note", "internal detail", "idempotency"]) {
      expect(json).not.toContain(leaked);
    }
    expect(data.actions![0]).toMatchObject({ id: "a1", pool_id: "v1", asset: "USDC", amount: "10", tx_hash: "tx1" });
  });

  it("never exports scrubbed (redacted) rows", async () => {
    const rows = [action(1), action(2, { redactedAt: new Date() })];
    const { data } = await new DataExportService(source(rows, [])).build({ principal: alice, sections: ["actions"] });
    expect(data.actions).toHaveLength(1);
    expect(data.saved_pools).toBeUndefined();
  });

  it("projects sparse and fully-populated records without throwing", async () => {
    const sparse = action(1, { actionPayload: null, txHash: null, errorCode: null });
    const legacyKeys = action(2, {
      actionPayload: { pool_id: "legacy", asset: "XLM", amount: "5" },
      errorCode: "WALLET_REJECTED",
      submittedAt: new Date("2026-01-02T00:00:00Z"),
      confirmedAt: new Date("2026-01-03T00:00:00Z"),
    });
    const fullPool = {
      ...pool("p2"),
      prize: "1000 USDC",
      opensAt: new Date("2026-01-01T00:00:00Z"),
      locksAt: new Date("2026-01-15T00:00:00Z"),
    };
    const { data, metadata } = await new DataExportService(source([sparse, legacyKeys], [fullPool])).build({
      principal: alice,
    });
    expect(data.actions![0]).toMatchObject({ pool_id: "", asset: "", amount: "", tx_hash: "", error_code: "" });
    expect(data.actions![1]).toMatchObject({
      pool_id: "legacy",
      asset: "XLM",
      error_code: "WALLET_REJECTED",
      submitted_at: "2026-01-02T00:00:00.000Z",
      confirmed_at: "2026-01-03T00:00:00.000Z",
    });
    expect(data.saved_pools![0]).toMatchObject({
      prize: "1000 USDC",
      opens_at: "2026-01-01T00:00:00.000Z",
      locks_at: "2026-01-15T00:00:00.000Z",
    });
    // generated_at defaults to "now" when the caller doesn't supply a clock
    expect(Date.now() - Date.parse(metadata.generated_at)).toBeLessThan(5_000);
  });

  it("de-duplicates repeated sections", async () => {
    const { metadata } = await new DataExportService(source([action(1)], [])).build({
      principal: alice,
      sections: ["actions", "actions"],
    });
    expect(metadata.sections).toEqual(["actions"]);
  });

  it("handles an empty export", async () => {
    const { metadata, data } = await new DataExportService(source([], [])).build({ principal: alice });
    expect(data).toEqual({ actions: [], saved_pools: [] });
    expect(metadata.record_counts).toEqual({ actions: 0, saved_pools: 0 });
    expect(metadata.truncated).toBe(false);
  });

  it("pages through a large export across multiple pages", async () => {
    const rows = Array.from({ length: 1234 }, (_, i) => action(i));
    const src = source(rows, []);
    const { metadata, data } = await new DataExportService(src).build({ principal: alice, sections: ["actions"] });
    expect(data.actions).toHaveLength(1234);
    expect(src.calls.length).toBeGreaterThan(2);
    expect(metadata.truncated).toBe(false);
  });

  it("truncates at the per-section cap and says so", async () => {
    const rows = Array.from({ length: 50 }, (_, i) => action(i));
    const { metadata, data } = await new DataExportService(source(rows, [])).build({
      principal: alice,
      sections: ["actions"],
      maxRecords: 20,
    });
    expect(data.actions).toHaveLength(20);
    expect(metadata.truncated).toBe(true);
    expect(metadata.max_records_per_section).toBe(20);
  });

  it("denies exporting another wallet's data", async () => {
    const src = source([action(1)], []);
    await expect(new DataExportService(src).build({ principal: alice, wallet: BOB })).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(src.calls).toHaveLength(0); // authorization happens before any read
  });

  it("denies a service principal (no wallet, no export-any)", async () => {
    await expect(new DataExportService(source([], [])).build({ principal: service, wallet: ALICE })).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(new DataExportService(source([], [])).build({ principal: service })).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it("lets a maintainer export any wallet", async () => {
    const { metadata } = await new DataExportService(source([action(1)], [])).build({ principal: maintainer, wallet: ALICE });
    expect(metadata.wallet).toBe(ALICE);
    expect(metadata.generated_by_role).toBe("maintainer");
    expect(metadata.record_counts.actions).toBe(1);
  });
});

describe("GET /exports", () => {
  const sessions: Record<string, { id: string; walletAddress: string }> = {
    "alice-token": { id: "1", walletAddress: ALICE },
    "admin-token": { id: "2", walletAddress: "GADMIN" },
  };
  const walletAuth = { validateSession: vi.fn(async (t: string) => sessions[t] ?? null) };

  function build() {
    const app = Fastify();
    app.setErrorHandler(errorHandler as any);
    const svc = new DataExportService(source([action(1)], [pool("p1")]));
    app.register(
      exportsRoutes(svc, requirePermission("own.data.export", [walletSessionResolver(walletAuth, ["GADMIN"])])),
    );
    return app;
  }
  const get = (app: ReturnType<typeof build>, url: string, token?: string) =>
    app.inject({ method: "GET", url, headers: token ? { authorization: `Bearer ${token}` } : {} });

  it("requires authentication", async () => {
    const app = build();
    expect((await get(app, "/exports")).statusCode).toBe(401);
    expect((await get(app, "/exports", "forged")).statusCode).toBe(401);
  });

  it("returns the caller's own export as a no-store attachment", async () => {
    const app = build();
    const res = await get(app, "/exports", "alice-token");
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["content-disposition"]).toMatch(/^attachment; filename="vaultquest-export-.*\.json"$/);
    const body = res.json();
    expect(body.metadata.wallet).toBe(ALICE);
    expect(body.data.actions).toHaveLength(1);
  });

  it("filters sections and rejects unknown ones", async () => {
    const app = build();
    const ok = (await get(app, "/exports?sections=saved_pools", "alice-token")).json();
    expect(Object.keys(ok.data)).toEqual(["saved_pools"]);
    expect((await get(app, "/exports?sections=secrets", "alice-token")).statusCode).toBe(400);
  });

  it("denies a user requesting someone else's wallet, allows a maintainer", async () => {
    const app = build();
    expect((await get(app, `/exports?wallet=${BOB}`, "alice-token")).statusCode).toBe(403);
    expect((await get(app, `/exports?wallet=${ALICE}`, "admin-token")).statusCode).toBe(200);
  });
});
