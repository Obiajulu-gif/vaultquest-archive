import type { FastifyPluginAsync } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { LedgerService } from "../services/ledger.js";
import type { CacheService } from "../services/cacheService.js";
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

export interface DependencyHealthDeps {
  prisma: PrismaClient;
  cacheService?: CacheService;
  rpcUrls?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

import type { DegradedModeService } from "../services/degradedModeService.js";

export const healthRoutes = (
  svc: LedgerService,
  dependencyDeps?: DependencyHealthDeps,
  degradedService?: DegradedModeService,
): FastifyPluginAsync =>
  async (app) => {
    app.get("/health/degraded", async (_req, reply) => {
      if (!degradedService) {
        return ok({
          status: "healthy",
          userBanner: null,
          dependencies: []
        });
      }
      const status = degradedService.getUserSafeStatus();
      if (status.status === "unavailable") {
        reply.header("Retry-After", String(status.retryAfterSeconds ?? 30));
        return reply.code(503).send(ok(status));
      }
      return ok(status);
    });
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

    app.get("/health/dependencies", async (req, reply) => {
      if (!dependencyDeps) {
        return reply.code(503).send({
          ok: false,
          data: {
            status: "unavailable",
            dependencies: [],
            remediation: "Dependency diagnostics are not configured on this instance.",
          },
        });
      }
      const report = await checkDependencies(dependencyDeps);
      return reply.code(report.status === "unavailable" ? 503 : 200).send(ok(report));
    });

    /**
     * Issue #992 — Public dependency-aware health summary.
     *
     * GET /health/status aggregates the liveness check, indexer health, and
     * all dependency probes into a single response that is safe to expose to
     * load-balancers, status pages, and monitoring systems.
     *
     * Response shape:
     *   {
     *     "status": "healthy" | "degraded" | "unavailable",
     *     "uptime": <seconds>,
     *     "checkedAt": "<ISO8601>",
     *     "components": {
     *       "api":     { "status": "healthy" },
     *       "indexer": { "status": "healthy"|"degraded"|"lagging", "latest_ledger": … },
     *       "dependencies": { "status": "healthy"|"degraded"|"unavailable", "items": […] }
     *     }
     *   }
     *
     * HTTP codes:
     *   200 — healthy or degraded (at least partially operational)
     *   503 — unavailable (at least one required dependency is down)
     *
     * No sensitive configuration values (credentials, hostnames, secrets) are
     * ever included in the response; see `checkDependencies` for the sanitisation
     * rules that apply to each sub-probe.
     *
     * Recovery / rollback:
     *   - This route is entirely additive; it does not modify any state.
     *   - It can be disabled by removing the route registration without
     *     touching any other route or service.
     *   - If dependency probing is not configured, that component is reported
     *     as "unconfigured" and excluded from the overall severity roll-up.
     */
    app.get("/health/status", async (req, reply) => {
      req.log.debug({ event: "health_status_check" }, "health status check requested");

      // 1. Indexer component
      const indexerHealth = await svc.getIndexerHealth().catch(() => ({
        status: "degraded" as const,
        latest_ledger: 0,
        sync_lag: 0,
        message: "Indexer health check failed"
      }));

      // 2. Dependency component (optional — omitted when not configured)
      let depsReport: Awaited<ReturnType<typeof checkDependencies>> | null = null;
      if (dependencyDeps) {
        depsReport = await checkDependencies(dependencyDeps).catch(() => ({
          status: "unavailable" as const,
          checkedAt: new Date().toISOString(),
          dependencies: [],
        }));
      }

      // 3. Roll up overall status
      // Priority: unavailable > degraded > healthy
      const indexerStatus = indexerHealth.status === "lagging" ? "degraded" : indexerHealth.status;
      const depsStatus = depsReport?.status ?? "healthy";

      const overallStatus: "healthy" | "degraded" | "unavailable" =
        indexerStatus === "unavailable" || depsStatus === "unavailable"
          ? "unavailable"
          : indexerStatus === "degraded" || depsStatus === "degraded"
            ? "degraded"
            : "healthy";

      const body = {
        status: overallStatus,
        uptime: Math.floor(process.uptime()),
        checkedAt: new Date().toISOString(),
        components: {
          api: { status: "healthy" as const },
          indexer: {
            status: indexerHealth.status,
            latest_ledger: indexerHealth.latest_ledger,
            sync_lag: indexerHealth.sync_lag,
            ...(indexerHealth.message ? { message: indexerHealth.message } : {}),
          },
          ...(depsReport
            ? {
              dependencies: {
                status: depsReport.status,
                checkedAt: depsReport.checkedAt,
                items: depsReport.dependencies.map((d) => ({
                  name: d.name,
                  status: d.status,
                  required: d.required,
                  latencyMs: d.latencyMs,
                  remediation: d.remediation,
                })),
              },
            }
            : {}),
        },
      };

      const httpCode = overallStatus === "unavailable" ? 503 : 200;
      return reply.code(httpCode).send(ok(body));
    });
  };

type DependencyStatus = "healthy" | "degraded" | "unavailable" | "misconfigured";
type DependencyResult = {
  name: string;
  status: DependencyStatus;
  required: boolean;
  latencyMs?: number;
  remediation: string;
};

export async function checkDependencies(deps: DependencyHealthDeps) {
  const fetcher = deps.fetch ?? globalThis.fetch;
  const timeoutMs = deps.timeoutMs ?? 2500;
  const results = await Promise.all([
    probe("database", true, async () => {
      await deps.prisma.$queryRaw`SELECT 1`;
      return { status: "healthy" as const, remediation: "No action required." };
    }),
    probe("redis_cache", false, async () => {
      const client = deps.cacheService?.redisClient;
      if (!client) {
        return { status: "degraded" as const, remediation: "REDIS_URL is unset; caching uses its documented fallback." };
      }
      await client.ping();
      return { status: "healthy" as const, remediation: "No action required." };
    }),
    probe("soroban_rpc", true, async () => {
      const raw = deps.rpcUrls?.split(",").map((url) => url.trim()).filter(Boolean) ?? [];
      if (raw.length === 0) {
        return { status: "misconfigured" as const, remediation: "Configure SOROBAN_RPC_URL with at least one valid HTTPS RPC endpoint." };
      }
      const endpoints = raw.map((url) => {
        try {
          const parsed = new URL(url);
          if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error();
          return parsed;
        } catch {
          throw Object.assign(new Error("invalid RPC endpoint configuration"), { dependencyStatus: "misconfigured" });
        }
      });
      const outcomes = await Promise.all(endpoints.map(async (endpoint) => {
        try {
          const response = await fetcher(endpoint.toString(), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (!response.ok) return false;
          const body = await response.json() as { result?: { status?: string }; error?: unknown };
          if (body.error || !body.result) return false;
          return body.result.status === "healthy" || body.result.status === "active";
        } catch {
          return false;
        }
      }));
      if (outcomes.every(Boolean)) {
        return { status: "healthy" as const, remediation: "No action required." };
      }
      if (outcomes.some(Boolean)) {
        return { status: "degraded" as const, remediation: "Some configured RPC endpoints are unhealthy; inspect provider status and failover configuration." };
      }
      throw new Error("RPC endpoints are unhealthy");
    }),
  ]);
  const required = results.filter((item) => item.required);
  const status = required.some((item) => item.status === "unavailable" || item.status === "misconfigured")
    ? "unavailable"
    : results.some((item) => item.status !== "healthy")
      ? "degraded"
      : "healthy";
  return {
    status,
    checkedAt: new Date().toISOString(),
    dependencies: results,
  };
}

async function probe(
  name: string,
  required: boolean,
  run: () => Promise<{ status: DependencyStatus; remediation: string }>,
): Promise<DependencyResult> {
  const started = performance.now();
  try {
    return { name, required, ...(await run()), latencyMs: Math.round(performance.now() - started) };
  } catch (error) {
    const misconfigured = (error as { dependencyStatus?: string })?.dependencyStatus === "misconfigured";
    return {
      name,
      required,
      status: misconfigured ? "misconfigured" : "unavailable",
      latencyMs: Math.round(performance.now() - started),
      remediation: misconfigured
        ? "Correct the dependency configuration; endpoint values and credentials are intentionally omitted."
        : "Check service connectivity, credentials, and provider health; sensitive endpoint details are omitted.",
    };
  }
}
