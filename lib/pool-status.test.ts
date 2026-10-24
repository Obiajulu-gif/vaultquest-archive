import { describe, it, expect } from "vitest";
import {
  ARCHIVE_STALE_THRESHOLD_MS,
  POOL_STATUS,
  ROUND_STATUS,
  getPoolStatusMeta,
  getRoundStatusMeta,
  isArchiveEntryStale,
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

describe("isArchiveEntryStale (#622)", () => {
  const NOW = new Date("2026-06-15T12:00:00Z").getTime();

  it("is not stale when verified within the threshold", () => {
    const verifiedAt = new Date(NOW - 1 * 60 * 60 * 1000).toISOString(); // 1h ago
    expect(isArchiveEntryStale(verifiedAt, NOW)).toBe(false);
  });

  it("is stale once verification age exceeds the threshold", () => {
    const verifiedAt = new Date(NOW - (ARCHIVE_STALE_THRESHOLD_MS + 1)).toISOString();
    expect(isArchiveEntryStale(verifiedAt, NOW)).toBe(true);
  });

  it("is exactly on the boundary as not-yet-stale", () => {
    const verifiedAt = new Date(NOW - ARCHIVE_STALE_THRESHOLD_MS).toISOString();
    expect(isArchiveEntryStale(verifiedAt, NOW)).toBe(false);
  });

  it("treats a missing or null verifiedAt as stale rather than trusting it silently", () => {
    expect(isArchiveEntryStale(null, NOW)).toBe(true);
    expect(isArchiveEntryStale(undefined, NOW)).toBe(true);
    expect(isArchiveEntryStale("", NOW)).toBe(true);
  });

  it("treats an unparseable verifiedAt as stale", () => {
    expect(isArchiveEntryStale("not-a-date", NOW)).toBe(true);
  });

  it("treats a verifiedAt in the future as stale (clock skew / bad data)", () => {
    const verifiedAt = new Date(NOW + 60 * 60 * 1000).toISOString(); // 1h in the future
    expect(isArchiveEntryStale(verifiedAt, NOW)).toBe(true);
  });

  it("accepts a custom threshold", () => {
    const verifiedAt = new Date(NOW - 10 * 60 * 1000).toISOString(); // 10m ago
    expect(isArchiveEntryStale(verifiedAt, NOW, 5 * 60 * 1000)).toBe(true);
    expect(isArchiveEntryStale(verifiedAt, NOW, 15 * 60 * 1000)).toBe(false);
  });

  it("defaults `now` to the current time when omitted", () => {
    const verifiedAt = new Date().toISOString();
    expect(isArchiveEntryStale(verifiedAt)).toBe(false);
  });
});
