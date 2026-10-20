import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type RepairScenario = { id: string; recordType: string; driftType: string; state: Record<string, unknown>; repair: { action: "quarantine" | "update" | "delete"; operatorSteps: string[] } };

export function validateRepairScenario(value: unknown): value is RepairScenario {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<RepairScenario>;
  const repair = item.repair;
  return typeof item.id === "string" && typeof item.recordType === "string" && typeof item.driftType === "string" && typeof item.state === "object" && item.state !== null && !!repair && ["quarantine", "update", "delete"].includes(repair.action) && Array.isArray(repair.operatorSteps) && repair.operatorSteps.length > 0 && repair.operatorSteps.every((step) => typeof step === "string");
}

export async function loadRepairScenario(id: string): Promise<RepairScenario> {
  const raw = JSON.parse(await readFile(join(process.cwd(), "tests", "fixtures", "repair-scenarios", `${id}.json`), "utf8")) as unknown;
  if (!validateRepairScenario(raw)) throw new Error(`Invalid repair scenario fixture: ${id}`);
  return raw;
}
