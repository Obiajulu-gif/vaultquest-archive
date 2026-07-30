// backend/src/plugins/rate-limit.ts
// Registers @fastify/rate-limit as a Fastify plugin.
// Applied globally; individual routes may override via their own `config.rateLimit`.

import fp from "fastify-plugin";
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import rateLimit from "@fastify/rate-limit";

export interface RateLimitOptions extends FastifyPluginOptions {
  /** Max requests per window per IP (default: 100) */
  max?: number;
  /** Window duration in milliseconds (default: 60 000 – one minute) */
  timeWindow?: number;
}

async function rateLimitPlugin(
  fastify: FastifyInstance,
  options: RateLimitOptions
) {
  const max = options.max ?? 100;
  const timeWindow = options.timeWindow ?? 60_000; // 1 minute

  await fastify.register(rateLimit, {
    global: true,
    max,
    timeWindow,

    // Returns a standard 429 JSON body.
    errorResponseBuilder(_request, context) {
      return {
        statusCode: 429,
        error: "Too Many Requests",
        message: `Rate limit exceeded. You may retry after ${context.after}.`,
        retryAfter: context.after,
      };
    },

    // Log exceeded attempts for observability.
    onExceeding(request) {
      request.log.warn(
        { ip: request.ip, url: request.url },
        "Rate limit approaching for IP"
      );
    },

    onExceeded(request) {
      request.log.warn(
        { ip: request.ip, url: request.url },
        "Rate limit exceeded for IP – returning 429"
      );
    },

    // Honor X-Forwarded-For when sitting behind a reverse proxy / load-balancer.
    keyGenerator(request) {
      return request.headers["x-forwarded-for"]?.toString().split(",")[0].trim()
        ?? request.ip;
    },
  });
}

export default fp(rateLimitPlugin, {
  name: "rate-limit",
  fastify: "4.x || 5.x",
});
