import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { randomUUID } from "node:crypto";
import { bindCorrelation } from "../services/telemetry.js";

declare module "fastify" {
  interface FastifyRequest {
    correlationId: string;
  }
}

const plugin: FastifyPluginAsync = async (app) => {
  app.addHook("onRequest", async (req, reply) => {
    const incoming = req.headers["correlation-id"];
    // Accept only bounded opaque tokens so arbitrary request input cannot
    // become an unbounded log field; generate a safe ID for anything else.
    const id = typeof incoming === "string" && /^[A-Za-z0-9._:-]{1,96}$/.test(incoming)
      ? incoming
      : randomUUID();
    req.correlationId = id;
    bindCorrelation(id);
    reply.header("Correlation-Id", id);
    req.log = req.log.child({ correlation_id: id });
  });
};

export default fp(plugin, { name: "correlation" });
