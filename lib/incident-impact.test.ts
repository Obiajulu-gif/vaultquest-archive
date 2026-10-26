import { describe, expect, it } from "vitest";
import { calculateIncidentImpact } from "./incident-impact";

const rows = [
  { userId: "user-b", recordId: "vault-2", operation: "draw", severity: "high" as const, occurredAt: "2026-01-02T00:00:00Z" },
  { userId: "user-a", recordId: "vault-1", operation: "deposit", severity: "critical" as const, occurredAt: "2026-01-03T00:00:00Z" },
];

describe("calculateIncidentImpact", () => {
  it("returns deterministic aggregates and a redacted shareable view", () => {
    const result = calculateIncidentImpact(rows, { from: "2026-01-01T00:00:00Z", to: "2026-01-04T00:00:00Z" });
    expect(result.internal.users).toEqual(["user-a", "user-b"]);
    expect(result.internal.severity).toBe("critical");
    expect(result.shareable).not.toHaveProperty("users");
    expect(result.shareable.affectedRecordCount).toBe(2);
  });
  it("returns zero impact for a window with no matching records", () => {
    expect(calculateIncidentImpact(rows, { from: "2026-02-01T00:00:00Z", to: "2026-02-02T00:00:00Z" }).internal.count).toBe(0);
  });
});
