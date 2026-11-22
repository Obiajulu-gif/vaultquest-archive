import type { FastifyPluginAsync } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { requirePermission, serviceSecretResolver } from "../middleware/rbac.js";
import { ok } from "../responses.js";
import { PrivacyAnalyticsService } from "../services/privacyAnalyticsService.js";

export const privacyAnalyticsRoutes = (prisma: PrismaClient, secret: string): FastifyPluginAsync =>
  async (app) => {
    const guard = requirePermission("internal.analytics.read", [serviceSecretResolver(secret)]);
    app.get("/internal/analytics/summary", { preHandler: [guard] }, async () => {
      return ok(await new PrivacyAnalyticsService(prisma).summarize());
    });
  };
