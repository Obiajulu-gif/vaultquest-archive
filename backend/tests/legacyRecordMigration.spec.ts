import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { InMemoryJobStore } from "../src/worker/jobStore.js";
import {
  DEFAULT_LEGACY_SCHEMA_VERSION,
  RECORD_SCHEMA_VERSION,
  RecordCompatibilityError,
  SUPPORTED_RECORD_SCHEMA_VERSIONS,
  UnsupportedSchemaVersionError,
  negotiateSchemaVersion,
  readVaultRecord,
  writeVaultRecord,
} from "../src/schemas/recordCompatibility.js";

/**
 * #803 — compatibility layer contract tests.
 *
 * Every case in `tests/fixtures/legacy-records/README.md` is asserted here:
 * legacy record reads, new writes, and unsupported versions. The fixtures are
 * the historical shapes described in that README; the compatibility layer is
 * the only code allowed to transform them.
 *
 * Run: `npx vitest run tests/legacyRecordMigration.spec.ts`
 */
const FIXTURE_DIR = resolve(__dirname, "fixtures/legacy-records");

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(resolve(FIXTURE_DIR, name), "utf8"));
}

describe("legacy record fixtures — read path", () => {
  it("reads a clean legacy record and upgrades it to the current schema", () => {
    const raw = fixture("clean-legacy-record.json");
    const { record, sourceVersion, migrated, warnings } = readVaultRecord(raw);

    // Old records remain readable after schema changes.
    expect(sourceVersion).toBe("0.9.0");
    expect(migrated).toBe(true);
    expect(warnings).toEqual([]);

    // Renamed field + version metadata applied by the transform.
    expect(record).toEqual({
      schemaVersion: RECORD_SCHEMA_VERSION,
      id: "legacy-vault-001",
      ownerAddress: "0x111111111111111111111111111111111111111",
      asset: "0x0000000000000000000000000000000000000000",
      balance: "1000000000000000000",
      prizePoolId: "prize-pool-001",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-02T00:00:00.000Z",
      migratedFrom: "0.9.0",
    });
  });

  it("rejects a legacy record missing a required field with a descriptive error", () => {
    const raw = fixture("missing-field.json");
    let error: unknown;
    try {
      readVaultRecord(raw);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(RecordCompatibilityError);
    const compatError = error as RecordCompatibilityError;
    expect(compatError.code).toBe("RECORD_SCHEMA_INVALID");
    expect(compatError.issues.join("; ")).toContain("prizePoolId");
    expect(compatError.message).toContain("prizePoolId");
  });

  it("drops deprecated fields when migrating a legacy record", () => {
    const raw = fixture("deprecated-field.json");
    expect((raw as Record<string, unknown>).commission).toBeDefined();

    const { record, warnings } = readVaultRecord(raw);

    expect(record.schemaVersion).toBe(RECORD_SCHEMA_VERSION);
    expect(record).not.toHaveProperty("commission");
    expect(record.prizePoolId).toBe("prize-pool-003");
    expect(warnings.join(" ")).toContain('deprecated field "commission"');
  });

  it("rejects an unsupported schema version instead of guessing a shape", () => {
    const raw = fixture("incompatible-legacy-record.json");
    let error: unknown;
    try {
      readVaultRecord(raw);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(UnsupportedSchemaVersionError);
    const versionError = error as UnsupportedSchemaVersionError;
    expect(versionError.code).toBe("UNSUPPORTED_SCHEMA_VERSION");
    expect(versionError.version).toBe("0.1.0");
    expect(versionError.message).toContain("incompatible schema version: 0.1.0");
    expect(versionError.message).toContain(SUPPORTED_RECORD_SCHEMA_VERSIONS.join(", "));
  });

  it("reads records that predate schema version metadata as the legacy baseline", () => {
    const raw = fixture("clean-legacy-record.json") as Record<string, unknown>;
    delete raw.schemaVersion;

    const { record, sourceVersion, warnings } = readVaultRecord(raw);
    expect(sourceVersion).toBe(DEFAULT_LEGACY_SCHEMA_VERSION);
    expect(record.schemaVersion).toBe(RECORD_SCHEMA_VERSION);
    expect(record.migratedFrom).toBe(DEFAULT_LEGACY_SCHEMA_VERSION);
    expect(warnings.join(" ")).toContain("no schemaVersion metadata");
  });

  it("leaves current-version records untouched (no migration, no re-stamping)", () => {
    const raw = fixture("clean-legacy-record.json");
    const { record } = readVaultRecord(raw);
    const again = readVaultRecord(record);

    expect(again.migrated).toBe(false);
    expect(again.sourceVersion).toBe(RECORD_SCHEMA_VERSION);
    expect(again.record).toEqual(record);
    expect(again.warnings).toEqual([]);
  });
});

describe("write path", () => {
  const currentInput = {
    id: "vault-100",
    ownerAddress: "0x9999999999999999999999999999999999999999",
    asset: "0x0000000000000000000000000000000000000000",
    balance: "2500000",
    prizePoolId: "prize-pool-100",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  it("stamps new writes with the latest schema version", () => {
    const { record, sourceVersion, migrated, warnings } = writeVaultRecord(currentInput);

    expect(record.schemaVersion).toBe(RECORD_SCHEMA_VERSION);
    expect(record).not.toHaveProperty("migratedFrom");
    expect(sourceVersion).toBe(RECORD_SCHEMA_VERSION);
    expect(migrated).toBe(false);
    expect(warnings).toEqual([]);
  });

  it("round-trips a new write so new clients read back the latest shape", () => {
    const written = writeVaultRecord(currentInput).record;
    const readBack = readVaultRecord(written);

    expect(readBack.migrated).toBe(false);
    expect(readBack.record).toEqual(written);
    expect(readBack.record.schemaVersion).toBe(RECORD_SCHEMA_VERSION);
  });

  it("accepts a write from an older client and stores the latest shape", () => {
    const legacyWrite = fixture("deprecated-field.json");
    const { record, migrated, warnings } = writeVaultRecord(legacyWrite);

    expect(migrated).toBe(true);
    expect(record.schemaVersion).toBe(RECORD_SCHEMA_VERSION);
    expect(record.migratedFrom).toBe("0.9.0");
    expect(record).not.toHaveProperty("commission");
    expect(warnings.join(" ")).toContain("deprecated field");
  });

  it("rejects writes that declare an unsupported version", () => {
    expect(() => writeVaultRecord({ ...currentInput, schemaVersion: "0.1.0" })).toThrow(
      UnsupportedSchemaVersionError,
    );
    expect(() => writeVaultRecord({ ...currentInput, schemaVersion: "2.0.0" })).toThrow(
      /incompatible schema version: 2\.0\.0/,
    );
  });

  it("rejects writes that fail their version's validation", () => {
    let error: unknown;
    try {
      writeVaultRecord({ ...currentInput, balance: "not-a-number" });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RecordCompatibilityError);
    expect((error as RecordCompatibilityError).issues.join(" ")).toContain("balance");
  });
});

describe("API schema version negotiation", () => {
  it("serves the latest shape by default and for supported legacy versions", () => {
    const latest = negotiateSchemaVersion(null);
    expect(latest).toEqual({
      requested: null,
      served: RECORD_SCHEMA_VERSION,
      supported: SUPPORTED_RECORD_SCHEMA_VERSIONS,
    });

    const legacy = negotiateSchemaVersion("0.9.0");
    expect(legacy.requested).toBe("0.9.0");
    expect(legacy.served).toBe(RECORD_SCHEMA_VERSION);
  });

  it("rejects versions outside the supported window", () => {
    expect(() => negotiateSchemaVersion("0.1.0")).toThrow(UnsupportedSchemaVersionError);
    expect(() => negotiateSchemaVersion("2.0.0")).toThrow(UnsupportedSchemaVersionError);
    expect(() => negotiateSchemaVersion("")).not.toThrow();
  });
});

describe("GET /schema-version negotiation endpoint", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildApp({
      prisma: {} as any,
      internalSecret: "contract-secret",
      jobStore: new InMemoryJobStore(),
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns the latest version info for clients that do not pin a version", async () => {
    const res = await app.inject({ method: "GET", url: "/schema-version" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toHaveProperty("database");
    expect(body.data).toHaveProperty("indexer");
  });

  it("confirms a supported legacy schema version", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/schema-version?schema_version=0.9.0",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveProperty("database");
  });

  it("rejects an unsupported schema version with a machine-readable code", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/schema-version?schema_version=0.1.0",
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.data.code).toBe("UNSUPPORTED_SCHEMA_VERSION");
    expect(body.data.requested).toBe("0.1.0");
    expect(body.data.served).toBe(RECORD_SCHEMA_VERSION);
    expect(body.data.supported).toEqual([...SUPPORTED_RECORD_SCHEMA_VERSIONS]);
  });
});
