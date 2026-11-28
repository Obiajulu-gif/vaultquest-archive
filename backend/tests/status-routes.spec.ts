import Fastify, { type FastifyInstance, type preHandlerHookHandler } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DegradedModeService } from "../src/services/degradedModeService.js";
import { PublicStatusService } from "../src/services/publicStatusService.js";
import {
  registerStatusRoutes,
  statusResponseSchema,
} from "../src/routes/status.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import {
  requirePermission,
  type Principal,
  type PrincipalResolver,
} from "../src/middleware/rbac.js";
import { requireMaintainerApproval } from "../src/middleware/maintainerApproval.js";

const user: Principal = { role: "user", subject: "wallet-user" };
const maintainer: Principal = { role: "maintainer", subject: "wallet-maintainer" };

function approvalHeader(actor: string): string {
  return Buffer.from(JSON.stringify({
    scope: "admin.recovery.write",
    actor,
    reason: "Approved incident response",
    expiresAt: Date.now() + 60_000,
  })).toString("base64");
}

describe("Status routes", () => {
  let app: FastifyInstance;
  let degradedMode: DegradedModeService;
  let statusService: PublicStatusService;

  beforeEach(async () => {
    degradedMode = new DegradedModeService();
    statusService = new PublicStatusService(degradedMode);
    app = Fastify();
    app.setErrorHandler(errorHandler);

    const resolvePrincipal: PrincipalResolver = async (request) => {
      const credential = request.headers.authorization;
      if (credential === "Bearer user") return user;
      if (credential === "Bearer maintainer") return maintainer;
      return null;
    };
    const permission = (name: "own.data.read" | "admin.recovery.write") =>
      requirePermission(name, [resolvePrincipal]);
    const writeGuard: preHandlerHookHandler = async (request, reply) => {
      await permission("admin.recovery.write")(request, reply);
      await requireMaintainerApproval("admin.recovery.write")(request, reply);
    };

    await registerStatusRoutes(app, statusService, {
      userRead: permission("own.data.read"),
      write: writeGuard,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("serves a public, validated healthy status and an operator-readable degraded status", async () => {
    const healthy = await app.inject({ method: "GET", url: "/status" });
    expect(healthy.statusCode).toBe(200);
    expect(statusResponseSchema.parse(healthy.json())).toMatchObject({
      status: "healthy",
      affectedFeatures: { deposits: false, views: false },
    });
    expect(healthy.headers["cache-control"]).toContain("public");

    degradedMode.setDependencyStatus("redis_cache", "unavailable");
    const degraded = await app.inject({ method: "GET", url: "/status" });
    expect(degraded.statusCode).toBe(200);
    expect(degraded.json()).toMatchObject({
      status: "degraded",
      affectedFeatures: { deposits: false, views: true },
    });
    expect(statusService.canUserMutate()).toBe(true);
    expect(degraded.json().message).not.toMatch(/redis|cache|soroban|database/i);
  });

  it("blocks writes for a critical dependency failure and recovers after retry successes", async () => {
    degradedMode.recordFailure("soroban_rpc", new Error("private endpoint failure"));
    expect((await app.inject({ method: "GET", url: "/status" })).json().status).toBe("paused");
    expect(statusService.canUserMutate()).toBe(false);

    degradedMode.recordSuccess("soroban_rpc");
    expect((await app.inject({ method: "GET", url: "/status" })).json().status).toBe("paused");
    degradedMode.recordSuccess("soroban_rpc");
    expect((await app.inject({ method: "GET", url: "/status" })).json().status).toBe("healthy");
  });

  it("requires a user session for mutation status and disables caching while blocked", async () => {
    const anonymous = await app.inject({ method: "GET", url: "/status/can-mutate" });
    expect(anonymous.statusCode).toBe(401);

    const allowed = await app.inject({
      method: "GET",
      url: "/status/can-mutate",
      headers: { authorization: "Bearer user" },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toEqual({ canMutate: true });

    statusService.pauseMutations("Incident response", 300);
    const blocked = await app.inject({
      method: "GET",
      url: "/status/can-mutate",
      headers: { authorization: "Bearer user" },
    });
    expect(blocked.statusCode).toBe(200);
    expect(blocked.json()).toEqual({ canMutate: false });
    expect(blocked.headers["cache-control"]).toContain("no-store");
  });

  it("rejects unauthorized writes and requires approval from the acting maintainer", async () => {
    const anonymous = await app.inject({
      method: "POST",
      url: "/status/pause",
      payload: { reason: "Incident response", durationSeconds: 60 },
    });
    expect(anonymous.statusCode).toBe(401);

    const userWrite = await app.inject({
      method: "POST",
      url: "/status/pause",
      headers: { authorization: "Bearer user" },
      payload: { reason: "Incident response", durationSeconds: 60 },
    });
    expect(userWrite.statusCode).toBe(403);

    const missingApproval = await app.inject({
      method: "POST",
      url: "/status/pause",
      headers: { authorization: "Bearer maintainer" },
      payload: { reason: "Incident response", durationSeconds: 60 },
    });
    expect(missingApproval.statusCode).toBe(403);

    const approved = await app.inject({
      method: "POST",
      url: "/status/pause",
      headers: {
        authorization: "Bearer maintainer",
        "x-maintainer-approval": approvalHeader(maintainer.subject),
      },
      payload: { reason: "Incident response", durationSeconds: 60 },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().paused).toBe(true);
  });

  it("schedules and clears maintenance, rejecting a reversed time range", async () => {
    const headers = {
      authorization: "Bearer maintainer",
      "x-maintainer-approval": approvalHeader(maintainer.subject),
    };
    const now = Date.now();
    const scheduled = await app.inject({
      method: "POST",
      url: "/status/maintenance",
      headers,
      payload: {
        startsAt: new Date(now - 1000).toISOString(),
        endsAt: new Date(now + 60_000).toISOString(),
        reason: "Scheduled maintenance",
      },
    });
    expect(scheduled.statusCode).toBe(200);
    expect(scheduled.json()).toMatchObject({ scheduled: true });
    expect((await app.inject({ method: "GET", url: "/status" })).json().status).toBe("maintenance");

    const reversed = await app.inject({
      method: "POST",
      url: "/status/maintenance",
      headers,
      payload: {
        startsAt: new Date(now + 60_000).toISOString(),
        endsAt: new Date(now).toISOString(),
        reason: "Invalid maintenance",
      },
    });
    expect(reversed.statusCode).toBe(400);

    const cleared = await app.inject({
      method: "POST",
      url: "/status/maintenance/clear",
      headers,
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toEqual({ cleared: true });
    expect((await app.inject({ method: "GET", url: "/status" })).json().status).toBe("healthy");
  });
});
