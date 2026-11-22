/**
 * #983 — deterministic conflict resolution for multi-client saved-pool
 * edits: normal, failure, retry and authorization paths. Prisma is replaced
 * by an in-memory double that enforces the same compare-and-swap contract
 * as PostgreSQL (`update` whose `where.version` no longer matches throws
 * P2025), so contention can be injected deterministically.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { requirePermission, walletSessionResolver } from "../src/middleware/rbac.js";
import { savedPoolsRoutes, MAX_EDIT_CLOCK_SKEW_MS } from "../src/routes/savedPools.js";
import { SavedPoolsService } from "../src/services/savedPools.js";

const OWNER = "GOWNER";
const OTHER = "GOTHER";
const POOL = "pool-1";

type Row = Record<string, any>;

function fakePrisma() {
  const rows = new Map<string, Row>();
  const key = (w: { walletAddress: string; poolId: string }) => `${w.walletAddress}:${w.poolId}`;
  /** Runs once before the next update reaches the "database": a concurrent writer. */
  let interleave: (() => void) | null = null;
  const updates = vi.fn();

  const savedPool = {
    findUnique: vi.fn(async ({ where }: any) => {
      const row = rows.get(key(where.walletAddress_poolId));
      return row ? structuredClone(row) : null;
    }),
    create: vi.fn(async ({ data }: any) => {
      const row = { id: `id-${rows.size + 1}`, version: 0, fieldClocks: null, provenance: null, createdAt: new Date(), updatedAt: new Date(), ...data };
      rows.set(key(data), row);
      return structuredClone(row);
    }),
    update: vi.fn(async ({ where, data }: any) => {
      updates(data);
      const hook = interleave;
      interleave = null;
      hook?.();
      const k = key(where.walletAddress_poolId);
      const row = rows.get(k);
      if (!row || (where.version !== undefined && row.version !== where.version)) {
        throw new Prisma.PrismaClientKnownRequestError("Record to update not found.", { code: "P2025", clientVersion: "5.22.0" });
      }
      const next = { ...row, ...data, updatedAt: new Date() };
      rows.set(k, next);
      return structuredClone(next);
    }),
    deleteMany: vi.fn(async ({ where }: any) => ({ count: rows.delete(key(where)) ? 1 : 0 }))
  };

  return {
    prisma: { savedPool } as any,
    rows,
    updates,
    setInterleave: (fn: () => void) => (interleave = fn),
    bump: (changes: Row) => {
      const row = rows.get(`${OWNER}:${POOL}`)!;
      rows.set(`${OWNER}:${POOL}`, { ...row, ...changes, version: row.version + 1 });
    }
  };
}

const pool = (overrides: Partial<Record<string, unknown>> = {}) => ({
  poolId: POOL,
  poolName: "Pool",
  status: "open",
  tvl: "100",
  asset: "USDC",
  participantCount: 1,
  expectedYield: "4%",
  prize: null,
  opensAt: null,
  locksAt: null,
  drawsAt: null,
  ...overrides
});

async function seeded() {
  const db = fakePrisma();
  const svc = new SavedPoolsService(db.prisma);
  await svc.savePool({ walletAddress: OWNER, pool: pool() as any });
  return { db, svc };
}

const stamp = (at: number, clientId: string) => ({ at, clientId });

// ─── Service ──────────────────────────────────────────────────────────────────

describe("saved-pool edits — normal path (#983)", () => {
  it("applies an edit made against the current version and bumps the version", async () => {
    const { svc } = await seeded();
    const result = await svc.editPool({ walletAddress: OWNER, poolId: POOL, baseVersion: 0, stamp: stamp(10, "tab-a"), changes: { poolName: "Renamed" } });
    expect(result!.record).toMatchObject({ poolName: "Renamed", version: 1 });
    expect(result!.resolution).toMatchObject({ applied: ["poolName"], rejected: [] });
  });

  it("keeps both clients' changes when they edit different fields from the same version", async () => {
    const { svc } = await seeded();
    await svc.editPool({ walletAddress: OWNER, poolId: POOL, baseVersion: 0, stamp: stamp(10, "tab-a"), changes: { poolName: "A" } });
    const second = await svc.editPool({ walletAddress: OWNER, poolId: POOL, baseVersion: 0, stamp: stamp(5, "tab-b"), changes: { tvl: "900" } });
    expect(second!.record).toMatchObject({ poolName: "A", tvl: "900", version: 2 });
  });

  it("gives the same result whichever concurrent edit arrives first", async () => {
    const run = async (order: Array<"newer" | "older">) => {
      const { svc } = await seeded();
      const edits = {
        newer: { stamp: stamp(20, "phone"), changes: { status: "locked" } },
        older: { stamp: stamp(10, "laptop"), changes: { status: "drawing" } }
      };
      for (const name of order) await svc.editPool({ walletAddress: OWNER, poolId: POOL, baseVersion: 0, ...edits[name] });
      return (await svc.editPool({ walletAddress: OWNER, poolId: POOL, baseVersion: 0, stamp: stamp(0, "probe"), changes: {} }))!.record.status;
    };
    expect(await run(["newer", "older"])).toBe("locked");
    expect(await run(["older", "newer"])).toBe("locked");
  });
});

describe("saved-pool edits — failure path (#983)", () => {
  it("reports a losing concurrent edit instead of silently overwriting", async () => {
    const { svc, db } = await seeded();
    await svc.editPool({ walletAddress: OWNER, poolId: POOL, baseVersion: 0, stamp: stamp(20, "phone"), changes: { status: "locked" } });
    db.updates.mockClear();

    const lost = await svc.editPool({ walletAddress: OWNER, poolId: POOL, baseVersion: 0, stamp: stamp(10, "laptop"), changes: { status: "drawing" } });
    expect(lost!.resolution.rejected).toEqual([{ field: "status", winner: stamp(20, "phone") }]);
    expect(lost!.record).toMatchObject({ status: "locked", version: 1 });
    expect(db.updates).not.toHaveBeenCalled(); // nothing to write
  });

  it("returns null for a pool the wallet never saved", async () => {
    const { svc } = await seeded();
    expect(await svc.editPool({ walletAddress: OTHER, poolId: POOL, baseVersion: 0, stamp: stamp(1, "c"), changes: { tvl: "1" } })).toBeNull();
  });

  it("gives up with a conflict after repeated contention", async () => {
    const { svc, db } = await seeded();
    const keepWriting = () => {
      db.bump({ tvl: String(Math.random()) });
      db.setInterleave(keepWriting);
    };
    db.setInterleave(keepWriting);
    await expect(
      svc.editPool({ walletAddress: OWNER, poolId: POOL, baseVersion: 0, stamp: stamp(1, "c"), changes: { poolName: "x" } })
    ).rejects.toMatchObject({ code: "CONFLICT", statusCode: 409 });
  });
});

describe("saved-pool edits — retry path (#983)", () => {
  it("re-resolves against the fresh row when another write lands mid-edit", async () => {
    const { svc, db } = await seeded();
    // Another client (newer stamp) writes the same field between our read and our write.
    db.setInterleave(() => {
      const row = db.rows.get(`${OWNER}:${POOL}`)!;
      db.rows.set(`${OWNER}:${POOL}`, {
        ...row,
        tvl: "777",
        version: 1,
        fieldClocks: { tvl: { version: 1, stamp: stamp(50, "phone") } }
      });
    });
    const result = await svc.editPool({ walletAddress: OWNER, poolId: POOL, baseVersion: 0, stamp: stamp(10, "laptop"), changes: { tvl: "5", poolName: "B" } });

    expect(db.prisma.savedPool.findUnique).toHaveBeenCalledTimes(3); // seed + first attempt + retry
    expect(result!.record).toMatchObject({ tvl: "777", poolName: "B", version: 2 });
    expect(result!.resolution).toMatchObject({ applied: ["poolName"], rejected: [{ field: "tvl", winner: stamp(50, "phone") }] });
  });

  it("treats a client retry of an applied edit as a no-op", async () => {
    const { svc, db } = await seeded();
    const edit = { walletAddress: OWNER, poolId: POOL, baseVersion: 0, stamp: stamp(10, "tab-a"), changes: { poolName: "A" } };
    await svc.editPool(edit);
    db.updates.mockClear();

    const retry = await svc.editPool(edit);
    expect(retry!.resolution).toMatchObject({ applied: [], unchanged: ["poolName"], version: 1 });
    expect(db.updates).not.toHaveBeenCalled();
  });

  it("keeps the upsert's overwrite contract while versioning it, so an older edit cannot undo it", async () => {
    const { svc } = await seeded();
    const upserted = await svc.savePool({ walletAddress: OWNER, pool: pool({ status: "locked" }) as any });
    expect(upserted.record).toMatchObject({ status: "locked", version: 1 });

    const stale = await svc.editPool({ walletAddress: OWNER, poolId: POOL, baseVersion: 0, stamp: stamp(10, "laptop"), changes: { status: "drawing" } });
    expect(stale!.record.status).toBe("locked");
    expect(stale!.resolution.rejected.map((r) => r.field)).toEqual(["status"]);
  });
});

// ─── Routes ───────────────────────────────────────────────────────────────────

describe("PATCH /saved-pools/:poolId — authorization and validation (#983)", () => {
  const sessions: Record<string, { walletAddress: string }> = { "owner-token": { walletAddress: OWNER }, "other-token": { walletAddress: OTHER } };
  const principal = walletSessionResolver({ validateSession: async (t: string) => sessions[t] ?? null });

  async function app(): Promise<{ app: FastifyInstance; db: ReturnType<typeof fakePrisma> }> {
    const { db, svc } = await seeded();
    const instance = Fastify();
    instance.setErrorHandler(errorHandler as any);
    instance.register(savedPoolsRoutes(svc, requirePermission("own.data.write", [principal])));
    return { app: instance, db };
  }

  const patch = (a: FastifyInstance, token: string | null, payload: object) =>
    a.inject({
      method: "PATCH",
      url: `/saved-pools/${POOL}`,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      payload
    });

  const body = (overrides: object = {}) => ({
    base_version: 0,
    client_id: "tab-a",
    edited_at: new Date().toISOString(),
    changes: { pool_name: "Renamed" },
    ...overrides
  });

  it("requires a wallet session (401) and scopes the edit to the session's wallet", async () => {
    const { app: a, db } = await app();
    expect((await patch(a, null, body())).statusCode).toBe(401);
    expect((await patch(a, "forged", body())).statusCode).toBe(401);
    // Another wallet cannot reach the owner's record: its own lookup finds nothing.
    expect((await patch(a, "other-token", body())).statusCode).toBe(404);
    expect(db.rows.get(`${OWNER}:${POOL}`)!.poolName).toBe("Pool");
  });

  it("is not registered at all without a guard", async () => {
    const { svc } = await seeded();
    const unguarded = Fastify();
    unguarded.register(savedPoolsRoutes(svc));
    expect((await unguarded.inject({ method: "PATCH", url: `/saved-pools/${POOL}`, payload: body() })).statusCode).toBe(404);
  });

  it("applies the owner's edit and returns the resolution", async () => {
    const { app: a } = await app();
    const res = await patch(a, "owner-token", body({ changes: { pool_name: "Renamed", opens_at: "2026-11-01T00:00:00.000Z" } }));
    expect(res.statusCode).toBe(200);
    expect(res.json().data.saved).toMatchObject({ pool_name: "Renamed", opens_at: "2026-11-01T00:00:00.000Z", version: 1 });
    expect(res.json().data.resolution).toEqual({ version: 1, applied: ["opens_at", "pool_name"], rejected: [], unchanged: [] });
  });

  it("reports a rejected field with the winning edit's stamp", async () => {
    const { app: a } = await app();
    const now = Date.now();
    await patch(a, "owner-token", body({ client_id: "phone", edited_at: new Date(now).toISOString(), changes: { status: "locked" } }));
    const lost = await patch(a, "owner-token", body({ client_id: "laptop", edited_at: new Date(now - 60_000).toISOString(), changes: { status: "drawing" } }));
    expect(lost.json().data.resolution.rejected).toEqual([{ field: "status", winner: { edited_at: new Date(now).toISOString(), client_id: "phone" } }]);
  });

  it("rejects malformed edits and clock skew with 400", async () => {
    const { app: a } = await app();
    expect((await patch(a, "owner-token", body({ changes: {} }))).statusCode).toBe(400);
    expect((await patch(a, "owner-token", body({ changes: { pool_id: "other" } }))).statusCode).toBe(400);
    expect((await patch(a, "owner-token", body({ changes: { status: "not-a-state" } }))).statusCode).toBe(400);
    expect((await patch(a, "owner-token", body({ base_version: -1 }))).statusCode).toBe(400);
    const future = new Date(Date.now() + MAX_EDIT_CLOCK_SKEW_MS + 60_000).toISOString();
    expect((await patch(a, "owner-token", body({ edited_at: future }))).statusCode).toBe(400);
  });

  it("answers 409 when the edit's base version is ahead of the record (deleted and re-saved)", async () => {
    const { app: a } = await app();
    const res = await patch(a, "owner-token", body({ base_version: 7 }));
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("CONFLICT");
  });
});
