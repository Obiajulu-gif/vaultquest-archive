/**
 * Migration compatibility checks for the next storage schema version (#975).
 *
 * A deployment must know, before it rolls forward, whether the build and the
 * database agree on the storage schema. `constants.ts` already reports a
 * *current* mismatch ({@link getVersionMismatch}); this module adds the
 * forward-looking question: is the *next* schema version reachable from the
 * current one, and can the two be served together?
 *
 * Both stamps live on the same 14-digit migration coordinate system, so the
 * checks are range/ordering checks:
 *
 *   - forwards  — a build that knows `next` can read data written at `current`
 *                 (requires `current` inside the supported window and
 *                 `current <= next`),
 *   - backwards — this build at `current` can read data written at `next`
 *                 (requires `next <= SCHEMA_VERSIONS.DATABASE`),
 *   - window    — both stamps must be enumerated migration stamps, `current`
 *                 must not be older than `OLDEST`, and downgrades are refused.
 *
 * All functions are pure so they can be exercised with synthetic windows.
 */

import { SCHEMA_VERSIONS } from "../constants.js";

/** The migration stamp this build treats as the next schema to be prepared for. */
export const NEXT_STORAGE_SCHEMA_VERSION = SCHEMA_VERSIONS.DATABASE;

export interface StorageSchemaWindow {
  /** Newest stamp this build understands (`SCHEMA_VERSIONS.DATABASE`). */
  database: string;
  /** Oldest stamp this build can still serve (`SCHEMA_VERSIONS.OLDEST`). */
  oldest: string;
  /** Every servable stamp, in ascending order. */
  supportedDatabaseVersions: readonly string[];
}

export const DEFAULT_STORAGE_SCHEMA_WINDOW: StorageSchemaWindow = {
  database: SCHEMA_VERSIONS.DATABASE,
  oldest: SCHEMA_VERSIONS.OLDEST,
  supportedDatabaseVersions: SCHEMA_VERSIONS.SUPPORTED_DATABASE_VERSIONS
};

export interface StorageCompatibilityReport {
  /** True only when both directions are safe and the window is well-formed. */
  compatible: boolean;
  current: string;
  next: string;
  /** A build at `next` can read data written at `current`. */
  forwardsCompatible: boolean;
  /** A build at `current` can read data written at `next`. */
  backwardsCompatible: boolean;
  issues: string[];
}

function windowIsWellFormed(window: StorageSchemaWindow, issues: string[]): boolean {
  const stamps = window.supportedDatabaseVersions;
  for (let i = 1; i < stamps.length; i++) {
    const prev = stamps[i - 1];
    const current = stamps[i];
    if (prev === undefined || current === undefined) continue;
    if (prev >= current) {
      issues.push(`storage schema window is not strictly ascending at ${prev} -> ${current}; the window itself is malformed.`);
      return false;
    }
  }
  return true;
}

export function checkStorageSchemaCompatibility(
  current: string,
  next: string,
  window: StorageSchemaWindow = DEFAULT_STORAGE_SCHEMA_WINDOW
): StorageCompatibilityReport {
  const issues: string[] = [];
  const known = new Set(window.supportedDatabaseVersions);
  const wellFormed = windowIsWellFormed(window, issues);

  const windowOk =
    wellFormed &&
    current !== "unknown" &&
    next !== "unknown" &&
    current >= window.oldest &&
    next >= window.oldest &&
    current <= window.database &&
    next <= window.database &&
    known.has(current) &&
    known.has(next);

  if (current === "unknown" || next === "unknown") {
    issues.push("storage schema version could not be determined; apply pending migrations before checking compatibility.");
  }
  if (current !== "unknown" && current < window.oldest) {
    issues.push(`current schema ${current} is older than the oldest supported ${window.oldest}; migrate forward before deploying.`);
  }
  if (next < current) {
    issues.push(`next schema ${next} is older than current ${current}; schema downgrades are not supported.`);
  }
  if (next > window.database) {
    issues.push(`next schema ${next} is newer than this build understands (${window.database}); deploy a build that supports it first.`);
  }
  if (current !== "unknown" && !known.has(current)) {
    issues.push(`current schema ${current} is not a known migration stamp; refusing to reason about an unknown base.`);
  }
  if (next !== "unknown" && !known.has(next)) {
    issues.push(`next schema ${next} is not a known migration stamp; add the migration and enumerate it before deploying.`);
  }

  const forwardsCompatible = windowOk && current <= next;
  const backwardsCompatible = windowOk && next <= window.database;
  return {
    compatible: forwardsCompatible && backwardsCompatible,
    current,
    next,
    forwardsCompatible,
    backwardsCompatible,
    issues
  };
}
