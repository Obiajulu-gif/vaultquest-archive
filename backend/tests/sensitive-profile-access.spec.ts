import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { usersRoutes } from "../src/routes/users.js";
import { SensitiveFieldAccessLogger } from "../../lib/sensitive-field-access.js";

describe("Sensitive profile access paths", () => {
  it("logs authorized profile reads and updates without email or wallet values", async () => {
    const logger = new SensitiveFieldAccessLogger();
    const prisma: any = { user: { findUnique: vi.fn(async () => ({ id: "id", email: "PRIVATE_EMAIL", walletAddress: "PRIVATE_WALLET" })) } };
    const app = Fastify();
    app.register(usersRoutes, { prisma, accessLogger: logger, prefix: "/api/users" });
    try {
      const headers = { authorization: "Bearer valid" };
      expect((await app.inject({ method: "GET", url: "/api/users/me", headers })).statusCode).toBe(200);
      expect((await app.inject({ method: "PUT", url: "/api/users/me", headers, payload: { email: "private@example.com" } })).statusCode).toBe(200);
      expect(logger.queryLogs().map((l) => l.purpose)).toEqual(["profile_read", "profile_update"]);
      const logs = JSON.stringify(logger.queryLogs());
      for (const value of ["PRIVATE_EMAIL", "PRIVATE_WALLET", "private@example.com", "valid"]) expect(logs).not.toContain(value);
    } finally { await app.close(); }
  });

  it("logs anonymous and invalid-token denials without reading the profile", async () => {
    const logger = new SensitiveFieldAccessLogger();
    const prisma: any = { user: { findUnique: vi.fn() } };
    const app = Fastify();
    app.register(usersRoutes, { prisma, accessLogger: logger, prefix: "/api/users" });
    try {
      for (const headers of [{}, { authorization: "Bearer invalid" }]) {
        expect((await app.inject({ method: "GET", url: "/api/users/me", headers })).statusCode).toBe(401);
      }
      expect(logger.queryLogs({ authorized: false })).toHaveLength(2);
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(JSON.stringify(logger.queryLogs())).not.toContain("invalid");
    } finally { await app.close(); }
  });
});
