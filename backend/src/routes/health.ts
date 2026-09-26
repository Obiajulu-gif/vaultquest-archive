import type { FastifyPluginAsync } from "fastify";
import type { LedgerService } from "../services/ledger.js";
import { ok } from "../responses.js";

export interface AttestationInfo {
  manifestVersion?: string;
  environment?: string;
  network?: string;
  buildSha?: string;
  verified: boolean;
}

let _attestation: AttestationInfo = { verified: false };

export function setAttestationInfo(info: AttestationInfo): void {
  _attestation = info;
}

export const healthRoutes = (svc: LedgerService): FastifyPluginAsync =>
  async (app) => {
    app.get("/health", async (req) => {
      req.log.debug({ event: "health_check" }, "health check requested");
      return ok({
        status: "ok",
        uptime: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
        service: "vaultquest-backend"
      });
    });

    app.get("/health/attestation", async (req) => {
      req.log.debug({ event: "attestation_check" }, "attestation check requested");
      return ok({
        ok: _attestation.verified,
        ..._attestation,
      });
    });

    app.get("/health/indexer", async (req) => {
      const health = await svc.getIndexerHealth();
      req.log.debug(
        { event: "health_indexer_check", status: health.status },
        "indexer health checked"
      );
      return ok(health);
    });
  };
