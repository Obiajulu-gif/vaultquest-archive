import type { FastifyPluginAsync, preHandlerHookHandler } from "fastify";
import { AppError } from "../errors.js";
import { page } from "../responses.js";
import { publicActivityQuery } from "../schemas/activity.js";
import type { PublicActivityService } from "../services/publicActivity.js";

export const activityRoutes = (
  service: PublicActivityService,
  ownDataReadGuard: preHandlerHookHandler
): FastifyPluginAsync => async (app) => {
  app.get("/api/activity", { preHandler: [ownDataReadGuard] }, async (req, reply) => {
    const walletAddress = req.principal?.walletAddress;
    if (!walletAddress) throw AppError.forbidden("wallet activity requires an authenticated wallet");

    const query = publicActivityQuery.parse(req.query);
    if (query.wallet !== walletAddress) {
      throw AppError.forbidden("cannot view activity outside your wallet session");
    }
    const result = await service.list({
      walletAddress,
      ...(query.type && { type: query.type }),
      ...(query.cursor && { cursor: query.cursor }),
      limit: query.limit
    });
    reply.header("Cache-Control", "private, no-store");
    return page(result.items, { nextCursor: result.nextCursor, limit: query.limit });
  });
};