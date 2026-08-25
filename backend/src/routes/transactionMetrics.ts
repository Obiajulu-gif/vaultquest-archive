import type { FastifyInstance } from "fastify";
import { TransactionMetricsService } from "../services/transactionMetrics.js";
import { ok } from "../responses.js";
import type { PrismaClient } from "@prisma/client";

export function transactionMetricsRoutes(
  prisma: PrismaClient,
  apiKeyGuard: (req: any, reply: any) => Promise<void>,
) {
  return async (app: FastifyInstance) => {
    const service = new TransactionMetricsService(prisma, app.log);

    app.get(
      "/api/v1/metrics/transactions",
      { preHandler: apiKeyGuard },
      async (req, reply) => {
        const since = req.query.since
          ? new Date(req.query.since as string)
          : undefined;

        const metrics = await service.getAllMetrics(since);
        return ok({ metrics });
      },
    );

    app.get(
      "/api/v1/metrics/transactions/:actionType",
      { preHandler: apiKeyGuard },
      async (req, reply) => {
        const { actionType } = req.params as { actionType: string };
        const network = req.query.network as string | undefined;
        const since = req.query.since
          ? new Date(req.query.since as string)
          : undefined;

        const metrics = await service.getMetricsByActionType(
          actionType as any,
          network,
          since,
        );

        if (!metrics) {
          return reply.code(404).send({ error: "No metrics found" });
        }

        return ok({ metrics });
      },
    );
  };
}
