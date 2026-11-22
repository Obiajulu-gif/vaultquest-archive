/**
 * Issue #995 — Dry-run policy evaluator route.
 *
 * POST /admin/policy/dry-run
 *
 * Evaluates a set of candidate records against the current BusinessPolicy
 * configuration in read-only mode. Returns per-record outcomes and a summary
 * of how many records would be allowed vs denied.
 *
 * Authorization:
 *   - Requires `admin.audit.write` permission (maintainer role).
 *
 * Request body:
 * {
 *   "records": [
 *     { "id": "<opaque string>", "input": { "rule": "deposit", "amount": 100 } },
 *     ...
 *   ],
 *   "policyOverrides": {
 *     "maximumDeposit": 5000
 *   }
 * }
 *
 * Response:
 * {
 *   "rule": "deposit",
 *   "totalEvaluated": 3,
 *   "totalAllowed": 2,
 *   "totalDenied": 1,
 *   "affectedIds": ["rec-3"],
 *   "records": [ { "id": "rec-1", "outcome": "allow", ... }, ... ],
 *   "evaluatedAt": "<ISO8601>",
 *   "clean": false
 * }
 *
 * Error paths:
 *   - 400 — invalid payload (Zod) or limit exceeded
 *   - 401 — missing / invalid credentials
 *   - 403 — insufficient permission
 *
 * This route is entirely read-only and has no rollback requirement.
 */

import type { FastifyPluginAsync, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import { BusinessPolicyEngine, type BusinessPolicyOverrides } from "../../../lib/business-policy.js";
import { PolicyDryRunService, InvalidPolicyInputError } from "../services/policyDryRunService.js";
import { AppError } from "../errors.js";

// ── Zod schemas ──────────────────────────────────────────────────────────────

const businessPolicyInputSchema = z.discriminatedUnion("rule", [
  z.object({ rule: z.literal("deposit"), amount: z.number() }),
  z.object({
    rule: z.literal("withdrawal"),
    amount: z.number().optional(),
    lockedUntilLedger: z.number().int().optional(),
    currentLedger: z.number().int().optional(),
  }),
  z.object({
    rule: z.literal("claim"),
    availableAmount: z.number(),
    deadline: z.number().nullable().optional(),
    now: z.number(),
  }),
  z.object({
    rule: z.literal("credit_yield"),
    amount: z.number(),
    distributableYield: z.number(),
  }),
  z.object({
    rule: z.literal("draw"),
    prize: z.number(),
    eligibleParticipants: z.number().int().optional(),
  }),
  z.object({
    rule: z.literal("quest_reward"),
    amount: z.number(),
  }),
  z.object({
    rule: z.literal("lockup_weight"),
    lockupDays: z.number().int(),
  }),
]);

const recordSchema = z.object({
  id: z.string().min(1).max(256),
  input: businessPolicyInputSchema,
});

const lockupWeightTierSchema = z.object({
  maxDays: z.number().int().nullable(),
  multiplierBps: z.number().int().positive(),
});

const policyOverridesSchema = z.object({
  minimumDeposit: z.number().nonnegative().optional(),
  maximumDeposit: z.number().positive().nullable().optional(),
  maximumWithdrawal: z.number().positive().nullable().optional(),
  minimumPrize: z.number().nonnegative().optional(),
  minimumEligibleParticipants: z.number().int().positive().optional(),
  minimumQuestReward: z.number().nonnegative().optional(),
  maximumQuestReward: z.number().positive().nullable().optional(),
  lockupWeightTiers: z.array(lockupWeightTierSchema).min(1).optional(),
}).optional();

const bodySchema = z.object({
  records: z.array(recordSchema).min(1).max(500),
  policyOverrides: policyOverridesSchema,
});

const dryRunService = new PolicyDryRunService();

// ── Route plugin ─────────────────────────────────────────────────────────────

export const policyDryRunRoutes = (
  guard: preHandlerHookHandler
): FastifyPluginAsync =>
  async (app) => {
    /**
     * POST /admin/policy/dry-run
     *
     * Evaluates submitted records against the business policy (with optional
     * overrides) and returns per-record outcomes without modifying any state.
     */
    app.post(
      "/admin/policy/dry-run",
      { preHandler: [guard] },
      async (req, reply) => {
        if (req.principal?.role !== "maintainer") {
          throw AppError.forbidden("maintainer role required");
        }

        let body: z.infer<typeof bodySchema>;
        try {
          body = bodySchema.parse(req.body);
        } catch (err) {
          throw AppError.validation(err instanceof Error ? err.message : "Invalid request body");
        }

        // Build the policy engine — policy constructor throws on invalid config.
        let policy: BusinessPolicyEngine;
        try {
          policy = new BusinessPolicyEngine(
            body.policyOverrides as BusinessPolicyOverrides | undefined
          );
        } catch (err) {
          throw AppError.validation(
            err instanceof Error ? err.message : "Invalid policy overrides"
          );
        }

        try {
          const result = dryRunService.evaluate(policy, body.records);
          reply.header("Cache-Control", "no-store");
          return reply.code(200).send({ ok: true, data: result });
        } catch (err) {
          if (err instanceof InvalidPolicyInputError) {
            throw AppError.validation(err.message);
          }
          throw err;
        }
      }
    );
  };
