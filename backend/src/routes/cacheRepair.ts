import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { CacheService } from "../services/cacheService.js";
import { requireServiceAuth } from "../middleware/service-auth.js";
import { ok } from "../responses.js";

const cacheKind = z.enum([
  "pending_event",
  "asset_metadata",
  "protocol_config",
  "generic",
  "checkpoint",
]);

const inspectQuery = z.object({
  kind: cacheKind.optional(),
  key: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const repairBody = z.object({
  dry_run: z.boolean().default(true),
  kind: cacheKind.optional(),
  keys: z.array(z.string().min(1).max(512)).max(500).optional(),
  limit: z.number().int().min(1).max(500).default(100),
});

export const cacheRepairRoutes = (
  cache: CacheService,
  secret: string,
): FastifyPluginAsync => async (app) => {
  const guard = requireServiceAuth(secret);

  app.get("/internal/cache/stale", { preHandler: [guard] }, async (request) => {
    const query = inspectQuery.parse(request.query);
    const inspection = await cache.inspectStale({
      kind: query.kind,
      keys: query.key === undefined ? undefined : [query.key],
      limit: query.limit,
    });
    return ok({
      count: inspection.entries.length,
      scanned: inspection.scanned,
      complete: inspection.complete,
      coverage: cache.redisOnline ? "shared_redis_and_process_memory" : "process_memory_only",
      sharedStoreAvailable: cache.redisOnline,
      entries: inspection.entries,
    });
  });

  app.post("/internal/cache/repair", { preHandler: [guard] }, async (request) => {
    const body = repairBody.parse(request.body ?? {});
    const result = await cache.repairStaleCache({
      dryRun: body.dry_run,
      kind: body.kind,
      keys: body.keys,
      limit: body.limit,
    });
    request.log.info(
      {
        event: "cache_repair.completed",
        dry_run: result.dryRun,
        scanned: result.scanned,
        repaired: result.repaired.length,
        failed: result.failed.length,
      },
      "cache repair inspection completed",
    );
    return ok({
      ...result,
      coverage: cache.redisOnline ? "shared_redis_and_process_memory" : "process_memory_only",
      sharedStoreAvailable: cache.redisOnline,
    });
  });
};
