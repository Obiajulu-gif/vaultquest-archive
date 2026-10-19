import { describe, it, expect } from "vitest";
import { SCHEMA_VERSIONS } from "../src/constants.js";
import {
  checkStorageSchemaCompatibility,
  NEXT_STORAGE_SCHEMA_VERSION,
  type StorageSchemaWindow,
} from "../src/services/storageSchemaCompatibility.js";

const WINDOW: StorageSchemaWindow = {
  database: "20260301000000",
  oldest: "20260101000000",
  supportedDatabaseVersions: [
    "20260101000000",
    "20260201000000",
    "20260301000000",
  ],
};

describe("storage schema compatibility (#975)", () => {
  it("accepts the current version and its own successor", () => {
    const report = checkStorageSchemaCompatibility("20260101000000", "20260201000000", WINDOW);
    expect(report.compatible).toBe(true);
    expect(report.forwardsCompatible).toBe(true);
    expect(report.backwardsCompatible).toBe(true);
    expect(report.issues).toEqual([]);
  });

  it("allows a no-op (current === next)", () => {
    const report = checkStorageSchemaCompatibility("20260301000000", "20260301000000", WINDOW);
    expect(report.compatible).toBe(true);
  });

  it("refuses a downgrade", () => {
    const report = checkStorageSchemaCompatibility("20260301000000", "20260201000000", WINDOW);
    expect(report.compatible).toBe(false);
    expect(report.forwardsCompatible).toBe(false);
    expect(report.issues.join(" ")).toContain("downgrade");
  });

  it("refuses a next version newer than this build understands", () => {
    const report = checkStorageSchemaCompatibility("20260201000000", "20260401000000", WINDOW);
    expect(report.compatible).toBe(false);
    expect(report.backwardsCompatible).toBe(false);
    expect(report.issues.join(" ")).toContain("newer than this build");
  });

  it("refuses a base older than the oldest supported version", () => {
    const report = checkStorageSchemaCompatibility("20250101000000", "20260201000000", WINDOW);
    expect(report.compatible).toBe(false);
    expect(report.issues.join(" ")).toContain("older than the oldest supported");
  });

  it("fails closed on unknown stamps and malformed windows", () => {
    expect(checkStorageSchemaCompatibility("unknown", "20260201000000", WINDOW).compatible).toBe(false);

    const malformed: StorageSchemaWindow = {
      database: "20260301000000",
      oldest: "20260101000000",
      supportedDatabaseVersions: ["20260201000000", "20260101000000"],
    };
    const report = checkStorageSchemaCompatibility("20260101000000", "20260201000000", malformed);
    expect(report.compatible).toBe(false);
    expect(report.issues.join(" ")).toContain("malformed");
  });

  it("ships a well-formed default window and a reachable next version", () => {
    const report = checkStorageSchemaCompatibility(
      SCHEMA_VERSIONS.DATABASE,
      NEXT_STORAGE_SCHEMA_VERSION,
    );
    expect(report.compatible).toBe(true);
    expect(report.issues).toEqual([]);
  });
});
