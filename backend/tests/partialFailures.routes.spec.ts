import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../src/middleware/errorHandler.js";
import {
  requirePermission,
  type Principal,
  type PrincipalResolver,
} from "../src/middleware/rbac.js";
import { partialFailureRoutes } from "../src/routes/partialFailures.js";
import {
  PartialFailureError,
  type PartialFailureRecord,
  type PartialFailureService,
} from "../src/services/partialFailureService.js";

const maintainer: Principal = { role: "maintainer", subject: "wallet-maintainer" };
const user: Principal = { role: "user", subject: "wallet-user" };
const id = "e37b41b1-331a-42ba-96ea-2791e68c8684";

const failure: PartialFailureRecord = {
  id,
  operationType: "wallet_flow",
  operationId: "op-123",
  externalRef: null,
  severity: "high",
  state: "unresolved",
  retryable: true,
  description: "Receipt has not been issued",
  metadata: null,
  detectedAt: new Date("2026-10-20T10:00:00Z"),
  staleSinceAt: null,
  lastRetriedAt: null,
  resolvedAt: null,
  resolvedBy: null,
  resolutionNote: null,
  ignoredAt: null,
  ignoredBy: null,
  updatedAt: new Date("2026-10-20T10:00:00Z"),
};

describe("partial failure dashboard routes", () => {
  const service = {
    summary: vi.fn(),
    list: vi.fn(),
    getById: vi.fn(),
    record: vi.fn(),
    markRetried: vi.fn(),
    resolve: vi.fn(),
    ignore: vi.fn(),
  };
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    vi.resetAllMocks();
    service.summary.mockResolvedValue({
      total: 1,
      by_severity: { high: 1 },
      by_operation_type: { wallet_flow: 1 },
      stale_count: 0,
      retryable_count: 1,
    });
    service.list.mockResolvedValue({ items: [failure], nextCursor: null });
    service.getById.mockResolvedValue(failure);
    service.record.mockResolvedValue(failure);
    service.markRetried.mockResolvedValue(failure);
    service.resolve.mockResolvedValue(failure);
    service.ignore.mockResolvedValue(failure);

    const resolvePrincipal: PrincipalResolver = async (request) => {
      if (request.headers.authorization === "Bearer maintainer") return maintainer;
      if (request.headers.authorization === "Bearer user") return user;
      return null;
    };
    app = Fastify();
    app.setErrorHandler(errorHandler);
    app.register(partialFailureRoutes(service as unknown as PartialFailureService, {
      read: requirePermission("admin.recovery.read", [resolvePrincipal]),
      write: requirePermission("admin.recovery.write", [resolvePrincipal]),
    }));
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("allows maintainers to load summary and filtered pages, but not users or anonymous callers", async () => {
    const anonymous = await app.inject({ method: "GET", url: "/admin/partial-failures/summary" });
    expect(anonymous.statusCode).toBe(401);

    const userResponse = await app.inject({
      method: "GET",
      url: "/admin/partial-failures",
      headers: { authorization: "Bearer user" },
    });
    expect(userResponse.statusCode).toBe(403);

    const summary = await app.inject({
      method: "GET",
      url: "/admin/partial-failures/summary",
      headers: { authorization: "Bearer maintainer" },
    });
    expect(summary.statusCode).toBe(200);
    expect(summary.json().data.total).toBe(1);

    const list = await app.inject({
      method: "GET",
      url: "/admin/partial-failures?state=unresolved&severity=high&retryable=true&limit=10",
      headers: { authorization: "Bearer maintainer" },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().data[0]).toMatchObject({
      id,
      operation_type: "wallet_flow",
      state: "unresolved",
    });
    expect(service.list).toHaveBeenCalledWith(expect.objectContaining({
      state: "unresolved",
      severity: "high",
      retryable: true,
      limit: 10,
    }));
  });

  it("records failures idempotently and validates invalid dashboard input", async () => {
    const unauthorized = await app.inject({
      method: "POST",
      url: "/admin/partial-failures",
      payload: {
        operation_type: "wallet_flow",
        operation_id: "op-123",
        description: "Receipt has not been issued",
      },
    });
    expect(unauthorized.statusCode).toBe(401);

    const payload = {
      operation_type: "wallet_flow",
      operation_id: "op-123",
      severity: "high",
      retryable: true,
      description: "Receipt has not been issued",
      metadata: { access_token: "do-not-store" },
    };
    const created = await app.inject({
      method: "POST",
      url: "/admin/partial-failures",
      headers: { authorization: "Bearer maintainer" },
      payload,
    });
    expect(created.statusCode).toBe(200);
    expect(service.record).toHaveBeenCalledWith(expect.objectContaining({
      operationType: "wallet_flow",
      operationId: "op-123",
    }));
    const invalid = await app.inject({
      method: "GET",
      url: "/admin/partial-failures?limit=201",
      headers: { authorization: "Bearer maintainer" },
    });
    expect(invalid.statusCode).toBe(400);
  });

  it("records retry outcomes for the authenticated actor and reports illegal transitions", async () => {
    const retried = await app.inject({
      method: "POST",
      url: `/admin/partial-failures/${id}/retry`,
      headers: { authorization: "Bearer maintainer" },
      payload: { outcome: "still_failing" },
    });
    expect(retried.statusCode).toBe(200);
    expect(service.markRetried).toHaveBeenCalledWith(id, maintainer, "still_failing");

    service.markRetried.mockRejectedValueOnce(
      new PartialFailureError("ILLEGAL_TRANSITION", "failure is already resolved"),
    );
    const repeated = await app.inject({
      method: "POST",
      url: `/admin/partial-failures/${id}/retry`,
      headers: { authorization: "Bearer maintainer" },
      payload: { outcome: "resolved" },
    });
    expect(repeated.statusCode).toBe(409);
  });
});
