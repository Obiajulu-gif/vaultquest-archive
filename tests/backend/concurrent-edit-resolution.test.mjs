import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ConcurrentEditAuthorizationError,
  ConcurrentEditConflictError,
  ConcurrentEditStore,
} from "../../src/lib/concurrent-edit-resolution.mjs";

describe("conflict resolution for concurrent edits (#1107)", () => {
  const admin = { id: "admin-1", role: "admin" };
  const alice = { id: "user-alice", role: "user" };
  const bob = { id: "user-bob", role: "user" };

  it("normal path: merges concurrent edits to disjoint fields from the same baseVersion cleanly", () => {
    const store = new ConcurrentEditStore();
    store.createRecord("pool-1", alice.id, {
      title: "Alpha Vault",
      description: "Initial description",
      depositCap: 10000,
      feeBps: 50,
    });

    // Edit 1 modifies title against baseVersion 1 -> version becomes 2
    const edit1 = store.applyConcurrentEdit({
      recordId: "pool-1",
      actor: alice,
      baseVersion: 1,
      changes: { title: "Alpha Vault v2" },
    });
    assert.equal(edit1.version, 2);
    assert.deepEqual(edit1.applied, ["title"]);

    // Edit 2 was composed concurrently against baseVersion 1 but touches disjoint field depositCap -> merges cleanly to version 3!
    const edit2 = store.applyConcurrentEdit({
      recordId: "pool-1",
      actor: alice,
      baseVersion: 1,
      changes: { depositCap: 25000 },
    });
    assert.equal(edit2.version, 3);
    assert.deepEqual(edit2.applied, ["depositCap"]);
    assert.equal(edit2.data.title, "Alpha Vault v2");
    assert.equal(edit2.data.depositCap, 25000);
  });

  it("failure & rollback path: detects overlapping field conflict on stale baseVersion and supports version rollback", () => {
    const store = new ConcurrentEditStore();
    store.createRecord("pool-2", alice.id, {
      title: "Beta Vault",
      depositCap: 5000,
    });

    store.applyConcurrentEdit({
      recordId: "pool-2",
      actor: alice,
      baseVersion: 1,
      changes: { title: "Beta Vault Updated" },
    });

    // Another tab tries to overwrite `title` from stale baseVersion 1
    assert.throws(
      () =>
        store.applyConcurrentEdit({
          recordId: "pool-2",
          actor: alice,
          baseVersion: 1,
          changes: { title: "Stale Conflicting Title" },
          strategy: "strict",
        }),
      (err) =>
        err instanceof ConcurrentEditConflictError &&
        err.statusCode === 409 &&
        err.conflicts.length === 1 &&
        err.conflicts[0].field === "title" &&
        err.serverSnapshot.title === "Beta Vault Updated"
    );

    // Operator rolls back to version 1
    const rolledBack = store.rollbackToVersion(admin, "pool-2", 1);
    assert.equal(rolledBack.data.title, "Beta Vault");
    assert.equal(rolledBack.version, 3);
  });

  it("retry path: automatically rebases and retries conflicting edits against latest snapshot", async () => {
    const store = new ConcurrentEditStore();
    store.createRecord("pool-3", alice.id, {
      counter: 10,
    });

    // Simulate an intervening concurrent edit that bumps version from 1 -> 2 before attempt 1 lands
    let intervened = false;
    const result = await store.submitEditWithRebaseRetry({
      recordId: "pool-3",
      actor: alice,
      maxRetries: 2,
      buildChangesFn: async (snapshot, attempt) => {
        if (!intervened) {
          intervened = true;
          store.applyConcurrentEdit({
            recordId: "pool-3",
            actor: admin,
            baseVersion: snapshot.version,
            changes: { counter: 20 },
          });
        }
        // Rebase increments the latest observed counter by +5
        return {
          baseVersion: snapshot.version,
          changes: { counter: snapshot.data.counter + 5 },
        };
      },
    });

    assert.equal(result.attemptsUsed, 2);
    assert.equal(result.version, 3);
    assert.equal(result.data.counter, 25);
  });

  it("authorization path: blocks cross-owner mutations and non-admin edits to protected fields", () => {
    const store = new ConcurrentEditStore();
    store.createRecord("pool-4", alice.id, {
      title: "Alice Vault",
      feeBps: 30,
    });

    // Bob cannot edit Alice's record
    assert.throws(
      () =>
        store.applyConcurrentEdit({
          recordId: "pool-4",
          actor: bob,
          baseVersion: 1,
          changes: { title: "Bob Hijack" },
        }),
      (err) => err instanceof ConcurrentEditAuthorizationError && err.statusCode === 403
    );

    // Alice cannot edit admin-only field `feeBps`
    assert.throws(
      () =>
        store.applyConcurrentEdit({
          recordId: "pool-4",
          actor: alice,
          baseVersion: 1,
          changes: { feeBps: 0 },
        }),
      (err) =>
        err instanceof ConcurrentEditAuthorizationError &&
        err.code === "PROTECTED_FIELD_FORBIDDEN"
    );

    // Admin can update `feeBps`
    const adminEdit = store.applyConcurrentEdit({
      recordId: "pool-4",
      actor: admin,
      baseVersion: 1,
      changes: { feeBps: 25 },
    });
    assert.equal(adminEdit.data.feeBps, 25);
  });
});
