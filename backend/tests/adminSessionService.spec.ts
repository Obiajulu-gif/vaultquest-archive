import { describe, expect, it } from "vitest";
import { AdminSessionService } from "../src/services/adminSessionService.js";

function row(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "session-token",
    walletAddress: "GADMIN",
    signature: "signature",
    audience: "/admin",
    roleVersion: 1,
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date(),
    revokedAt: null,
    ...overrides,
  };
}

describe("AdminSessionService revocation authority", () => {
  it("rejects a token revoked by another worker after it was cached locally", async () => {
    const stored = row();
    const prisma = {
      adminSession: {
        create: async () => stored,
        findUnique: async () => stored,
        update: async () => stored,
        updateMany: async () => ({ count: 0 }),
      },
    };
    const service = new AdminSessionService(prisma as any);

    expect(await service.verifySession("session-token")).not.toBeNull();
    stored.revokedAt = new Date(); // Simulates bulk revocation in another process.
    expect(await service.verifySession("session-token")).toBeNull();
  });

  it("fails closed at the exact expiry boundary", async () => {
    const prisma = { adminSession: { findUnique: async () => row({ expiresAt: new Date() }) } };
    const service = new AdminSessionService(prisma as any);
    expect(await service.verifySession("session-token")).toBeNull();
  });
});
