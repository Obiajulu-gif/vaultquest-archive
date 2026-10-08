import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { permissionPreviewRoutes } from "../src/routes/permissionPreview.js";
import { requirePermission, walletSessionResolver } from "../src/middleware/rbac.js";
import { errorHandler } from "../src/middleware/errorHandler.js";

describe("Maintainer permission preview API", () => {
  async function build() {
    const app = Fastify();
    app.setErrorHandler(errorHandler);
    const resolver = walletSessionResolver({ validateSession: async (t) => t === "admin" ? { walletAddress: "GADMIN" } : t === "user" ? { walletAddress: "GUSER" } : null }, ["GADMIN"]);
    app.register(permissionPreviewRoutes(requirePermission("admin.audit.write", [resolver]), () => ({
      version: 1, roles: { user: ["own.data.read"] }, actors: { GUSER: ["user"] },
    })));
    await app.ready();
    return app;
  }
  const payload = { baseVersion: 1, proposedPolicy: { version: 2, roles: { user: ["own.data.read", "admin.audit.write"] }, actors: { GUSER: ["user"] } } };

  it("denies missing credentials and non-maintainers even with forged actor roles", async () => {
    const app = await build();
    try {
      for (const [token, status] of [["", 401], ["user", 403]] as const) {
        const response = await app.inject({ method: "POST", url: "/admin/permissions/preview", headers: { authorization: `Bearer ${token}` }, payload: { ...payload, actorRoles: ["maintainer"] } });
        expect(response.statusCode).toBe(status);
      }
    } finally { await app.close(); }
  });

  it("shows actor impact and blocks preparation until the exact diff is confirmed", async () => {
    const app = await build();
    try {
      const post = (action: string, body: Record<string, unknown>) => app.inject({ method: "POST", url: `/admin/permissions/${action}`, headers: { authorization: "Bearer admin" }, payload: body });
      const preview = (await post("preview", payload)).json();
      expect(preview.actorDiffs[0].actor).toBe("GUSER");
      expect((await post("prepare", payload)).statusCode).toBe(409);
      const confirmed = await post("prepare", { ...payload, confirmationToken: preview.confirmationToken });
      expect(confirmed.statusCode).toBe(200);
      expect(confirmed.json().activated).toBe(false);
      expect((await post("prepare", { ...payload, baseVersion: 0 })).statusCode).toBe(400);
      expect((await post("prepare", { ...payload, baseVersion: 2 })).statusCode).toBe(409);
    } finally { await app.close(); }
  });
});
