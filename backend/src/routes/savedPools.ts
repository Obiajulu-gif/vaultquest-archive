import type { FastifyPluginAsync } from "fastify";
import type { SavedPoolsService } from "../services/savedPools.js";
import {
  savedPoolDeleteParams,
  savedPoolListQuery,
  savedPoolUpsertBody
} from "../schemas/savedPools.js";
import { ok, page } from "../responses.js";

function serialize(row: Awaited<ReturnType<SavedPoolsService["listSavedPools"]>>["items"][number]) {
  return {
    id: row.id,
    wallet_address: row.walletAddress,
    pool_id: row.poolId,
    pool_name: row.poolName,
    status: row.status,
    tvl: row.tvl,
    asset: row.asset,
    participant_count: row.participantCount,
    expected_yield: row.expectedYield,
    prize: row.prize,
    opens_at: row.opensAt,
    locks_at: row.locksAt,
    draws_at: row.drawsAt,
    created_at: row.createdAt,
    updated_at: row.updatedAt
  };
}

export const savedPoolsRoutes = (svc: SavedPoolsService): FastifyPluginAsync =>
  async (app) => {
    app.get("/saved-pools", async (req) => {
      const q = savedPoolListQuery.parse(req.query);
      const result = await svc.listSavedPools(q.wallet, q.cursor ?? null, q.limit);
      return page(result.items.map(serialize), { nextCursor: result.nextCursor, limit: q.limit });
    });

    app.post("/saved-pools", async (req, reply) => {
      const body = savedPoolUpsertBody.parse(req.body);
      const result = await svc.savePool({
        walletAddress: body.wallet_address,
        pool: {
          poolId: body.pool.pool_id,
          poolName: body.pool.pool_name,
          status: body.pool.status,
          tvl: body.pool.tvl,
          asset: body.pool.asset,
          participantCount: body.pool.participant_count,
          expectedYield: body.pool.expected_yield,
          prize: body.pool.prize ?? null,
          opensAt: body.pool.opens_at ? new Date(body.pool.opens_at) : null,
          locksAt: body.pool.locks_at ? new Date(body.pool.locks_at) : null,
          drawsAt: body.pool.draws_at ? new Date(body.pool.draws_at) : null
        }
      });
      reply.status(result.created ? 201 : 200);
      return ok({ saved: serialize(result.record) });
    });

    app.delete<{ Params: { poolId: string } }>("/saved-pools/:poolId", async (req) => {
      const q = savedPoolListQuery.parse(req.query);
      const params = savedPoolDeleteParams.parse(req.params);
      const deleted = await svc.unsavePool(q.wallet, params.poolId);
      return ok({ deleted });
    });
  };
