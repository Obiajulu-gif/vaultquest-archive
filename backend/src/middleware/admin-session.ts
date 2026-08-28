import type { FastifyRequest, FastifyReply } from "fastify";
import type { AdminSessionService } from "../services/adminSessionService.js";

export function createRequireAdminSessionAuth(adminSessionService: AdminSessionService) {
  return async function requireAdminSessionAuth(request: FastifyRequest, reply: FastifyReply) {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return reply.status(401).send({ error: "Missing admin session token" });
    }

    const sessionId = authHeader.substring(7).trim();
    const session = await adminSessionService.verifySession(sessionId);

    if (!session) {
      return reply.status(401).send({ error: "Invalid or expired admin session" });
    }

    const audience = request.url.split("?")[0];
    if (!audience.includes(session.audience)) {
      return reply.status(403).send({ error: "Invalid session audience" });
    }

    (request as any).adminSession = session;
  };
}

export async function extractAdminSession(request: FastifyRequest): Record<string, any> | null {
  return (request as any).adminSession ?? null;
}
