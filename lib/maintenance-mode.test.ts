import { describe, expect, it } from "vitest";
import { canManageMaintenance, getMaintenanceBanner } from "./maintenance-mode";

const config = { message: "Draws are paused", areas: ["draws"], startsAt: "2026-01-01T00:00:00Z", endsAt: "2026-01-02T00:00:00Z", enabled: true };

describe("maintenance mode", () => {
  it("shows only active scoped banners and expires them", () => {
    expect(getMaintenanceBanner(config, "draws", new Date("2026-01-01T12:00:00Z"))).toEqual(config);
    expect(getMaintenanceBanner(config, "wallet", new Date("2026-01-01T12:00:00Z"))).toBeNull();
    expect(getMaintenanceBanner(config, "draws", new Date("2026-01-02T00:00:00Z"))).toBeNull();
  });
  it("limits configuration to authorized roles", () => {
    expect(canManageMaintenance("maintainer")).toBe(true);
    expect(canManageMaintenance("user")).toBe(false);
  });
});
