import { describe, expect, it, vi } from "vitest";
import { validateRestoredDatabase } from "../src/scripts/validateRestore.js";

const TABLES = [
  "action_ledger",
  "chain_events",
  "indexer_checkpoints",
  "pool_registry",
  "saved_pools",
  "vault_settlements",
  "user_quests",
  "reward_grants",
];

function mockDb(countFor: (sql: string) => number = () => 0, tables = TABLES) {
  const tx = {
    $executeRawUnsafe: vi.fn(async () => 0),
    $queryRawUnsafe: vi.fn(async (sql: string) => {
      if (sql.includes("to_regclass")) return tables.map((table_name) => ({ table_name }));
      return [{ count: countFor(sql) }];
    }),
  };
  return {
    tx,
    prisma: {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as any,
  };
}

describe("validateRestoredDatabase", () => {
  it("runs a read-only consistent snapshot and passes clean invariants", async () => {
    const { prisma, tx } = mockDb();
    const report = await validateRestoredDatabase(prisma);

    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith("SET TRANSACTION READ ONLY");
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "RepeatableRead",
    });
    expect(report).toMatchObject({ readOnly: true, status: "valid", failureCount: 0 });
  });

  it("reports missing core tables and detected inconsistent records", async () => {
    const { prisma } = mockDb((sql) => Number(sql.includes("verified_payload")), TABLES.filter((name) => name !== "chain_events"));
    const report = await validateRestoredDatabase(prisma);

    expect(report.status).toBe("needs_review");
    expect(report.missingTables).toEqual(["chain_events"]);
    expect(report.checks.find((check) => check.name === "confirmed actions missing verified event payload")?.count).toBe(1);
    expect(report.failureCount).toBe(2);
  });
});
