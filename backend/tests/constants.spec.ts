import { describe, it, expect } from "vitest";
import { canTransition, ACTION_STATUSES, TERMINAL_STATUSES } from "../src/constants.js";

describe("state transitions", () => {
  it("allows pending -> submitted", () => {
    expect(canTransition("pending", "submitted")).toBe(true);
  });

  it("allows pending -> failed", () => {
    expect(canTransition("pending", "failed")).toBe(true);
  });

  it("allows submitted -> confirmed", () => {
    expect(canTransition("submitted", "confirmed")).toBe(true);
  });

  it("allows submitted -> reverted", () => {
    expect(canTransition("submitted", "reverted")).toBe(true);
  });

  it("allows submitted -> orphaned", () => {
    expect(canTransition("submitted", "orphaned")).toBe(true);
  });

  it("does not allow an orphaned transaction to be resubmitted", () => {
    expect(canTransition("orphaned", "submitted")).toBe(false);
  });

  it("rejects confirmed -> pending", () => {
    expect(canTransition("confirmed", "pending")).toBe(false);
  });

  it("rejects reverted -> confirmed", () => {
    expect(canTransition("reverted", "confirmed")).toBe(false);
  });

  it("rejects pending -> confirmed", () => {
    expect(canTransition("pending", "confirmed")).toBe(false);
  });

  it("includes all six statuses", () => {
    expect(ACTION_STATUSES).toHaveLength(6);
  });

  it("identifies terminal statuses", () => {
    expect(TERMINAL_STATUSES).toEqual(
      expect.arrayContaining(["confirmed", "failed", "reverted", "orphaned"])
    );
    expect(TERMINAL_STATUSES).not.toContain("pending");
    expect(TERMINAL_STATUSES).not.toContain("submitted");
  });
});
