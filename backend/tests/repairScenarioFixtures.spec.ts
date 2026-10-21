import { describe, expect, it } from "vitest";
import { loadRepairScenario } from "../src/services/repairScenarioFixtures.js";

describe("repair scenario fixtures", () => {
  it("loads deterministic rare failure fixtures with a documented repair path", async () => {
    for (const id of ["stale-orphan", "orphaned-settlement"]) {
      const fixture = await loadRepairScenario(id);
      expect(fixture.id).toBe(id);
      expect(fixture.repair.operatorSteps.length).toBeGreaterThan(1);
    }
  });
});
