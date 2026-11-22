import { afterEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { CacheService } from "../src/services/cacheService.js";
import { cacheRepairRoutes } from "../src/routes/cacheRepair.js";
import { createLogger } from "../src/logger.js";

describe("internal cache repair routes", () => {
  let app: FastifyInstance;
  let cache: CacheService;

  afterEach(async () => {
    await app?.close();
  });

  it("requires service authentication and defaults repair to a read-only preview", async () => {
    const prisma = {
      cacheRepairRun: {
        create: vi.fn().mockResolvedValue({ id: "repair-run-1" }),
        update: vi.fn().mockResolvedValue({}),
      },
    } as unknown as PrismaClient;
    cache = new CacheService(prisma, createLogger("silent"));
    await cache.setAssetMetadata({
      asset: "USDC",
      decimals: 7,
      lastUpdated: new Date("2020-01-01T00:00:00.000Z"),
    });

    app = Fastify();
    await app.register(cacheRepairRoutes(cache, "operator-secret"));
    await app.ready();

    const unauthorized = await app.inject({
      method: "GET",
      url: "/internal/cache/stale?kind=asset_metadata",
    });
    expect(unauthorized.statusCode).toBe(401);

    const preview = await app.inject({
      method: "POST",
      url: "/internal/cache/repair",
      headers: { "x-internal-secret": "operator-secret" },
      payload: { kind: "asset_metadata" },
    });
    expect(preview.statusCode).toBe(200);
    expect(JSON.parse(preview.payload).data).toMatchObject({
      dryRun: true,
      scanned: 1,
      repaired: [],
      stale: [{ key: "asset:USDC", recommendation: "invalidate_and_refetch" }],
    });
    expect(await cache.getAssetMetadata("USDC")).not.toBeNull();

    const applied = await app.inject({
      method: "POST",
      url: "/internal/cache/repair",
      headers: { "x-internal-secret": "operator-secret" },
      payload: { kind: "asset_metadata", dry_run: false },
    });
    expect(applied.statusCode).toBe(200);
    expect(JSON.parse(applied.payload).data.repaired).toEqual(["asset:USDC"]);
    expect(await cache.getAssetMetadata("USDC")).toBeNull();
  });
});
