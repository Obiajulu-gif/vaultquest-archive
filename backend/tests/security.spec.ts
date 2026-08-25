import { describe, it, expect, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { randomUUID } from "node:crypto";

describe("Security Middleware Integration Tests (Rate Limiting & CSRF)", () => {
  const internalSecret = "test-internal-secret-123456";

  const getMockPrisma = () => {
    return {
      actionLedger: {
        findUnique: vi.fn(),
        create: vi.fn(),
        groupBy: vi.fn(),
        findMany: vi.fn()
      },
      savedPool: {
        findMany: vi.fn()
      },
      indexerCheckpoint: {
        findUnique: vi.fn(),
        upsert: vi.fn().mockResolvedValue({ id: "singleton" })
      }
    } as any;
  };

  describe("CSRF Protection", () => {
    it("sets a CSRF token cookie on GET requests", async () => {
      const mockPrisma = getMockPrisma();
      const app = buildApp({ prisma: mockPrisma, internalSecret });

      const res = await app.inject({
        method: "GET",
        url: "/health"
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers["x-csrf-token"]).toBeDefined();
      expect(res.headers["set-cookie"]).toBeDefined();
      expect(res.headers["set-cookie"]).toContain("csrf-token=");
      await app.close();
    });

    it("blocks POST requests without a valid CSRF token with 403 Forbidden", async () => {
      const mockPrisma = getMockPrisma();
      const app = buildApp({ prisma: mockPrisma, internalSecret });

      const res = await app.inject({
        method: "POST",
        url: "/actions",
        payload: {
          wallet_address: "GBX7Q4DMXD66VFR7YJ3HYBFFW7Q5PNE7A5PXH5XN265LSL73GOHX4Y6A",
          action_type: "deposit",
          action_payload: {}
        }
      });

      expect(res.statusCode).toBe(403);
      const body = res.json();
      expect(body.error.code).toBe("FORBIDDEN");
      expect(body.error.message).toContain("CSRF");
      await app.close();
    });

    it("allows POST requests with matching CSRF cookie and header", async () => {
      const mockPrisma = getMockPrisma();
      mockPrisma.actionLedger.findUnique.mockResolvedValue(null);
      mockPrisma.actionLedger.create.mockResolvedValue({
        id: randomUUID(),
        idempotencyKey: randomUUID(),
        walletAddress: "GBX7Q4DMXD66VFR7YJ3HYBFFW7Q5PNE7A5PXH5XN265LSL73GOHX4Y6A",
        actionType: "deposit",
        actionPayload: {},
        status: "pending",
        createdAt: new Date(),
        updatedAt: new Date()
      });

      const app = buildApp({ prisma: mockPrisma, internalSecret });

      // First, get the CSRF token
      const getRes = await app.inject({
        method: "GET",
        url: "/health"
      });
      const csrfToken = getRes.headers["x-csrf-token"] as string;

      // Extract set-cookie
      const setCookie = getRes.headers["set-cookie"] as string;

      // Make POST request with matching token in cookie and header
      const key = randomUUID();
      const postRes = await app.inject({
        method: "POST",
        url: "/actions",
        headers: {
          "idempotency-key": key,
          "x-csrf-token": csrfToken,
          cookie: setCookie
        },
        payload: {
          wallet_address: "GBX7Q4DMXD66VFR7YJ3HYBFFW7Q5PNE7A5PXH5XN265LSL73GOHX4Y6A",
          action_type: "deposit",
          action_payload: {}
        }
      });

      // 201 Created or 200 depending on idempotency check
      expect([200, 201]).toContain(postRes.statusCode);
      await app.close();
    });

    it("skips CSRF check for internal routes", async () => {
      const mockPrisma = getMockPrisma();
      mockPrisma.indexerCheckpoint.findUnique.mockResolvedValue(null);

      const app = buildApp({ prisma: mockPrisma, internalSecret });

      const res = await app.inject({
        method: "POST",
        url: "/internal/checkpoint",
        headers: {
          "x-internal-secret": internalSecret
        },
        payload: {
          latest_ledger: 104523,
          success: true
        }
      });

      // 200 since it is authorized via internal secret and skips CSRF check
      expect(res.statusCode).toBe(200);
      await app.close();
    });
  });

  describe("Rate Limiting", () => {
    it("blocks public requests after limit is reached (mocked limit window)", async () => {
      const mockPrisma = getMockPrisma();
      const app = buildApp({ prisma: mockPrisma, internalSecret });

      // public route limit is 100 requests. Let's make 101 requests from same IP.
      // In-memory test is extremely fast, so we can verify rate limiting kicks in.
      let lastStatus = 200;
      for (let i = 0; i < 105; i++) {
        const res = await app.inject({
          method: "GET",
          url: "/health"
        });
        lastStatus = res.statusCode;
        if (lastStatus === 429) {
          const body = res.json();
          expect(body.error.code).toBe("RATE_LIMIT_EXCEEDED");
          break;
        }
      }
      expect(lastStatus).toBe(429);
      await app.close();
    });

    it("blocks wallet auth challenge requests after 5 attempts", async () => {
      const mockPrisma = getMockPrisma();
      const app = buildApp({ prisma: mockPrisma, internalSecret });

      // First get a CSRF token
      const getRes = await app.inject({
        method: "GET",
        url: "/health"
      });
      const csrfToken = getRes.headers["x-csrf-token"] as string;
      const setCookie = getRes.headers["set-cookie"] as string;

      let lastStatus = 200;
      for (let i = 0; i < 7; i++) {
        const res = await app.inject({
          method: "POST",
          url: "/wallet-auth/challenge",
          headers: {
            "x-csrf-token": csrfToken,
            cookie: setCookie
          },
          payload: {
            wallet_address: "GBX7Q4DMXD66VFR7YJ3HYBFFW7Q5PNE7A5PXH5XN265LSL73GOHX4Y6A",
            public_key: "GBX7Q4DMXD66VFR7YJ3HYBFFW7Q5PNE7A5PXH5XN265LSL73GOHX4Y6A",
            network: "testnet"
          }
        });
        lastStatus = res.statusCode;
        if (lastStatus === 429) {
          const body = res.json();
          expect(body.error.code).toBe("RATE_LIMIT_EXCEEDED");
          expect(res.headers["retry-after"]).toBeDefined();
          break;
        }
      }
      expect(lastStatus).toBe(429);
      await app.close();
    });
  });
});
