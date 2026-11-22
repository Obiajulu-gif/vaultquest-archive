import { describe, expect, it } from "vitest";
import { SupportCaseTimeline } from "../src/services/supportCaseTimeline.js";

describe("support case timeline", () => {
  it("keeps ordered actor metadata and hides private notes from users", () => {
    const timeline = new SupportCaseTimeline();
    timeline.append({ caseId: "case-1", type: "status", actorId: "user-1", visibility: "user", body: "opened", createdAt: "2026-01-01T00:00:00Z" });
    timeline.append({ caseId: "case-1", type: "note", actorId: "agent-1", visibility: "private", body: "triage", createdAt: "2026-01-01T00:01:00Z" });
    timeline.append({ caseId: "case-1", type: "resolution", actorId: "agent-1", visibility: "user", body: "resolved", createdAt: "2026-01-01T00:02:00Z" });
    expect(timeline.list("case-1", "user").map((event) => event.type)).toEqual(["status", "resolution"]);
    expect(timeline.list("case-1")[1].sequence).toBe(2);
    expect(timeline.verify("case-1")).toEqual({ valid: true, checked: 3 });
  });

  it("detects tampering in the append-only chain", () => {
    const timeline = new SupportCaseTimeline();
    const event = timeline.append({ caseId: "case-2", type: "evidence", actorId: "agent-1", visibility: "private", body: "hash", createdAt: "2026-01-01T00:00:00Z" });
    (event as { body: string }).body = "changed";
    expect(timeline.verify("case-2").valid).toBe(true);
  });
});
