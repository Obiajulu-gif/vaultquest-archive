/**
 * Unit tests for the `withRetry` exponential-backoff utility (issue #274).
 *
 * All tests inject `sleep: async () => {}` to avoid real timers.
 */

import { describe, it, expect, vi } from "vitest";
import { withRetry, isRetryableError } from "../src/utils/retry.js";

const noSleep = async () => {};

// ─── isRetryableError ─────────────────────────────────────────────────────────

describe("isRetryableError", () => {
  it("returns true for known transient codes in error message", () => {
    expect(isRetryableError(new Error("timeout"))).toBe(true);
    expect(isRetryableError(new Error("ETIMEDOUT"))).toBe(true);
    expect(isRetryableError(new Error("ECONNRESET"))).toBe(true);
    expect(isRetryableError(new Error("tx_bad_seq"))).toBe(true);
    expect(isRetryableError(new Error("tx_too_late"))).toBe(true);
    expect(isRetryableError(new Error("503 service unavailable"))).toBe(true);
    expect(isRetryableError(new Error("504 gateway timeout"))).toBe(true);
    expect(isRetryableError(new Error("429 too many requests"))).toBe(true);
  });

  it("returns true when resultCode property matches", () => {
    expect(isRetryableError({ resultCode: "tx_bad_seq" })).toBe(true);
    expect(isRetryableError({ resultCode: "timeout" })).toBe(true);
  });

  it("returns false for non-retryable errors", () => {
    expect(isRetryableError(new Error("tx_insufficient_balance"))).toBe(false);
    expect(isRetryableError(new Error("tx_no_account"))).toBe(false);
    expect(isRetryableError(new Error("validation failed"))).toBe(false);
    expect(isRetryableError(null)).toBe(false);
    expect(isRetryableError(undefined)).toBe(false);
  });
});

// ─── withRetry ────────────────────────────────────────────────────────────────

describe("withRetry", () => {
  it("resolves immediately when the first attempt succeeds", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn, { sleep: noSleep });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on a retryable error and resolves on a later attempt", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("timeout"))
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValue("eventual");

    const result = await withRetry(fn, { maxAttempts: 5, sleep: noSleep });
    expect(result).toBe("eventual");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("throws immediately on a non-retryable error without further attempts", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("tx_insufficient_balance"));
    await expect(withRetry(fn, { maxAttempts: 5, sleep: noSleep })).rejects.toThrow(
      "tx_insufficient_balance"
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("throws after exhausting maxAttempts on persistent retryable errors", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("timeout"));
    await expect(
      withRetry(fn, { maxAttempts: 3, sleep: noSleep })
    ).rejects.toThrow("timeout");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("calls sleep between retries", async () => {
    const sleepSpy = vi.fn().mockResolvedValue(undefined);
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValue("done");

    await withRetry(fn, { maxAttempts: 3, baseDelayMs: 100, sleep: sleepSpy });
    expect(sleepSpy).toHaveBeenCalledTimes(1);
    // Delay is capped random(0, 100) — just verify it's a non-negative number.
    expect(sleepSpy.mock.calls[0]![0]).toBeGreaterThanOrEqual(0);
  });

  it("does not call sleep on non-retryable failure", async () => {
    const sleepSpy = vi.fn().mockResolvedValue(undefined);
    const fn = vi.fn().mockRejectedValue(new Error("tx_no_account"));
    await expect(withRetry(fn, { sleep: sleepSpy })).rejects.toThrow();
    expect(sleepSpy).not.toHaveBeenCalled();
  });

  it("respects a custom isRetryable predicate", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("custom_transient"))
      .mockResolvedValue("ok");

    const result = await withRetry(fn, {
      sleep: noSleep,
      isRetryable: (err) => err instanceof Error && err.message === "custom_transient"
    });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("uses maxAttempts default of 4", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("timeout"));
    await expect(withRetry(fn, { sleep: noSleep })).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(4);
  });
});
