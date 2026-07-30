import type { FastifyRequest, FastifyReply } from "fastify";
import { getEnv } from "../env.js";

export async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return reply.status(401).send({ error: "Unauthorized" });
  }

  const token = authHeader.substring(7);
  
  // In a real application, verify the JWT here using a library like jsonwebtoken
  // For this implementation, we simulate decoding a payload
  if (token === "invalid") {
    return reply.status(401).send({ error: "Invalid token" });
  }

  // Dummy user payload extracted from JWT
  const userPayload = {
    id: "dummy-user-id",
    // This could also be a wallet address based on implementation
  };

  // Attach user to request
  (request as any).user = userPayload;
}
