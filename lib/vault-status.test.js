import { describe, it, expect } from "vitest";
import { ROUND_STATUS, getRoundStatusMeta } from "@/lib/vault-status";

describe("getRoundStatusMeta", () => {
  it("returns a distinct, consistent label for each known status", () => {
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
    expect(getRoundStatusMeta("unknown")).toEqual(getRoundStatusMeta(ROUND_STATUS.PENDING));
  });
});
