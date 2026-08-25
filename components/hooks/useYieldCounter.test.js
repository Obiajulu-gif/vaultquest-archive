import { describe, it, expect } from "vitest";
import { yieldPerSecond } from "@/lib/yield-counter";

describe("yieldPerSecond", () => {
  it("computes per-second accrual from APY", () => {
    const rate = yieldPerSecond(1000, 10);
    const perYear = rate * 365 * 24 * 60 * 60;
    expect(perYear).toBeCloseTo(100, 2);
  });

  it("returns 0 for invalid inputs", () => {
    expect(yieldPerSecond(0, 10)).toBe(0);
    expect(yieldPerSecond(1000, 0)).toBe(0);
  });
});
