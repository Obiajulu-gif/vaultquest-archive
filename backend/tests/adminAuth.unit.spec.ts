import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { createRequireAdminSession } from "../src/middleware/auth.js";

function buildTestApp(validateSession: ReturnType<typeof vi.fn>, adminWallets = ["GADMIN"]) {
  const app = Fastify();
  const walletAuth = { validateSession };
  app.get(
    "/admin-only",
    { preHandler: [createRequireAdminSession(walletAuth as any, adminWallets)] },
    async () => ({ ok: true })
  );
  return app;
}

describe("createRequireAdminSession", () => {
  it("rejects missing bearer tokens", async () => {
    const app = buildTestApp(vi.fn());
    const res = await app.inject({ method: "GET", url: "/admin-only" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("rejects forged bearer tokens with no server session", async () => {
    const validateSession = vi.fn().mockResolvedValue(null);
    const app = buildTestApp(validateSession);

    const res = await app.inject({
      method: "GET",
      url: "/admin-only",
      headers: { authorization: "Bearer forged-client-token" }
    });

    expect(res.statusCode).toBe(401);
    expect(validateSession).toHaveBeenCalledWith("forged-client-token");
    await app.close();
  });

  it("rejects valid non-admin wallet sessions", async () => {
    const validateSession = vi.fn().mockResolvedValue({
      id: "session-1",
      walletAddress: "GNOTADMIN",
      publicKey: "GNOTADMIN",
      network: "TESTNET"
    });
    const app = buildTestApp(validateSession);

    const res = await app.inject({
      method: "GET",
      url: "/admin-only",
      headers: { authorization: "Bearer valid-session-token" }
    });

    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("allows server-verified admin wallet sessions", async () => {
    const validateSession = vi.fn().mockResolvedValue({
      id: "session-1",
      walletAddress: "gadmin",
      publicKey: "gadmin",
      network: "TESTNET"
    });
    const app = buildTestApp(validateSession, ["GADMIN"]);

    const res = await app.inject({
      method: "GET",
      url: "/admin-only",
      headers: { authorization: "Bearer valid-session-token" }
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    await app.close();
  });
});
