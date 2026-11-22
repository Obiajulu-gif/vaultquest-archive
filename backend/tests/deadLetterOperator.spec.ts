import { describe, it, expect } from "vitest";
import type { JobFailure, JobRecord } from "../src/worker/types.js";
import { planDeadLetterRetries, summarizeDeadLetters } from "../src/services/deadLetterOperator.js";

function failure(overrides: Partial<JobFailure> = {}): JobFailure {
  return { attempt: 3, at: "2026-01-01T00:00:00.000Z", code: "INTERNAL", message: "boom", retryable: false, ...overrides };
}

function job(overrides: Partial<JobRecord> = {}): JobRecord {
  const base: JobRecord = {
    id: overrides.id ?? "job-1",
    type: "draw_proof",
    payload: {},
    idempotencyKey: "key-1",
    status: "dead",
    attempts: 3,
    maxAttempts: 3,
    runAt: new Date("2026-01-01T00:00:00.000Z"),
    lockedBy: null,
    lockedAt: null,
    correlationId: null,
    lastError: failure(),
    failures: [failure()],
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    completedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
  return { ...base, ...overrides };
}

describe("dead-letter operator (#980)", () => {
  it("summarizes only dead jobs, by type and reason", () => {
    const summary = summarizeDeadLetters([
      job({ id: "a", type: "draw_proof", lastError: failure({ code: "INTERNAL", retryable: true }), failures: [failure(), failure()] }),
      job({ id: "b", type: "draw_proof" }),
      job({ id: "c", type: "settle", lastError: failure({ code: "SETTLEMENT_SUBMIT_FAILED" }) }),
      job({ id: "d", status: "succeeded" }),
    ]);

    expect(summary.total).toBe(3);
    expect(summary.byType).toEqual({ draw_proof: 2, settle: 1 });
    expect(summary.byLastErrorCode).toEqual({ INTERNAL: 2, SETTLEMENT_SUBMIT_FAILED: 1 });
    expect(summary.totalFailedAttempts).toBe(4);
    expect(summary.retryable).toBe(1);
    expect(summary.nonRetryable).toBe(2);
  });

  it("reports empty backlog as zeroed with null timestamps", () => {
    const summary = summarizeDeadLetters([job({ status: "queued" })]);
    expect(summary).toMatchObject({ total: 0, totalFailedAttempts: 0, oldestCreatedAt: null, newestCreatedAt: null });
  });

  it("plans retries oldest-first and skips non-dead jobs", () => {
    const plan = planDeadLetterRetries([
      job({ id: "newer", createdAt: new Date("2026-02-01T00:00:00.000Z") }),
      job({ id: "older", createdAt: new Date("2026-01-01T00:00:00.000Z") }),
      job({ id: "live", status: "running" }),
    ]);
    expect(plan.candidates).toEqual(["older", "newer"]);
    expect(plan.skipped).toEqual([{ id: "live", reason: "not_dead" }]);
  });

  it("bounds the retry set by limit and filters by type", () => {
    const plan = planDeadLetterRetries(
      [
        job({ id: "a", type: "draw_proof" }),
        job({ id: "b", type: "draw_proof" }),
        job({ id: "c", type: "settle" }),
      ],
      { limit: 1, type: "draw_proof" },
    );
    expect(plan.candidates).toEqual(["a"]);
    expect(plan.skipped).toContainEqual({ id: "b", reason: "limit_reached" });
    expect(plan.skipped).toContainEqual({ id: "c", reason: "type_filtered" });
  });
});
