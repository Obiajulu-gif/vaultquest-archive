import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { ERROR_CODES } from "../constants.js";
import { AppError } from "../errors.js";
import { randomUUID } from "node:crypto";

const WINDOW_MS = 15 * 60 * 1000; // 15 minutes

interface RateLimitInfo {
  count: number;
  resetTime: number;
}

const publicStore = new Map<string, RateLimitInfo>();
const sensitiveStore = new Map<string, RateLimitInfo>();

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) return cookies;
  const pairs = cookieHeader.split(";");
  for (const pair of pairs) {
    const [key, ...valueParts] = pair.split("=");
    if (key) {
      cookies[key.trim()] = valueParts.join("=").trim();
    }
  }
  return cookies;
}

const plugin: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", async (req, reply) => {
    const method = req.method;

    // CSRF Protection
    // Skip CSRF check for:
    // - GET, HEAD, OPTIONS requests
    // - Internal APIs (starts with /internal/)
    if (["GET", "HEAD", "OPTIONS"].includes(method) || req.url.startsWith("/internal/")) {
      // For GET requests, ensure a CSRF token exists
      if (method === "GET") {
        const cookies = parseCookies(req.headers.cookie);
        let csrfToken = cookies["csrf-token"];
        if (!csrfToken) {
          csrfToken = randomUUID();
          reply.header("Set-Cookie", `csrf-token=${csrfToken}; Path=/; HttpOnly; SameSite=Lax`);
        }
        reply.header("X-CSRF-Token", csrfToken);
      }
      return;
    }

    // Enforce CSRF check for state-changing requests (POST, PUT, DELETE, PATCH)
    const cookies = parseCookies(req.headers.cookie);
    const cookieToken = cookies["csrf-token"];
    const headerToken = req.headers["x-csrf-token"];

    const headerTokenStr = Array.isArray(headerToken) ? headerToken[0] : headerToken;

    if (!cookieToken || !headerTokenStr || cookieToken !== headerTokenStr) {
      throw new AppError(ERROR_CODES.FORBIDDEN, 403, "Invalid or missing CSRF token");
    }
  });
};

export const rateLimiter = fp(plugin, { name: "rateLimiter" });
