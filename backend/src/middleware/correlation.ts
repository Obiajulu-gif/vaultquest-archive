import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { randomUUID } from "node:crypto";

declare module "fastify" {
  interface FastifyRequest {
    correlationId: string;
  }
}

const plugin: FastifyPluginAsync = async (app) => {
  app.addHook("onRequest", async (req, reply) => {
    const incoming = req.headers["correlation-id"];
    const id = typeof incoming === "string" && incoming.length > 0 ? incoming : randomUUID();
    req.correlationId = id;
    reply.header("Correlation-Id", id);
    req.log = req.log.child({ correlation_id: id });
  });
};

export default fp(plugin, { name: "correlation" });
