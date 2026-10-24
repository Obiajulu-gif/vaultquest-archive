import type { FastifyPluginAsync, preHandlerHookHandler } from "fastify";
import type { EditablePoolFields, SavedPoolsService } from "../services/savedPools.js";
import {
  savedPoolDeleteParams,
  savedPoolEditBody,
  savedPoolListQuery,
  savedPoolUpsertBody
} from "../schemas/savedPools.js";
import { ok, page } from "../responses.js";
import { AppError } from "../errors.js";
import { ERROR_CODES } from "../constants.js";
import { EditResolutionError, type EditStamp } from "../../../lib/conflict-resolver.js";

/**
 * #983: edits stamped further ahead than this are rejected, so a device with
 * a fast clock cannot win every future concurrent edit.
 */
export const MAX_EDIT_CLOCK_SKEW_MS = 5 * 60 * 1000;

const API_FIELD: Record<keyof EditablePoolFields, string> = {
  poolName: "pool_name",
  status: "status",
  tvl: "tvl",
  asset: "asset",
  participantCount: "participant_count",
  expectedYield: "expected_yield",
  prize: "prize",
  opensAt: "opens_at",
  locksAt: "locks_at",
  drawsAt: "draws_at"
};

const isoDate = (value: string | null | undefined) =>
  value === undefined ? undefined : value === null ? null : new Date(value);

const serializeStamp = (stamp: EditStamp) => ({ edited_at: new Date(stamp.at).toISOString(), client_id: stamp.clientId });

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
    version: row.version,
    created_at: row.createdAt,
    updated_at: row.updatedAt
  };
}

/**
 * `editGuard` authenticates the multi-client edit route (#983). Without it
 * the route is not registered, so it can never be reached unauthenticated.
 */
export const savedPoolsRoutes = (svc: SavedPoolsService, editGuard?: preHandlerHookHandler): FastifyPluginAsync =>
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
        },
        idempotencyKey: body.idempotency_key
      });
      reply.status(result.created ? 201 : 200);
      return ok({ saved: serialize(result.record) });
    });

    if (editGuard) {
      app.patch<{ Params: { poolId: string } }>("/saved-pools/:poolId", { preHandler: [editGuard] }, async (req) => {
        // Ownership comes from the session, never from the request.
        const walletAddress = req.principal?.walletAddress;
        if (!walletAddress) throw AppError.forbidden("a wallet session is required");
        const { poolId } = savedPoolDeleteParams.parse(req.params);
        const body = savedPoolEditBody.parse(req.body);

        const at = Date.parse(body.edited_at);
        if (at > Date.now() + MAX_EDIT_CLOCK_SKEW_MS) {
          throw AppError.validation("edited_at is too far in the future; check the device clock");
        }

        const c = body.changes;
        const result = await svc
          .editPool({
            walletAddress,
            poolId,
            baseVersion: body.base_version,
            stamp: { at, clientId: body.client_id },
            changes: {
              poolName: c.pool_name,
              status: c.status,
              tvl: c.tvl,
              asset: c.asset,
              participantCount: c.participant_count,
              expectedYield: c.expected_yield,
              prize: c.prize,
              opensAt: isoDate(c.opens_at),
              locksAt: isoDate(c.locks_at),
              drawsAt: isoDate(c.draws_at)
            }
          })
          .catch((err: unknown) => {
            // The record was re-created (version restarted) after the client read it.
            if (err instanceof EditResolutionError) throw AppError.conflict(ERROR_CODES.CONFLICT, `${err.message}; refresh and retry`);
            throw err;
          });
        if (!result) throw AppError.notFound(`saved pool ${poolId} not found`);

        const { resolution } = result;
        return ok({
          saved: serialize(result.record),
          resolution: {
            version: resolution.version,
            applied: resolution.applied.map((f) => API_FIELD[f]),
            rejected: resolution.rejected.map((r) => ({ field: API_FIELD[r.field], winner: serializeStamp(r.winner) })),
            unchanged: resolution.unchanged.map((f) => API_FIELD[f])
          }
        });
      });
    }

    app.delete<{ Params: { poolId: string } }>("/saved-pools/:poolId", async (req) => {
      const q = savedPoolListQuery.parse(req.query);
      const params = savedPoolDeleteParams.parse(req.params);
      const deleted = await svc.unsavePool(q.wallet, params.poolId);
      return ok({ deleted });
    });
  };
