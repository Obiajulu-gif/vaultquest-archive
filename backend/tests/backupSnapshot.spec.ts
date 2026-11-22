import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateBackupSnapshot } from "../src/services/backupSnapshot.js";

function clean() {
  return JSON.parse(readFileSync(new URL("./fixtures/backup-snapshots/clean.json", import.meta.url), "utf8"));
}
describe("snapshot backup invariants (#844)", () => {
  it("validates the clean fixture without mutating it", () => {
    const snapshot = clean();
    const before = JSON.stringify(snapshot);
    expect(validateBackupSnapshot(snapshot)).toMatchObject({ readOnly: true, status: "valid", failureCount: 0 });
    expect(JSON.stringify(snapshot)).toBe(before);
  });
  it("detects a missing record from captured counts", () => {
    const snapshot = clean();
    snapshot.tables.users = [];
    expect(validateBackupSnapshot(snapshot).findings).toContainEqual(expect.objectContaining({ code: "MISSING_RECORD", table: "users" }));
  });
  it("detects a missing table, even if its count is removed too", () => {
    const snapshot = clean();
    delete snapshot.tables.users;
    delete snapshot.rowCounts.users;
    expect(validateBackupSnapshot(snapshot).findings).toContainEqual(expect.objectContaining({ code: "MISSING_TABLE", table: "users" }));
  });
  it("detects orphan pool, quest and action references", () => {
    const snapshot = clean();
    snapshot.tables.saved_pools[0].poolId = "missing";
    snapshot.tables.reward_grants[0].questId = "missing";
    snapshot.tables.action_ledger[0].sorobanEventId = "missing";
    expect(validateBackupSnapshot(snapshot).findings.filter((f) => f.code === "ORPHAN_REFERENCE")).toHaveLength(3);
  });
  it("detects duplicate primary and business keys without printing their values", () => {
    const snapshot = clean();
    snapshot.tables.action_ledger.push(snapshot.tables.action_ledger[0]);
    const report = validateBackupSnapshot(snapshot);
    expect(report.findings).toContainEqual(expect.objectContaining({ code: "DUPLICATE_KEY", table: "action_ledger" }));
    expect(JSON.stringify(report)).not.toContain("fixture-tx");
  });
  it("detects inconsistent confirmation, reward and settlement states", () => {
    const snapshot = clean();
    snapshot.tables.action_ledger[0].verifiedPayload = null;
    snapshot.tables.reward_grants[0].grantedAt = null;
    snapshot.tables.vault_settlements[0].state = "Resolved";
    expect(validateBackupSnapshot(snapshot).findings.filter((f) => f.code === "INCONSISTENT_STATE")).toHaveLength(3);
  });
  it("rejects invalid envelopes and malformed event fields", () => {
    expect(validateBackupSnapshot({ schema: "future" }).failureCount).toBe(1);
    const snapshot = clean();
    delete snapshot.tables.chain_events[0].txHash;
    expect(validateBackupSnapshot(snapshot).status).toBe("needs_review");
  });
});
