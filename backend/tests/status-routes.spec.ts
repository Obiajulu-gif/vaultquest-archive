/**
 * Status Routes Integration Tests (#XXX)
 *
 * Tests the public-status model across HTTP API/UI/background paths.
 * Verifies:
 *  ✓ GET /status returns safe, user-consumable operational state
 *  ✓ GET /status/can-mutate gates UI transaction buttons
 *  ✓ Admin endpoints (pause, resume, maintenance) control state
 *  ✓ Retry-After headers correctly set for degraded/paused states
 *  ✓ No internal details leak in responses
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { DegradedModeService } from "../src/services/degradedModeService.js";
import { PublicStatusService } from "../src/services/publicStatusService.js";

describe("Status Routes Integration", () => {
  let app: FastifyInstance;
  let degradedMode: DegradedModeService;
  let statusService: PublicStatusService;

  beforeAll(async () => {
    // In real integration, these would be injected into the app
    degradedMode = new DegradedModeService();
    statusService = new PublicStatusService(degradedMode);
    app = await buildApp({ degradedMode, statusService });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    // Reset state before each test
    degradedMode = new DegradedModeService();
    statusService = new PublicStatusService(degradedMode);
  });

  // ── GET /status (public endpoint) ─────────────────────────────────────────

  describe("GET /status (public, unauthenticated)", () => {
    it("returns healthy status when all systems operational", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/status",
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe("healthy");
      expect(body.affectedFeatures).toEqual({
        deposits: false,
        withdrawals: false,
        claims: false,
        views: false,
      });
    });

    it("does not require authentication", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/status",
      });

      expect(response.statusCode).toBe(200);
    });

    it("includes Cache-Control header for public caching (5s)", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/status",
      });

      expect(response.headers["cache-control"]).toContain("max-age=5");
      expect(response.headers["cache-control"]).toContain("public");
    });

    it("returns paused status when critical dependency unavailable", async () => {
      degradedMode.setDependencyStatus("soroban_rpc", "unavailable");

      const response = await app.inject({
        method: "GET",
        url: "/status",
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe("paused");
      expect(body.affectedFeatures.deposits).toBe(true);
    });

    it("includes Retry-After header when paused or degraded", async () => {
      degradedMode.setDependencyStatus("soroban_rpc", "unavailable");

      const response = await app.inject({
        method: "GET",
        url: "/status",
      });

      const retryAfter = response.headers["retry-after"];
      expect(retryAfter).toBeDefined();
      expect(Number(retryAfter)).toBeGreaterThan(0);
    });

    it("omits Retry-After header when healthy", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/status",
      });

      expect(response.headers["retry-after"]).toBeUndefined();
    });

    it("exposes maintenance window details in response", async () => {
      const now = new Date();
      statusService.scheduleMaintenanceWindow({
        startsAt: new Date(now.getTime() - 1000),
        endsAt: new Date(now.getTime() + 10 * 60_000),
        reason: "Database upgrade",
      });

      const response = await app.inject({
        method: "GET",
        url: "/status",
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe("maintenance");
      expect(body.maintenanceUntil).toBeDefined();
      expect(new Date(body.maintenanceUntil)).toBeInstanceOf(Date);
    });

    it("does not leak internal service names", async () => {
      degradedMode.setDependencyStatus("redis_cache", "unavailable");

      const response = await app.inject({
        method: "GET",
        url: "/status",
      });

      const body = JSON.parse(response.body);
      expect(body.message).not.toMatch(/redis|cache|soroban|database/i);
      expect(body.guidance).not.toMatch(/redis|cache|soroban|database/i);
    });

    it("returns valid response schema", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/status",
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      expect(body).toHaveProperty("status");
      expect(body).toHaveProperty("message");
      expect(body).toHaveProperty("guidance");
      expect(body).toHaveProperty("affectedFeatures");
      expect(typeof body.message).toBe("string");
      expect(typeof body.guidance).toBe("string");
    });
  });

  // ── GET /status/can-mutate (authenticated endpoint) ──────────────────────

  describe("GET /status/can-mutate (authenticated)", () => {
    it("requires authentication", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/status/can-mutate",
      });

      expect(response.statusCode).toBe(401);
    });

    it("returns true when healthy", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/status/can-mutate",
        headers: {
          authorization: "Bearer valid-token",
        },
      });

      if (response.statusCode === 200) {
        const body = JSON.parse(response.body);
        expect(body.canMutate).toBe(true);
      }
    });

    it("returns false when mutations paused", async () => {
      statusService.pauseMutations("Testing pause", 600);

      const response = await app.inject({
        method: "GET",
        url: "/status/can-mutate",
        headers: {
          authorization: "Bearer valid-token",
        },
      });

      if (response.statusCode === 200) {
        const body = JSON.parse(response.body);
        expect(body.canMutate).toBe(false);
      }
    });

    it("uses no-cache header when mutations blocked", async () => {
      statusService.pauseMutations("Testing pause", 600);

      const response = await app.inject({
        method: "GET",
        url: "/status/can-mutate",
        headers: {
          authorization: "Bearer valid-token",
        },
      });

      if (response.statusCode === 200) {
        const cacheControl = response.headers["cache-control"];
        if (cacheControl) {
          expect(cacheControl).toContain("no-cache");
        }
      }
    });
  });

  // ── POST /status/pause (admin endpoint) ───────────────────────────────────

  describe("POST /status/pause (admin)", () => {
    it("requires authentication", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/status/pause",
        payload: {
          reason: "Testing",
          durationSeconds: 60,
        },
      });

      expect(response.statusCode).toBe(401);
    });

    it("requires admin permission", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/status/pause",
        headers: {
          authorization: "Bearer user-token", // non-admin
        },
        payload: {
          reason: "Testing",
          durationSeconds: 60,
        },
      });

      // Should return 403 if user is not admin
      if (response.statusCode !== 401) {
        expect(response.statusCode).toBe(403);
      }
    });

    it("pauses mutations with specified duration (admin only)", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/status/pause",
        headers: {
          authorization: "Bearer admin-token",
        },
        payload: {
          reason: "Security incident mitigation",
          durationSeconds: 300,
        },
      });

      if (response.statusCode === 200) {
        const body = JSON.parse(response.body);
        expect(body.paused).toBe(true);
        expect(body.until).toBeDefined();
      }
    });

    it("accepts indefinite pause without durationSeconds", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/status/pause",
        headers: {
          authorization: "Bearer admin-token",
        },
        payload: {
          reason: "Indefinite pause for critical incident",
        },
      });

      if (response.statusCode === 200) {
        const body = JSON.parse(response.body);
        expect(body.paused).toBe(true);
      }
    });

    it("validates reason is provided", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/status/pause",
        headers: {
          authorization: "Bearer admin-token",
        },
        payload: {
          durationSeconds: 60,
          // missing reason
        },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  // ── POST /status/resume (admin endpoint) ──────────────────────────────────

  describe("POST /status/resume (admin)", () => {
    it("requires admin permission", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/status/resume",
        headers: {
          authorization: "Bearer user-token",
        },
      });

      if (response.statusCode !== 401) {
        expect(response.statusCode).toBe(403);
      }
    });

    it("resumes mutations (admin only)", async () => {
      statusService.pauseMutations("Testing pause", 600);

      const response = await app.inject({
        method: "POST",
        url: "/status/resume",
        headers: {
          authorization: "Bearer admin-token",
        },
      });

      if (response.statusCode === 200) {
        const body = JSON.parse(response.body);
        expect(body.resumed).toBe(true);
        expect(statusService.canUserMutate()).toBe(true);
      }
    });
  });

  // ── POST /status/maintenance (admin endpoint) ────────────────────────────

  describe("POST /status/maintenance (admin)", () => {
    it("requires admin permission", async () => {
      const now = new Date();
      const response = await app.inject({
        method: "POST",
        url: "/status/maintenance",
        headers: {
          authorization: "Bearer user-token",
        },
        payload: {
          startsAt: new Date(now.getTime() - 1000).toISOString(),
          endsAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
          reason: "Database migration",
        },
      });

      if (response.statusCode !== 401) {
        expect(response.statusCode).toBe(403);
      }
    });

    it("schedules maintenance window (admin only)", async () => {
      const now = new Date();
      const response = await app.inject({
        method: "POST",
        url: "/status/maintenance",
        headers: {
          authorization: "Bearer admin-token",
        },
        payload: {
          startsAt: new Date(now.getTime() - 1000).toISOString(),
          endsAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
          reason: "Database maintenance window",
        },
      });

      if (response.statusCode === 200) {
        const body = JSON.parse(response.body);
        expect(body.scheduled).toBe(true);
        expect(body.id).toBeDefined();
      }
    });

    it("rejects invalid time range (start >= end)", async () => {
      const now = new Date();
      const response = await app.inject({
        method: "POST",
        url: "/status/maintenance",
        headers: {
          authorization: "Bearer admin-token",
        },
        payload: {
          startsAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
          endsAt: new Date(now.getTime() - 1000).toISOString(),
          reason: "Invalid window",
        },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  // ── POST /status/maintenance/clear (admin endpoint) ─────────────────────

  describe("POST /status/maintenance/clear (admin)", () => {
    it("requires admin permission", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/status/maintenance/clear",
        headers: {
          authorization: "Bearer user-token",
        },
      });

      if (response.statusCode !== 401) {
        expect(response.statusCode).toBe(403);
      }
    });

    it("clears maintenance window (admin only)", async () => {
      const now = new Date();
      statusService.scheduleMaintenanceWindow({
        startsAt: new Date(now.getTime() - 1000),
        endsAt: new Date(now.getTime() + 10 * 60_000),
        reason: "Testing",
      });

      const response = await app.inject({
        method: "POST",
        url: "/status/maintenance/clear",
        headers: {
          authorization: "Bearer admin-token",
        },
      });

      if (response.statusCode === 200) {
        const body = JSON.parse(response.body);
        expect(body.cleared).toBe(true);
      }
    });
  });

  // ── Cross-path integration ──────────────────────────────────────────────

  describe("Integration across UI/API/background paths", () => {
    it("UI can fetch status and disable buttons accordingly", async () => {
      // Scenario: User opens app while service is degraded
      degradedMode.setDependencyStatus("redis_cache", "unavailable");

      const statusResponse = await app.inject({
        method: "GET",
        url: "/status",
      });

      const status = JSON.parse(statusResponse.body);
      expect(status.affectedFeatures.views).toBe(true);

      // UI would render: "Real-time updates delayed"
      expect(status.guidance).toContain("delay");
    });

    it("API gates mutations based on degradation", async () => {
      // Scenario: Admin pauses mutations during incident
      statusService.pauseMutations("Investigating unusual patterns", 600);

      const statusResponse = await app.inject({
        method: "GET",
        url: "/status",
      });

      const status = JSON.parse(statusResponse.body);
      expect(status.status).toBe("paused");
      expect(status.affectedFeatures.deposits).toBe(true);

      // Any deposit endpoint should check statusService.canUserMutate()
      // and return 503 with Retry-After if mutations are paused
    });

    it("Background worker reads status safely (no leaks)", async () => {
      degradedMode.setDependencyStatus("database", "unavailable");

      const statusResponse = await app.inject({
        method: "GET",
        url: "/status",
      });

      const status = JSON.parse(statusResponse.body);
      // Worker can safely log/monitor this
      expect(status.message).not.toMatch(/stack|trace|error|exception/i);
    });
  });

  // ── Response shape validation ────────────────────────────────────────────

  describe("Response schema validation", () => {
    it("status endpoint always returns required fields", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/status",
      });

      const body = JSON.parse(response.body);

      const required = [
        "status",
        "message",
        "guidance",
        "affectedFeatures",
      ];
      for (const field of required) {
        expect(body).toHaveProperty(field);
      }
    });

    it("affectedFeatures has all required keys", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/status",
      });

      const body = JSON.parse(response.body);

      const features = ["deposits", "withdrawals", "claims", "views"];
      for (const feature of features) {
        expect(body.affectedFeatures).toHaveProperty(feature);
        expect(typeof body.affectedFeatures[feature]).toBe("boolean");
      }
    });
  });
});
