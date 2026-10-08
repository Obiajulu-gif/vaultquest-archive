import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { DataExportService } from "../src/services/dataExport.js";
import { SensitiveFieldAccessLogger } from "../../lib/sensitive-field-access.js";
import { exportsRoutes } from "../src/routes/exports.js";
import { requirePermission, serviceSecretResolver, walletSessionResolver } from "../src/middleware/rbac.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { sensitiveAccessId } from "../src/utils/sensitiveAccessId.js";

describe("Sensitive export access paths", () => {
  const principal = { role: "user" as const, subject: "GALICE", walletAddress: "GALICE" };

  it("logs authorized bulk exports and denied wallet scopes without retaining values", async () => {
    const sink = vi.fn();
    const logger = new SensitiveFieldAccessLogger(undefined, sink);
    const actions = [1, 2].map((i) => ({ id: `a${i}`, actionType: "deposit", createdAt: new Date(),
      actionPayload: { amount: "SENSITIVE_AMOUNT", memo: "SECRET_MEMO" }, status: "confirmed", redactedAt: null }));
    const source: any = { listActions: vi.fn(async () => ({ items: actions, nextCursor: null })),
      listSavedPools: vi.fn(async () => ({ items: [], nextCursor: null })) };
    const svc = new DataExportService(source, logger);
    await svc.build({ principal });
    expect(logger.queryLogs()[0]).toMatchObject({ authorized: true, bulk: true, resourceCount: 2, actor: sensitiveAccessId("GALICE") });
    await expect(svc.build({ principal, wallet: "GBOB" })).rejects.toThrow("authorization scope");
    expect(logger.queryLogs({ authorized: false })).toHaveLength(1);
    expect(source.listActions).toHaveBeenCalledTimes(1);
    const serialized = JSON.stringify([logger.queryLogs(), sink.mock.calls]);
    expect(serialized).not.toContain("SENSITIVE_AMOUNT");
    expect(serialized).not.toContain("SECRET_MEMO");
    expect(serialized).not.toContain("GALICE");
    expect(serialized).not.toContain("GBOB");
  });

  it("captures anonymous and denied-role attempts before any data reads", async () => {
    const logger = new SensitiveFieldAccessLogger();
    const source: any = { listActions: vi.fn(), listSavedPools: vi.fn() };
    const app = Fastify();
    app.setErrorHandler(errorHandler);
    const resolver = walletSessionResolver({ validateSession: async () => null });
    app.register(exportsRoutes(new DataExportService(source, logger), requirePermission("own.data.export", [resolver, serviceSecretResolver("test-secret")], logger)));
    try {
      expect((await app.inject({ method: "GET", url: "/exports?wallet=GBOB" })).statusCode).toBe(401);
      expect((await app.inject({ method: "GET", url: "/exports?wallet=GBOB", headers: { "x-internal-secret": "test-secret" } })).statusCode).toBe(403);
      expect(logger.queryLogs()).toHaveLength(2);
      expect(logger.queryLogs().every((log) => !log.authorized && log.resourceId === "unspecified")).toBe(true);
      expect(JSON.stringify(logger.queryLogs())).not.toContain("test-secret");
      expect(source.listActions).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
});
