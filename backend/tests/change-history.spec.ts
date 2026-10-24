import { describe, it, expect, beforeEach } from "vitest";
import {
  ChangeHistoryService,
  InMemoryChangeHistoryStore,
  computeEntryHash,
  canonicalizePayload,
  GENESIS_HASH,
  type CriticalRecordType,
  type ChangeHistoryEntry,
} from "../src/services/changeHistoryService";

const RECORD: { recordType: CriticalRecordType; recordId: string } = {
  recordType: "vault_settlement",
  recordId: "vault_123",
};

/**
 * Tamper-evident change history for critical records (#787).
 *
 * Covers normal updates, rejected updates (no reason for a money/access change,
 * malformed CREATE/DELETE), and verification catching altered, missing and
 * out-of-order entries.
 */
function build() {
  const store = new InMemoryChangeHistoryStore();
  let tick = 0;
  const service = new ChangeHistoryService(store, {
    now: () => new Date(1_700_000_000_000 + tick++ * 1_000),
    idFactory: () => `chg_${tick}`,
  });
  return { store, service };
}

describe("change history — normal updates (#787)", () => {
  let store: InMemoryChangeHistoryStore;
  let service: ChangeHistoryService;

  beforeEach(() => {
    ({ store, service } = build());
  });

  it("records a create as the first chained entry", async () => {
    const entry = await service.append({
      ...RECORD,
      action: "CREATE",
      actor: "GADMIN",
      reason: "settlement opened",
      before: null,
      after: { amount: "100", status: "PENDING" },
    });

    expect(entry.sequence).toBe(1);
    expect(entry.prevHash).toBe(GENESIS_HASH);
    expect(entry.entryHash).toHaveLength(64);
    expect(entry.before).toBeNull();
  });

  it("links each update to the previous entry's hash", async () => {
    const first = await service.append({
      ...RECORD,
      action: "CREATE",
      actor: "GADMIN",
      reason: "open",
      before: null,
      after: { amount: "100" },
    });
    const second = await service.append({
      ...RECORD,
      action: "STATUS_CHANGE",
      actor: "GADMIN",
      reason: "funded",
      before: { status: "PENDING" },
      after: { status: "FUNDED" },
    });

    expect(second.sequence).toBe(2);
    expect(second.prevHash).toBe(first.entryHash);
    expect(await service.verify(RECORD.recordType, RECORD.recordId)).toMatchObject({ ok: true });
  });

  it("keeps chains independent per record", async () => {
    await service.append({ ...RECORD, action: "CREATE", actor: "A", reason: "r", before: null, after: {} });
    const other = await service.append({
      recordType: "vault_settlement",
      recordId: "vault_999",
      action: "CREATE",
      actor: "A",
      reason: "r",
      before: null,
      after: {},
    });

    expect(other.sequence).toBe(1);
    expect(other.prevHash).toBe(GENESIS_HASH);
  });

  it("serialises concurrent appends so the chain cannot fork", async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        service.append({
          ...RECORD,
          action: "UPDATE" as const,
          actor: "GADMIN",
          reason: `update ${i}`,
          before: { step: i },
          after: { step: i + 1 },
        }),
      ),
    );

    const history = await service.history(RECORD.recordType, RECORD.recordId);
    expect(history).toHaveLength(10);
    expect(history.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(await service.verify(RECORD.recordType, RECORD.recordId)).toMatchObject({ ok: true });
  });

  it("hashes independently of key order", () => {
    const payload = {
      id: "chg_1",
      recordType: "user" as CriticalRecordType,
      recordId: "r1",
      sequence: 1,
      action: "UPDATE" as const,
      actor: "A",
      reason: "r",
      before: null,
      after: { b: 2, a: 1 },
      timestamp: "2026-01-01T00:00:00.000Z",
      prevHash: GENESIS_HASH,
    };
    const reordered = { ...payload, after: { a: 1, b: 2 } };

    expect(canonicalizePayload(payload)).toBe(canonicalizePayload(reordered));
    expect(computeEntryHash(payload)).toBe(computeEntryHash(reordered));
  });
});

describe("change history — rejected updates (#787)", () => {
  let service: ChangeHistoryService;

  beforeEach(() => {
    ({ service } = build());
  });

  it("rejects a settlement without a reason", async () => {
    await expect(
      service.append({
        ...RECORD,
        action: "SETTLEMENT",
        actor: "GADMIN",
        reason: "  ",
        before: { status: "FUNDED" },
        after: { status: "SETTLED" },
      }),
    ).rejects.toThrow(/reason is required/i);
  });

  it("rejects a role change without a reason", async () => {
    await expect(
      service.append({
        ...RECORD,
        action: "ROLE_CHANGE",
        actor: "GUSER",
        reason: "",
        before: { role: "member" },
        after: { role: "admin" },
      }),
    ).rejects.toThrow(/reason is required/i);
  });

  it("rejects a CREATE that carries a previous state", async () => {
    await expect(
      service.append({
        ...RECORD,
        action: "CREATE",
        actor: "GADMIN",
        reason: "bad",
        before: { status: "OLD" },
        after: { status: "NEW" },
      }),
    ).rejects.toThrow(/CREATE must not carry a previous state/i);
  });

  it("rejects a DELETE that carries a new state", async () => {
    await expect(
      service.append({
        ...RECORD,
        action: "DELETE",
        actor: "GADMIN",
        reason: "cleanup",
        before: null,
        after: { status: "NEW" },
      }),
    ).rejects.toThrow(/DELETE must not carry a new state/i);
  });

  it("rejects a missing actor or record id", async () => {
    await expect(
      service.append({ ...RECORD, action: "UPDATE", actor: "", reason: "r", before: {}, after: {} }),
    ).rejects.toThrow(/actor is required/i);

    await expect(
      service.append({
        ...RECORD,
        recordId: " ",
        action: "UPDATE",
        actor: "A",
        reason: "r",
        before: {},
        after: {},
      }),
    ).rejects.toThrow(/recordId is required/i);
  });

  it("does not record a rejected update in the chain", async () => {
    await service.append({
      ...RECORD,
      action: "CREATE",
      actor: "GADMIN",
      reason: "open",
      before: null,
      after: { amount: "1" },
    });

    await expect(
      service.append({
        ...RECORD,
        action: "SETTLEMENT",
        actor: "GADMIN",
        reason: "",
        before: {},
        after: {},
      }),
    ).rejects.toThrow();

    const history = await service.history(RECORD.recordType, RECORD.recordId);
    expect(history).toHaveLength(1);
    expect(await service.verify(RECORD.recordType, RECORD.recordId)).toMatchObject({ ok: true });
  });
});

describe("change history — verification failures (#787)", () => {
  let store: InMemoryChangeHistoryStore;
  let service: ChangeHistoryService;

  beforeEach(async () => {
    ({ store, service } = build());
    await service.append({
      ...RECORD,
      action: "CREATE",
      actor: "GADMIN",
      reason: "open",
      before: null,
      after: { amount: "100" },
    });
    await service.append({
      ...RECORD,
      action: "STATUS_CHANGE",
      actor: "GADMIN",
      reason: "funded",
      before: { status: "PENDING" },
      after: { status: "FUNDED" },
    });
  });

  const rawHistory = () => store.list(RECORD.recordType, RECORD.recordId);

  it("passes on an untouched chain", async () => {
    const result = await service.verify(RECORD.recordType, RECORD.recordId);
    expect(result.ok).toBe(true);
    expect(result.entryCount).toBe(2);
    expect(result.problems).toEqual([]);
  });

  it("detects an altered entry", async () => {
    const entries = await rawHistory();
    // Someone edits the amount after the fact, leaving the stored hash untouched.
    const tampered: ChangeHistoryEntry = { ...entries[0], after: { amount: "1" } };
    await seed(store, [tampered, entries[1]]);

    const result = await service.verify(RECORD.recordType, RECORD.recordId);
    expect(result.ok).toBe(false);
    expect(result.problems.map((p) => p.code)).toContain("ALTERED");
  });

  it("detects a missing entry", async () => {
    const entries = await rawHistory();
    await seed(store, [entries[0]]);

    const result = await service.verify(RECORD.recordType, RECORD.recordId);
    expect(result.ok).toBe(false);
    // The chain is truncated: the final link no longer follows a stored entry.
    expect(result.problems.map((p) => p.code)).toContain("BROKEN_LINK");
  });

  it("detects a sequence gap from a deleted middle entry", async () => {
    await service.append({
      ...RECORD,
      action: "UPDATE",
      actor: "GADMIN",
      reason: "third",
      before: { a: 1 },
      after: { a: 2 },
    });
    const entries = await rawHistory();
    await seed(store, [entries[0], entries[2]]);

    const result = await service.verify(RECORD.recordType, RECORD.recordId);
    expect(result.ok).toBe(false);
    expect(result.problems.map((p) => p.code)).toContain("OUT_OF_ORDER");
  });

  it("detects out-of-order entries", async () => {
    const entries = await rawHistory();
    await seed(store, [entries[1], entries[0]]);

    const result = await service.verify(RECORD.recordType, RECORD.recordId);
    expect(result.ok).toBe(false);
    const codes = result.problems.map((p) => p.code);
    expect(codes).toContain("OUT_OF_ORDER");
    expect(codes).toContain("BROKEN_LINK");
  });

  it("detects a chain that does not start at genesis", async () => {
    const entries = await rawHistory();
    await seed(store, [entries[1]]);

    const result = await service.verify(RECORD.recordType, RECORD.recordId);
    expect(result.ok).toBe(false);
    expect(result.problems.map((p) => p.code)).toContain("GENESIS_MISMATCH");
  });

  it("verifies every record in a sweep", async () => {
    const results = await service.verifyAll([RECORD]);
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(true);
  });

  it("treats a record with no history as valid", async () => {
    const result = await service.verify("user", "never_touched");
    expect(result).toMatchObject({ ok: true, entryCount: 0 });
  });
});

/** Replaces a record's history with an exact set of entries (tamper simulation). */
async function seed(store: InMemoryChangeHistoryStore, entries: ChangeHistoryEntry[]) {
  store.clear();
  for (const entry of entries) await store.insertRaw(entry);
}
