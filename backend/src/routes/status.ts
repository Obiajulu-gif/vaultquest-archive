/**
 * Public Status Routes
 *
 * Exposes operational status via HTTP without authentication.
 * Designed to be safe for load balancers, monitoring systems, and public clients.
 *
 * GET /status
 *   Returns current operational state, affected features, and user guidance.
 *   Safe to call from UI, monitors, and API clients.
 *   Never returns secrets or internal details.
 *
 * GET /status/can-mutate (authenticated)
 *   Returns whether the current user can perform write operations.
 *   For UI to gate mutation buttons.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import type { PublicStatusService } from "../services/publicStatusService.js";

export const statusResponseSchema = z.object({
  status: z.enum(["healthy", "degraded", "paused", "maintenance"]),
  message: z.string(),
  guidance: z.string(),
  affectedFeatures: z.object({
    deposits: z.boolean(),
    withdrawals: z.boolean(),
    claims: z.boolean(),
    views: z.boolean(),
  }),
  retryAfterSeconds: z.number().optional(),
  maintenanceUntil: z.string().datetime().optional(),
});

export type StatusResponse = z.infer<typeof statusResponseSchema>;

export async function registerStatusRoutes(
  app: FastifyInstance,
  statusService: PublicStatusService
) {
  /**
   * GET /status
   * Public endpoint: no authentication required.
   * Returns the current operational state and feature availability.
   */
  app.get<{ Reply: StatusResponse }>(
    "/status",
    {
      schema: {
        response: {
          200: statusResponseSchema,
        },
      },
      // No authentication required; this is a public status endpoint
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const snapshot = statusService.getPublicStatus();

      const response: StatusResponse = {
        status: snapshot.status,
        message: snapshot.message,
        guidance: snapshot.guidance,
        affectedFeatures: snapshot.affectedFeatures,
        ...(snapshot.retryAfterSeconds && {
          retryAfterSeconds: snapshot.retryAfterSeconds,
        }),
        ...(snapshot.maintenanceUntil && {
          maintenanceUntil: snapshot.maintenanceUntil.toISOString(),
        }),
      };

      // Add Retry-After header if applicable (RFC 7231)
      if (snapshot.retryAfterSeconds) {
        reply.header("Retry-After", String(snapshot.retryAfterSeconds));
      }

      // Cache this response for a short time (5 seconds) to avoid load
      reply.header("Cache-Control", "public, max-age=5");

      return response;
    }
  );

  /**
   * GET /status/can-mutate
   * Authenticated endpoint: returns whether the requesting user can perform mutations.
   * Used by UI to enable/disable transaction buttons.
   */
  app.get<{ Reply: { canMutate: boolean } }>(
    "/status/can-mutate",
    {
      // Requires authentication
      onRequest: [app.authenticate],
      schema: {
        response: {
          200: z.object({ canMutate: z.boolean() }),
        },
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const canMutate = statusService.canUserMutate();

      // Don't cache this endpoint if mutations are blocked
      if (!canMutate) {
        reply.header("Cache-Control", "no-cache, no-store, must-revalidate");
      } else {
        reply.header("Cache-Control", "public, max-age=5");
      }

      return { canMutate };
    }
  );

  /**
   * Admin endpoint: POST /status/pause
   * Pauses user mutations (incident response).
   * Requires admin permission.
   */
  app.post<{
    Body: { durationSeconds?: number; reason: string };
    Reply: { paused: boolean; until?: string };
  }>(
    "/status/pause",
    {
      onRequest: [app.authenticate],
      schema: {
        body: z.object({
          reason: z
            .string()
            .min(1)
            .max(200)
            .describe("User-safe reason for the pause"),
          durationSeconds: z
            .number()
            .int()
            .min(10)
            .max(3600)
            .optional()
            .describe("Duration in seconds (10-3600); omit for indefinite"),
        }),
        response: {
          200: z.object({
            paused: z.boolean(),
            until: z.string().datetime().optional(),
          }),
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      // Verify admin permission
      const userId = (request.user as any)?.id;
      if (!userId || !(request.user as any)?.isAdmin) {
        reply.status(403);
        return { paused: false };
      }

      const { reason, durationSeconds } = request.body as {
        reason: string;
        durationSeconds?: number;
      };

      statusService.pauseMutations(reason, durationSeconds);
      const eta = statusService.getRecoveryEta();

      return {
        paused: true,
        ...(eta && { until: eta.toISOString() }),
      };
    }
  );

  /**
   * Admin endpoint: POST /status/resume
   * Resumes user mutations after a pause.
   * Requires admin permission.
   */
  app.post<{ Reply: { resumed: boolean } }>(
    "/status/resume",
    {
      onRequest: [app.authenticate],
      schema: {
        response: {
          200: z.object({ resumed: z.boolean() }),
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      // Verify admin permission
      const userId = (request.user as any)?.id;
      if (!userId || !(request.user as any)?.isAdmin) {
        reply.status(403);
        return { resumed: false };
      }

      statusService.resumeMutations();
      return { resumed: true };
    }
  );

  /**
   * Admin endpoint: POST /status/maintenance
   * Schedules a maintenance window.
   * Requires admin permission.
   */
  app.post<{
    Body: {
      startsAt: string;
      endsAt: string;
      reason: string;
    };
    Reply: { scheduled: boolean; id: string };
  }>(
    "/status/maintenance",
    {
      onRequest: [app.authenticate],
      schema: {
        body: z.object({
          startsAt: z.string().datetime().describe("ISO 8601 start time"),
          endsAt: z.string().datetime().describe("ISO 8601 end time"),
          reason: z
            .string()
            .min(1)
            .max(300)
            .describe("User-safe maintenance reason"),
        }),
        response: {
          200: z.object({
            scheduled: z.boolean(),
            id: z.string(),
          }),
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      // Verify admin permission
      const userId = (request.user as any)?.id;
      if (!userId || !(request.user as any)?.isAdmin) {
        reply.status(403);
        return { scheduled: false, id: "" };
      }

      const { startsAt, endsAt, reason } = request.body as {
        startsAt: string;
        endsAt: string;
        reason: string;
      };

      const start = new Date(startsAt);
      const end = new Date(endsAt);

      if (start >= end) {
        reply.status(400);
        return {
          scheduled: false,
          id: "",
        };
      }

      statusService.scheduleMaintenanceWindow({ startsAt: start, endsAt: end, reason });

      return {
        scheduled: true,
        id: `maint-${Date.now()}`,
      };
    }
  );

  /**
   * Admin endpoint: POST /status/maintenance/clear
   * Clears the current maintenance window.
   * Requires admin permission.
   */
  app.post<{ Reply: { cleared: boolean } }>(
    "/status/maintenance/clear",
    {
      onRequest: [app.authenticate],
      schema: {
        response: {
          200: z.object({ cleared: z.boolean() }),
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      // Verify admin permission
      const userId = (request.user as any)?.id;
      if (!userId || !(request.user as any)?.isAdmin) {
        reply.status(403);
        return { cleared: false };
      }

      statusService.clearMaintenanceWindow();
      return { cleared: true };
    }
  );
}
