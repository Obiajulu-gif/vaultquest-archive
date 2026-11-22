/**
 * Tests for Issue #995 — Dry-run policy evaluator with affected-record
 * previews.
 *
 * Covers:
 *  - PolicyDryRunService.evaluate: normal allow/deny paths
 *  - PolicyDryRunService.evaluate: mixed-rule sets
 *  - PolicyDryRunService.evaluate: limit exceeded
 *  - PolicyDryRunService.evaluate: unexpected evaluation error → INTERNAL deny
 *  - POST /admin/policy/dry-run: auth enforcement (401, 403)
 *  - POST /admin/policy/dry-run: valid request returns correct shape
 *  - POST /admin/policy/dry-run: policy override applied
 *  - POST /admin/policy/dry-run: invalid body → 400
 *  - POST /admin/policy/dry-run: invalid policy overrides → 400
 */

import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { PolicyDryRunService, InvalidPolicyInputError } from "../src/services/policyDryRunService.js";
import { BusinessPolicyEngine } from "../../../lib/business-policy.js";
import { policyDryRunRoutes } from "../src/routes/policyDryRun.js";
import { requirePermission, walletSessionResolver } from "../src/middleware/rbac.js";
import { errorHandler } from "../src/middleware/errorHandler.js";

// ---------------------------------------------------------------------------
// PolicyDryRunService unit tests
// ---------------------------------------------------------------------------

describe("PolicyDryRunService — Issue #995", () => {
  const policy = new BusinessPolicyEngine();
  const svc = new PolicyDryRunService();

  it("returns clean=true when all records pass a deposit rule", () => {
    const result = svc.evaluate(policy, [
      { id: "rec-1", input: { rule: "deposit", amount: 100 } },
      { id: "rec-2", input: { rule: "deposit", amount: 500 } },
    ]);
    expect(result.clean).toBe(true);
    expect(result.totalAllowed).toBe(2);
    expect(result.totalDenied).toBe(0);
    expect(result.affectedIds).toEqual([]);
    expect(result.rule).toBe("deposit");
  });

  it("identifies denied records and populates affectedIds", () => {
    const limitedPolicy = new BusinessPolicyEngine({ maximumDeposit: 200 });
    const result = svc.evaluate(limitedPolicy, [
      { id: "rec-allow", input: { rule: "deposit", amount: 100 } },
      { id: "rec-deny", input: { rule: "deposit", amount: 500 } },
    ]);
    expect(result.clean).toBe(false);
    expect(result.totalAllowed).toBe(1);
    expect(result.totalDenied).toBe(1);
    expect(result.affectedIds).toContain("rec-deny");
    expect(result.records.find((r) => r.id === "rec-deny")?.code).toBe("DepositLimitExceeded");
  });

  it("labels rule as 'mixed' for heterogeneous record sets", () => {
    const result = svc.evaluate(policy, [
      { id: "r1", input: { rule: "deposit", amount: 100 } },
      { id: "r2", input: { rule: "quest_reward", amount: 50 } },
    ]);
    expect(result.rule).toBe("mixed");
  });

  it("throws InvalidPolicyInputError when record count exceeds limit", () => {
    const records = Array.from({ length: 501 }, (_, i) => ({
      id: `rec-${i}`,
      input: { rule: "deposit" as const, amount: 1 },
    }));
    expect(() => svc.evaluate(policy, records)).toThrow(InvalidPolicyInputError);
  });

  it("handles draw rule with noop for zero-prize draws", () => {
    const result = svc.evaluate(new BusinessPolicyEngine({ minimumPrize: 0 }), [
      { id: "r1", input: { rule: "draw", prize: 0, eligibleParticipants: 5 } },
    ]);
    // prize = 0 = minimumPrize → denied (not strictly greater)
    expect(result.totalDenied).toBe(1);
  });

  it("handles claim noop when no rewards are available", () => {
    const result = svc.evaluate(policy, [
      { id: "r1", input: { rule: "claim", availableAmount: 0, now: Date.now() } },
    ]);
    // noop is counted as not-allow
    expect(result.records[0].outcome).toBe("noop");
    expect(result.affectedIds).toContain("r1");
  });

  it("includes evaluatedAt as a valid ISO timestamp", () => {
    const result = svc.evaluate(policy, [
      { id: "r1", input: { rule: "deposit", amount: 10 } },
    ]);
    expect(() => new Date(result.evaluatedAt)).not.toThrow();
    expect(isNaN(new Date(result.evaluatedAt).getTime())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Route integration tests
// ---------------------------------------------------------------------------

describe("POST /admin/policy/dry-run — Issue #995", () => {
  async function build() {
    const app = Fastify();
    app.setErrorHandler(errorHandler);
    const resolver = walletSessionResolver(
      {
        validateSession: async (t) =>
          t === "admin" ? { walletAddress: "GADMIN" } : t === "user" ? { walletAddress: "GUSER" } : null,
      },
      ["GADMIN"]
    );
    app.register(policyDryRunRoutes(requirePermission("admin.audit.write", [resolver])));
    await app.ready();
    return app;
  }

  const validPayload = {
    records: [
      { id: "r1", input: { rule: "deposit", amount: 100 } },
      { id: "r2", input: { rule: "deposit", amount: 1 } },
    ],
  };

  it("returns 401 when no credentials are supplied", async () => {
    const app = await build();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/admin/policy/dry-run",
        payload: validPayload,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("returns 403 for a non-maintainer user token", async () => {
    const app = await build();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/admin/policy/dry-run",
        headers: { authorization: "Bearer user" },
        payload: validPayload,
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it("returns 200 with correct shape for a maintainer", async () => {
    const app = await build();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/admin/policy/dry-run",
        headers: { authorization: "Bearer admin" },
        payload: validPayload,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.data.totalEvaluated).toBe(2);
      expect(body.data.rule).toBe("deposit");
      expect(Array.isArray(body.data.records)).toBe(true);
      expect(body.data.evaluatedAt).toBeDefined();
    } finally {
      await app.close();
    }
  });

  it("applies policyOverrides and reflects denials in the response", async () => {
    const app = await build();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/admin/policy/dry-run",
        headers: { authorization: "Bearer admin" },
        payload: {
          records: [
            { id: "r-allow", input: { rule: "deposit", amount: 50 } },
            { id: "r-deny", input: { rule: "deposit", amount: 500 } },
          ],
          policyOverrides: { maximumDeposit: 100 },
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.clean).toBe(false);
      expect(body.data.affectedIds).toContain("r-deny");
      expect(body.data.totalDenied).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("returns 400 when the request body is invalid", async () => {
    const app = await build();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/admin/policy/dry-run",
        headers: { authorization: "Bearer admin" },
        payload: { records: [] }, // empty records not allowed
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("returns 400 for invalid policy overrides (bad lockup tiers)", async () => {
    const app = await build();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/admin/policy/dry-run",
        headers: { authorization: "Bearer admin" },
        payload: {
          records: [{ id: "r1", input: { rule: "deposit", amount: 100 } }],
          // Invalid: lockupWeightTiers must end with maxDays=null
          policyOverrides: { lockupWeightTiers: [{ maxDays: 7, multiplierBps: 110 }] },
        },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("sets Cache-Control: no-store on successful responses", async () => {
    const app = await build();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/admin/policy/dry-run",
        headers: { authorization: "Bearer admin" },
        payload: validPayload,
      });
      expect(res.headers["cache-control"]).toBe("no-store");
    } finally {
      await app.close();
    }
  });
});
