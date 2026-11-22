/**
 * Issue #995 — Dry-run policy evaluator with affected-record previews.
 *
 * This service evaluates a `BusinessPolicy` rule against a set of candidate
 * records in a read-only, non-mutating "dry-run" mode.  It returns:
 *
 *   - Whether each record would be allowed or denied
 *   - The specific denial code and message for denied records
 *   - A summary (totalAllowed, totalDenied, affectedIds)
 *
 * "Affected records" are those whose outcome differs from the implicit
 * default for the operation type:
 *   - For deposit/withdrawal/quest_reward rules, the default is "allow".
 *     Records that would be denied are "affected".
 *   - For draw/claim rules, the default is "allow".
 *     Records that would be denied are "affected".
 *
 * The evaluator never writes to the database.  It accepts an in-memory list
 * of candidate inputs rather than a Prisma query so it can be called from
 * any layer (route handler, admin CLI, test suite) without coupling to the
 * persistence model.
 *
 * Edge cases / recovery:
 *   - An individual record that throws an unexpected error is reported as
 *     denied with code "INTERNAL" rather than crashing the whole evaluation.
 *   - The preview is purely advisory; no locks are taken and no rows are
 *     modified.
 *   - If the BusinessPolicy constructor throws (invalid config), the error
 *     propagates to the caller as an InvalidPolicyInputError.
 */

import {
  BusinessPolicyEngine,
  type BusinessPolicyInput,
  type BusinessPolicyDecision,
} from "../../../lib/business-policy.js";

export interface DryRunRecord {
  /** Opaque caller-supplied identifier (e.g. actionId, walletAddress). */
  id: string;
  /** The policy rule to evaluate for this record. */
  input: BusinessPolicyInput;
}

export interface DryRunRecordResult {
  id: string;
  input: BusinessPolicyInput;
  outcome: "allow" | "deny" | "noop";
  code: string;
  message: string;
}

export interface DryRunResult {
  /** The rule that was evaluated (first record's rule, or "mixed" for heterogeneous sets). */
  rule: string;
  totalEvaluated: number;
  totalAllowed: number;
  totalDenied: number;
  /** IDs of records whose outcome is "deny" or "noop" (i.e. affected by the policy). */
  affectedIds: string[];
  records: DryRunRecordResult[];
  evaluatedAt: string;
  /** True when no records would be denied — policy passes cleanly. */
  clean: boolean;
}

export class InvalidPolicyInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPolicyInputError";
  }
}

export class PolicyDryRunService {
  /**
   * Evaluates `records` against a BusinessPolicyEngine instance and returns a
   * read-only preview of the outcomes.
   *
   * @param policy  An already-constructed BusinessPolicyEngine (caller controls config).
   * @param records The candidate records to evaluate.
   * @param limit   Maximum number of records (default 500; guards against large
   *                previews that would block the event loop).
   */
  evaluate(
    policy: BusinessPolicyEngine,
    records: DryRunRecord[],
    limit = 500
  ): DryRunResult {
    if (records.length > limit) {
      throw new InvalidPolicyInputError(
        `Dry-run preview limit exceeded: ${records.length} records submitted, maximum is ${limit}.`
      );
    }

    const results: DryRunRecordResult[] = records.map((rec) => {
      try {
        const decision: BusinessPolicyDecision = policy.evaluate(rec.input);
        return {
          id: rec.id,
          input: rec.input,
          outcome: decision.status,
          code: decision.code,
          message: decision.message,
        };
      } catch (err) {
        // Unexpected errors from the policy evaluator are surfaced as INTERNAL
        // denials rather than crashing the whole preview.
        return {
          id: rec.id,
          input: rec.input,
          outcome: "deny" as const,
          code: "INTERNAL",
          message: err instanceof Error ? err.message : "Unexpected evaluation error",
        };
      }
    });

    const totalAllowed = results.filter((r) => r.outcome === "allow").length;
    const totalDenied = results.filter((r) => r.outcome !== "allow").length;
    const affectedIds = results
      .filter((r) => r.outcome !== "allow")
      .map((r) => r.id);

    // Determine a representative rule name for the summary.
    const ruleSet = new Set(results.map((r) => r.input.rule));
    const rule = ruleSet.size === 1 ? [...ruleSet][0] : "mixed";

    return {
      rule,
      totalEvaluated: results.length,
      totalAllowed,
      totalDenied,
      affectedIds,
      records: results,
      evaluatedAt: new Date().toISOString(),
      clean: totalDenied === 0,
    };
  }
}
