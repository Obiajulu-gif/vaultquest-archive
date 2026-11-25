import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { permissionPolicyRevision, permissionMatrixPreviewRoutes } from "../src/routes/permissionMatrixPreview.js";
import { requirePermission, type PrincipalResolver } from "../src/middleware/rbac.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { ROLE_PERMISSIONS } from "../../lib/rbac.js";

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });
function build() {
  const app = Fastify();
  apps.push(app);
  const resolver: PrincipalResolver = async (req) => {
    const role = req.headers.authorization;
    return role === "maintainer" || role === "user" || role === "service" ? { role, subject: role } : null;
  };
  app.register(permissionMatrixPreviewRoutes(requirePermission("admin.permissions.preview", [resolver])));
  app.setErrorHandler(errorHandler);
  return app;
}
const url = "/admin/permissions/matrix-preview";
describe("permission preview", () => {
  it("computes deterministic grants and revocations without mutating policy, including retries", async () => {
    const app = build();
    const original = JSON.stringify(ROLE_PERMISSIONS);
    const request = { method: "POST" as const, url, headers: { authorization: "maintainer" }, payload: {
      expected_revision: permissionPolicyRevision(), roles: { user: ["admin.audit.read", "admin.audit.read"] },
    } };
    const first = await app.inject(request);
    expect(first.statusCode).toBe(200);
    expect(first.json().data.changes[0]).toMatchObject({ added: ["admin.audit.read"], removed: ROLE_PERMISSIONS.user.slice().sort() });
    expect((await app.inject(request)).json()).toEqual(first.json());
    expect(JSON.stringify(ROLE_PERMISSIONS)).toBe(original);
  });
  it("handles no-op and empty replacement", async () => {
    const app = build();
    for (const [roles, changed] of [[{ user: ROLE_PERMISSIONS.user }, false], [{ user: [] }, true]] as const) {
      const res = await app.inject({ method: "POST", url, headers: { authorization: "maintainer" }, payload: { roles } });
      expect(res.json().data.changed).toBe(changed);
    }
  });
  it("rejects stale revisions and permits retry with a fresh revision", async () => {
    const app = build();
    for (const [revision, status] of [["stale", 409], [permissionPolicyRevision(), 200]] as const) {
      const res = await app.inject({ method: "POST", url, headers: { authorization: "maintainer" }, payload: { roles: { user: [] }, expected_revision: revision } });
      expect(res.statusCode).toBe(status);
    }
  });
  it("rejects malformed and unknown roles or permissions", async () => {
    const app = build();
    for (const roles of [{}, { root: [] }, { user: ["unknown"] }, { user: null }]) {
      expect((await app.inject({ method: "POST", url, headers: { authorization: "maintainer" }, payload: { roles } })).statusCode).toBe(400);
    }
  });
  it("authenticates before validating and denies users and services", async () => {
    const app = build();
    for (const [authorization, status] of [["", 401], ["user", 403], ["service", 403]] as const) {
      expect((await app.inject({ method: "POST", url, headers: { authorization }, payload: {} })).statusCode).toBe(status);
    }
  });
});
