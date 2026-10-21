import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { z } from "zod";
import { ERROR_CODES } from "../src/constants.js";
import {
  ERROR_CATALOG,
  ERROR_CATEGORIES,
  describeError,
  toUserSafeError
} from "../src/errorTaxonomy.js";
import {
  formatProblemDetails,
  PROBLEM_DETAILS_CONTENT_TYPE,
  PROBLEM_TYPE_BASE_URI,
  extractInvalidParams
} from "../src/problemDetails.js";
import { AppError } from "../src/errors.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import correlation from "../src/middleware/correlation.js";
import { validateBody, validateQuery } from "../src/middleware/validate.js";

function buildTestApp() {
  const app = Fastify();
  app.register(correlation);
  app.setErrorHandler(errorHandler);

  app.get("/deposit-error", async () => {
    throw new AppError(ERROR_CODES.VAULT_DEPOSIT_BELOW_MIN, 400, "Deposit amount 5 XLM is below minimum 10 XLM");
  });

  app.get("/round-error", async () => {
    throw new AppError(ERROR_CODES.ROUND_LOCKED, 409, "Round 4 is locked");
  });

  app.get("/quest-error", async () => {
    throw new AppError(ERROR_CODES.QUEST_UNFUNDED, 409, "Reward escrow not funded");
  });

  app.get("/wallet-error", async () => {
    throw new AppError(ERROR_CODES.WALLET_UNSUPPORTED_NETWORK, 400, "Unsupported network");
  });

  app.get("/indexer-error", async () => {
    throw new AppError(ERROR_CODES.RECONCILIATION_MISMATCH, 409, "Discrepancy detected in action ledger");
  });

  app.post("/validation", {
    preHandler: validateBody(z.object({
      amount: z.number().positive(),
      poolId: z.string().uuid()
    }))
  }, async () => ({ ok: true }));

  return app;
}

describe("RFC 7807 / RFC 9457 Problem Details Taxonomy (#946)", () => {
  const app = buildTestApp();

  describe("formatProblemDetails unit formatting", () => {
    it("formats standard RFC 7807 properties with stable code and remediation hint", () => {
      const p = formatProblemDetails(ERROR_CODES.VAULT_INVALID_AMOUNT, 400, {
        errorId: "err-123",
        instance: "/actions",
        message: "Invalid amount given"
      });

      expect(p.type).toBe(`${PROBLEM_TYPE_BASE_URI}/VAULT_INVALID_AMOUNT`);
      expect(p.title).toBe("Validation Error");
      expect(p.status).toBe(400);
      expect(p.detail).toBe("Invalid amount given");
      expect(p.instance).toBe("/actions");
      expect(p.code).toBe(ERROR_CODES.VAULT_INVALID_AMOUNT);
      expect(p.category).toBe("validation");
      expect(p.retryable).toBe(false);
      expect(p.remediation).toBeDefined();
      expect(p.error_id).toBe("err-123");
      expect(p.timestamp).toBeDefined();
    });

    it("extracts invalid_params from validation issues array", () => {
      const issues = [
        { path: ["body", "amount"], message: "Expected positive number" },
        { path: ["body", "poolId"], message: "Invalid UUID format" }
      ];
      const params = extractInvalidParams(issues);
      expect(params).toEqual([
        { name: "body.amount", reason: "Expected positive number" },
        { name: "body.poolId", reason: "Invalid UUID format" }
      ]);
    });
  });

  describe("Drift Prevention: Complete Taxonomy Catalog Coverage", () => {
    it("verifies every ERROR_CODE has an entry in ERROR_CATALOG", () => {
      for (const [name, code] of Object.entries(ERROR_CODES)) {
        const entry = ERROR_CATALOG[code];
        expect(entry, `Missing catalog entry for code: ${code} (${name})`).toBeDefined();
        expect(ERROR_CATEGORIES).toContain(entry.category);
        expect(entry.userMessage.trim().length).toBeGreaterThan(0);
        expect(typeof entry.retryable).toBe("boolean");
        expect(entry.recovery, `Missing remediation hint for code: ${code}`).toBeDefined();
        expect(entry.recovery!.trim().length).toBeGreaterThan(0);
      }
    });

    it("ensures no unmapped or dangling codes exist in ERROR_CATALOG", () => {
      const catalogKeys = Object.keys(ERROR_CATALOG).sort();
      const errorCodesValues = Object.values(ERROR_CODES).sort();
      expect(catalogKeys).toEqual(errorCodesValues);
    });
  });

  describe("Domain Vertical Slices", () => {
    it("vault deposits slice: returns stable error code, safe message and remediation hint", async () => {
      const res = await app.inject({ method: "GET", url: "/deposit-error" });
      expect(res.statusCode).toBe(400);
      const body = res.json();

      // Top-level RFC 7807 properties
      expect(body.type).toBe(`${PROBLEM_TYPE_BASE_URI}/VAULT_DEPOSIT_BELOW_MIN`);
      expect(body.code).toBe("VAULT_DEPOSIT_BELOW_MIN");
      expect(body.category).toBe("validation");
      expect(body.status).toBe(400);
      expect(body.remediation).toContain("minimum");

      // Backward compatible error envelope
      expect(body.error.code).toBe("VAULT_DEPOSIT_BELOW_MIN");
      expect(body.error.recovery).toBe(body.remediation);
    });

    it("prize rounds slice: returns conflict problem details with state explanation", async () => {
      const res = await app.inject({ method: "GET", url: "/round-error" });
      expect(res.statusCode).toBe(409);
      const body = res.json();

      expect(body.type).toBe(`${PROBLEM_TYPE_BASE_URI}/ROUND_LOCKED`);
      expect(body.code).toBe("ROUND_LOCKED");
      expect(body.category).toBe("conflict");
      expect(body.remediation).toContain("upcoming round");
      expect(body.error.code).toBe("ROUND_LOCKED");
    });

    it("quests slice: returns unfunded escrow problem details with creator remediation", async () => {
      const res = await app.inject({ method: "GET", url: "/quest-error" });
      expect(res.statusCode).toBe(409);
      const body = res.json();

      expect(body.type).toBe(`${PROBLEM_TYPE_BASE_URI}/QUEST_UNFUNDED`);
      expect(body.code).toBe("QUEST_UNFUNDED");
      expect(body.remediation).toContain("fund the reward escrow");
    });

    it("wallet flows slice: returns network mismatch problem details with switch guidance", async () => {
      const res = await app.inject({ method: "GET", url: "/wallet-error" });
      expect(res.statusCode).toBe(400);
      const body = res.json();

      expect(body.type).toBe(`${PROBLEM_TYPE_BASE_URI}/WALLET_UNSUPPORTED_NETWORK`);
      expect(body.code).toBe("WALLET_UNSUPPORTED_NETWORK");
      expect(body.category).toBe("wallet");
      expect(body.remediation).toContain("Switch your wallet network");
    });

    it("indexer reconciliation slice: returns reconciliation mismatch problem details with quarantine hint", async () => {
      const res = await app.inject({ method: "GET", url: "/indexer-error" });
      expect(res.statusCode).toBe(409);
      const body = res.json();

      expect(body.type).toBe(`${PROBLEM_TYPE_BASE_URI}/RECONCILIATION_MISMATCH`);
      expect(body.code).toBe("RECONCILIATION_MISMATCH");
      expect(body.remediation).toContain("dual-control review");
    });
  });

  describe("Content Negotiation and Validation Details", () => {
    it("sets application/problem+json content-type when requested via Accept header", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/deposit-error",
        headers: { accept: PROBLEM_DETAILS_CONTENT_TYPE }
      });
      expect(res.statusCode).toBe(400);
      expect(res.headers["content-type"]).toContain(PROBLEM_DETAILS_CONTENT_TYPE);
    });

    it("includes invalid_params and issues for payload validation failures", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/validation",
        payload: { amount: -5, poolId: "not-a-uuid" }
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();

      expect(body.code).toBe(ERROR_CODES.INVALID_PAYLOAD);
      expect(body.invalid_params).toBeDefined();
      expect(body.invalid_params.length).toBeGreaterThan(0);
      expect(body.error.issues).toBeDefined();
    });
  });
});
