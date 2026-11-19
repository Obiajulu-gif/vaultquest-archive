import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_STORAGE_SCHEMA_WINDOW,
  RECORD_SCHEMA_VERSION,
  RecordCompatibilityError,
  SchemaAuthorizationError,
  UnsupportedSchemaVersionError,
  checkStorageSchemaCompatibility,
  migrateVersionedRecordsBatch,
  negotiateSchemaVersion,
  readVersionedRecord,
  writeVersionedRecord,
} from "../../src/lib/schema-compatibility.mjs";

describe("schema compatibility for versioned records (#1066)", () => {
  const admin = { id: "admin-1", role: "admin" };
  const user = { id: "user-1", role: "user" };
  const guest = { id: "guest-1", role: "guest" };

  it("normal path: upgrades pre-versioning (0.9.0) records, strips deprecated fields, and negotiates version", () => {
    const legacy = {
      id: "rec-1",
      vaultId: "vault-9",
      amount: 250,
      currency: "XLM",
      commission: "5",
    };

    const readRes = readVersionedRecord(legacy, { actor: user });
    assert.equal(readRes.sourceVersion, "0.9.0");
    assert.equal(readRes.targetVersion, RECORD_SCHEMA_VERSION);
    assert.equal(readRes.record.schemaVersion, "1.0.0");
    assert.equal(readRes.record.asset, "XLM");
    assert.equal(readRes.record.amount, "250");
    assert.equal("commission" in readRes.record, false);
    assert.equal(readRes.warnings.length, 1);

    const writeRes = writeVersionedRecord(
      { id: "rec-2", vaultId: "vault-9", amount: "100", asset: "USDC", commission: "1" },
      { actor: admin },
    );
    assert.equal(writeRes.record.schemaVersion, "1.0.0");
    assert.equal("commission" in writeRes.record, false);

    const neg = negotiateSchemaVersion("0.9.0", { actor: user });
    assert.equal(neg.negotiatedVersion, "1.0.0");
    assert.equal(neg.additiveOnly, true);

    const compat = checkStorageSchemaCompatibility("20260101000000", "20261015000000");
    assert.equal(compat.compatible, true);
    assert.equal(compat.forwardsCompatible, true);
    assert.equal(compat.backwardsCompatible, true);
  });

  it("failure path: rejects unsupported versions, invalid record shapes, and storage downgrades", () => {
    assert.throws(
      () => readVersionedRecord({ id: "r1", vaultId: "v1", amount: "10", schemaVersion: "2.0.0" }, { actor: user }),
      (err) => err instanceof UnsupportedSchemaVersionError && err.code === "UNSUPPORTED_SCHEMA_VERSION",
    );

    assert.throws(
      () => readVersionedRecord({ id: "r1", vaultId: "v1", amount: "-5", schemaVersion: "1.0.0" }, { actor: user }),
      (err) => err instanceof RecordCompatibilityError && err.issues.length >= 2,
    );

    const downgrade = checkStorageSchemaCompatibility(
      "20261015000000",
      "20260101000000",
      DEFAULT_STORAGE_SCHEMA_WINDOW,
    );
    assert.equal(downgrade.compatible, false);
    assert.equal(downgrade.forwardsCompatible, false);
  });

  it("retry path: batch migration retries transient persistence failures without losing valid records", async () => {
    const attempts = new Map();
    const persisted = [];

    const result = await migrateVersionedRecordsBatch({
      actor: admin,
      maxRetries: 2,
      records: [
        { id: "rec-ok", vaultId: "v1", amount: 10 },
        { id: "rec-flaky", vaultId: "v1", amount: 20 },
        { id: "rec-bad", vaultId: "v1", amount: -1 },
      ],
      persistFn: async (rec) => {
        const count = (attempts.get(rec.id) ?? 0) + 1;
        attempts.set(rec.id, count);
        if (rec.id === "rec-flaky" && count < 2) {
          const err = new Error("transient lock timeout");
          err.retryable = true;
          throw err;
        }
        persisted.push(rec.id);
      },
    });

    assert.equal(result.migratedCount, 2);
    assert.equal(result.failedCount, 1);
    assert.deepEqual(persisted, ["rec-ok", "rec-flaky"]);
    assert.equal(attempts.get("rec-flaky"), 2);
    assert.equal(result.failed[0].id, "rec-bad");
  });

  it("authorization path: blocks unauthenticated/guest reads and blocks regular users from writes/migrations", async () => {
    assert.throws(
      () => readVersionedRecord({ id: "r1", vaultId: "v1", amount: "10" }, { actor: guest }),
      SchemaAuthorizationError,
    );

    assert.throws(
      () => writeVersionedRecord({ id: "r1", vaultId: "v1", amount: "10", asset: "USDC" }, { actor: user }),
      (err) => err instanceof SchemaAuthorizationError && err.statusCode === 403,
    );

    await assert.rejects(
      () =>
        migrateVersionedRecordsBatch({
          actor: user,
          records: [],
          persistFn: async () => {},
        }),
      SchemaAuthorizationError,
    );
  });
});
