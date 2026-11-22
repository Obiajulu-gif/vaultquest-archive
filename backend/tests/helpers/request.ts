import type { FastifyInstance, InjectOptions } from "fastify";

/**
 * `app.inject` wrapper for route tests.
 *
 * The middleware chain (see `src/middleware/rateLimiter.ts`) requires a CSRF
 * token pair on every state-changing request, and rate-limits them per IP
 * (10 per 15 minutes). Tests predating that middleware were sending bare
 * POST/PATCH/DELETE requests and sharing the default `127.0.0.1` bucket.
 *
 * This helper:
 *  - performs the GET /health handshake and copies the issued
 *    `x-csrf-token`/`csrf-token` pair onto non-GET requests (internal
 *    `/internal/*` routes are exempt), and
 *  - gives every request a unique `remoteAddress`, so no two requests share
 *    a rate-limit bucket.
 */
export function createRequester(app: FastifyInstance) {
  let ipCounter = 0;
  const nextIp = (): string => {
    ipCounter += 1;
    return `10.99.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
  };

  return async function inject(options: InjectOptions & { remoteAddress?: string }) {
    const method = String(options.method ?? "GET").toUpperCase();
    const url = String(options.url ?? "");
    const headers: Record<string, string> = { ...(options.headers as Record<string, string>) };

    const needsCsrf =
      !["GET", "HEAD", "OPTIONS"].includes(method) && !url.startsWith("/internal/");

    if (needsCsrf && !headers["x-csrf-token"]) {
      const handshake = await app.inject({ method: "GET", url: "/health" });
      const token = String(handshake.headers["x-csrf-token"] ?? "");
      const setCookie = String(handshake.headers["set-cookie"] ?? "");
      headers["x-csrf-token"] = token;
      headers["cookie"] = setCookie.split(";")[0] ?? "";
    }

    return app.inject({
      ...options,
      headers,
      remoteAddress: options.remoteAddress ?? nextIp()
    });
  };
}

export type Requester = ReturnType<typeof createRequester>;
