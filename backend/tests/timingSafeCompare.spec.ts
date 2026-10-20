/**
 * Tests for the constant-time string comparison helper (issue #584).
 *
 * Timing itself is impractical to assert reliably in a unit test, so the
 * bar here is correctness: identical secrets match, near-miss and
 * different-length secrets are rejected, and mismatched-length inputs
 * never throw (crypto.timingSafeEqual throws on unequal-length buffers,
 * which the helper must avoid by hashing to a fixed length first).
 */

import { describe, it, expect } from "vitest";
import { timingSafeStringEqual } from "../src/utils/timingSafeCompare.js";

describe("timingSafeStringEqual", () => {
  it("returns true for identical strings", () => {
    expect(timingSafeStringEqual("super-secret-key", "super-secret-key")).toBe(true);
  });

  it("returns false when strings differ only in the last character", () => {
    expect(timingSafeStringEqual("super-secret-key", "super-secret-kex")).toBe(false);
  });

  it("returns false when strings differ only in the first character", () => {
    expect(timingSafeStringEqual("super-secret-key", "xuper-secret-key")).toBe(false);
  });

  it("returns false for strings of different lengths without throwing", () => {
    expect(() => timingSafeStringEqual("short", "a-much-longer-secret-value")).not.toThrow();
    expect(timingSafeStringEqual("short", "a-much-longer-secret-value")).toBe(false);
  });

  it("returns true for two empty strings", () => {
    expect(timingSafeStringEqual("", "")).toBe(true);
  });

  it("returns false when only one side is empty", () => {
    expect(timingSafeStringEqual("", "non-empty")).toBe(false);
  });
});
