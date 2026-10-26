import { describe, expect, it, vi } from "vitest";
import { evaluateDegradedMode, fallbackAction } from "./degraded-fallback";

describe("degraded dependency fallback", () => {
  it("allows safe reads while blocking critical writes when unavailable", () => {
    expect(fallbackAction("degraded", false)).toBe("allow");
    expect(fallbackAction("degraded", true)).toBe("read-only");
    expect(fallbackAction("unavailable", true)).toBe("block");
  });
  it("emits deterministic transition events and supports recovery", () => {
    const onTransition = vi.fn();
    const degraded = evaluateDegradedMode([{ name: "rpc", state: "degraded", checkedAt: "2026-01-01T00:00:00Z" }], {}, onTransition);
    expect(onTransition).toHaveBeenCalledOnce();
    evaluateDegradedMode([{ name: "rpc", state: "healthy", checkedAt: "2026-01-01T00:01:00Z" }], degraded, onTransition);
    expect(onTransition).toHaveBeenLastCalledWith({ dependency: "rpc", from: "degraded", to: "healthy", at: "2026-01-01T00:01:00Z" });
  });
});
