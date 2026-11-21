import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  RecordCompatibilityError,
  SchemaAuthorizationError,
  UnsupportedSchemaVersionError,
  authorizeSchemaOperation,
} from "../../src/lib/schema-compatibility.mjs";
import {
  MigrationCompatibilityError,
  RECORD_MIGRATION_MATRIX,
  evaluateMigrationCompatibility,
  executeMigrationFixture,
} from "../../src/lib/schema-migration-matrix.mjs";

const fixturesPath = resolve("tests/fixtures/schema-migration-matrix.fixtures.json");
const fixtures = JSON.parse(readFileSync(fixturesPath, "utf8"));

describe("schema migration compatibility matrix and fixtures", () => {
  const admin = { id: "admin-1", role: "admin" };
  const user = { id: "user-1", role: "user" };

  it("normal path: evaluates record and storage compatibility matrix and migrates valid fixtures", async () => {
    assert.ok(RECORD_MIGRATION_MATRIX.length >= 3);

    for (const fx of fixtures.recordFixtures.normal) {
      const persisted = [];
      const res = await executeMigrationFixture({
        fixture: fx,
        actor: admin,
        persistFn: async (rec) => {
          persisted.push(rec);
        },
      });

      assert.equal(res.status, "migrated");
      assert.equal(res.attempts, 1);
      assert.equal(res.record.schemaVersion, fx.expected.schemaVersion);
      assert.equal(res.record.asset, fx.expected.asset);
      assert.equal(res.record.amount, fx.expected.amount);
      for (const field of fx.expected.strippedFields) {
        assert.equal(field in res.record, false);
      }
      assert.equal(persisted.length, 1);
    }

    for (const sfx of fixtures.storageFixtures) {
      const verdict = evaluateMigrationCompatibility(sfx.current, sfx.next, {
        actor: user,
        kind: "storage",
      });
      assert.equal(verdict.compatible, sfx.expectedCompatible);
      assert.equal(verdict.direction, sfx.expectedDirection);
    }
  });

  it("failure path: rejects unsupported versions, incompatible downgrades, and invalid record payloads", async () => {
    for (const fx of fixtures.recordFixtures.failure) {
      await assert.rejects(
        () => executeMigrationFixture({ fixture: fx, actor: admin }),
        (err) => {
          if (fx.expectedErrorCode === "UNSUPPORTED_SCHEMA_VERSION") {
            return err instanceof UnsupportedSchemaVersionError && err.code === fx.expectedErrorCode;
          }
          if (fx.expectedErrorCode === "MIGRATION_INCOMPATIBLE") {
            return err instanceof MigrationCompatibilityError && err.code === fx.expectedErrorCode;
          }
          if (fx.expectedErrorCode === "RECORD_SCHEMA_INVALID") {
            return err instanceof RecordCompatibilityError && err.code === fx.expectedErrorCode;
          }
          return false;
        },
      );
    }
  });

  it("retry and rollback path: recovers from transient failures and rolls back when retries are exhausted", async () => {
    for (const fx of fixtures.recordFixtures.retry) {
      let calls = 0;
      const rollbacks = [];

      const res = await executeMigrationFixture({
        fixture: fx,
        actor: admin,
        maxRetries: fx.maxRetries,
        persistFn: async () => {
          calls += 1;
          if (calls <= fx.failTimes) {
            const err = new Error("transient lock timeout");
            err.retryable = true;
            throw err;
          }
        },
        rollbackFn: async (original, meta) => {
          rollbacks.push({ original, meta });
        },
      });

      assert.equal(res.status, fx.expectedStatus);
      if (fx.expectedStatus === "migrated") {
        assert.equal(calls, fx.failTimes + 1);
        assert.equal(rollbacks.length, 0);
      } else {
        assert.equal(calls, fx.maxRetries + 1);
        assert.equal(rollbacks.length, 1);
        assert.equal(
          rollbacks[0].meta.strategy,
          "preserve-source-snapshot-and-restore-currency-field",
        );
      }
    }
  });

  it("authorization path: enforces read vs migrate RBAC and scopes across all authorization fixtures", async () => {
    for (const authFx of fixtures.authorizationFixtures) {
      if (authFx.allowed) {
        assert.equal(authorizeSchemaOperation(authFx.actor, authFx.operation), true);
        if (authFx.operation === "migrate") {
          const res = await executeMigrationFixture({
            fixture: fixtures.recordFixtures.normal[0],
            actor: authFx.actor,
          });
          assert.equal(res.status, "migrated");
        } else {
          const verdict = evaluateMigrationCompatibility("0.9.0", "1.0.0", {
            actor: authFx.actor,
            kind: "record",
            operation: "read",
          });
          assert.equal(verdict.compatible, true);
        }
      } else {
        assert.throws(
          () =>
            evaluateMigrationCompatibility("0.9.0", "1.0.0", {
              actor: authFx.actor,
              kind: "record",
              operation: authFx.operation,
            }),
          (err) => err instanceof SchemaAuthorizationError && err.code === "SCHEMA_UNAUTHORIZED",
        );
      }
    }
  });
});
