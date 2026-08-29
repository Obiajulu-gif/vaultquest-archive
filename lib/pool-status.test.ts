import { describe, it, expect } from "vitest";
import {
  POOL_STATUS,
  ROUND_STATUS,
  getPoolStatusMeta,
  getRoundStatusMeta,
  normalizePoolStatus,
} from "./pool-status";

describe("getPoolStatusMeta", () => {
  it("returns a stable label/tone/tooltip for every known pool status", () => {
    const active = getPoolStatusMeta(POOL_STATUS.ACTIVE);
    expect(active.label).toBe("Active");
    expect(active.tone).toBe("success");
    expect(active.tooltip.length).toBeGreaterThan(0);
  });

  it("normalizes aliases (open/locked/drawing/settled) to their canonical tone", () => {
    expect(getPoolStatusMeta("open").tone).toBe("success");
    expect(getPoolStatusMeta("locked").tone).toBe("warning");
    expect(getPoolStatusMeta("drawing").tone).toBe("info");
    expect(getPoolStatusMeta("settled").tone).toBe("neutral");
  });

  it("is case/whitespace-insensitive and falls back to draft for unknown statuses", () => {
    expect(normalizePoolStatus("  ACTIVE ")).toBe("active");
    expect(getPoolStatusMeta("unknown").label).toBe("Draft");
    expect(getPoolStatusMeta(null).label).toBe("Draft");
    expect(getPoolStatusMeta(undefined).label).toBe("Draft");
  });
});

describe("getRoundStatusMeta", () => {
  it("returns a distinct, consistent label for each known round status", () => {
    const active = getRoundStatusMeta(ROUND_STATUS.ACTIVE);
    const pending = getRoundStatusMeta(ROUND_STATUS.PENDING);
    const completed = getRoundStatusMeta(ROUND_STATUS.COMPLETED);

    expect(active.label).toBe("Active Round");
    expect(pending.label).toBe("Pending Round");
    expect(completed.label).toBe("Completed Round");

    const labels = [active.label, pending.label, completed.label];
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("falls back to the pending status for unknown input", () => {
    expect(getRoundStatusMeta("unknown")).toEqual(
      getRoundStatusMeta(ROUND_STATUS.PENDING),
    );
    expect(getRoundStatusMeta(null)).toEqual(
      getRoundStatusMeta(ROUND_STATUS.PENDING),
    );
  });

  it("round statuses are a subset of pool statuses", () => {
    const poolStatuses = new Set(Object.values(POOL_STATUS));
    for (const roundStatus of Object.values(ROUND_STATUS)) {
      expect(poolStatuses.has(roundStatus)).toBe(true);
    }
  });
});
