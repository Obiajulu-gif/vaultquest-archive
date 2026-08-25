import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { createHash } from "node:crypto";

const PUBLIC_ROUTES = [
  "/api/metrics",
  "/api/metrics/aggregate",
  "/api/metrics/round",
  "/api/metrics/history",
  "/api/categories",
];

const PRIVATE_ROUTES = [
  "/saved-pools",
  "/actions",
  "/portfolio/summary",
  "/dashboard/summary",
  "/api/notifications",
];

const plugin: FastifyPluginAsync = async (app) => {
  app.addHook("onSend", async (req, reply, payload) => {
    const method = req.method;
    const url = req.url.split("?")[0];

    // Only apply cache control & ETag logic to GET requests
    if (method !== "GET") {
      return payload;
    }

    // 1. Keep wallet-private responses out of public caches
    const isPrivate = PRIVATE_ROUTES.some((r) => url === r || url.startsWith(r + "/"));
    if (isPrivate) {
      reply.header("Cache-Control", "private, no-store, no-cache, must-revalidate");
      return payload;
    }

    // 2. Generate stable ETags for public pool lists, details, and protocol metrics
    const isPublic = PUBLIC_ROUTES.some((r) => url === r || url.startsWith(r + "/"));
    if (isPublic && typeof payload === "string") {
      const hash = createHash("sha256").update(payload).digest("hex");
      const etag = `W/"${hash}"`;

      reply.header("ETag", etag);
      reply.header("Cache-Control", "public, no-cache");

      const ifNoneMatch = req.headers["if-none-match"];
      if (ifNoneMatch && ifNoneMatch === etag) {
        reply.code(304);
        return "";
      }
    }

    return payload;
  });
};

export const etagPlugin = fp(plugin, { name: "etagPlugin" });
