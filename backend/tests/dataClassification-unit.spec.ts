import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Prisma } from "@prisma/client";
import { DATA_CLASSIFICATION, tablesOfKind } from "../src/services/dataClassification.js";

/**
 * #754 — the DR classification must cover every stored table, and the
 * recovery runbook must stay current as the schema changes.
 */

const runbook = readFileSync(fileURLToPath(new URL("../../docs/DISASTER_RECOVERY.md", import.meta.url)), "utf8");

describe("DATA_CLASSIFICATION (#754)", () => {
  it("classifies every Prisma model", () => {
    expect(Object.keys(DATA_CLASSIFICATION).sort()).toEqual(Object.values(Prisma.ModelName).sort());
  });

  it("lists every classified table in docs/DISASTER_RECOVERY.md with its class", () => {
    for (const { table, kind } of Object.values(DATA_CLASSIFICATION)) {
      expect(runbook, `${table} missing from the runbook`).toMatch(
        new RegExp(`\\| \`${table}\` \\| (\\*\\*)?${kind}(\\*\\*)? \\|`)
      );
    }
  });

  it("never truncates off-chain data during a rebuild", () => {
    const rebuilt = new Set([...tablesOfKind("chain-derived"), ...tablesOfKind("ephemeral")]);
    for (const table of tablesOfKind("off-chain")) expect(rebuilt.has(table)).toBe(false);
    expect(rebuilt.has("action_ledger")).toBe(false);
  });
});
