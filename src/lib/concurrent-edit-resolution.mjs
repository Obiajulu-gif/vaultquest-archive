/**
 * Conflict Resolution for Concurrent Edits (#1107)
 *
 * Resolves concurrent multi-actor edits against versioned records using
 * three-way field diffing, causal baseVersion checks, and role-based
 * field write guards with automatic rebase-and-retry support.
 *
 * Edge Cases & Recovery / Rollback Behavior:
 * 1. Three-Way Non-Overlapping Merge: If two editors concurrently modify
 *    disjoint fields from the same `baseVersion`, the resolver merges both
 *    sets of changes cleanly and advances the version counter without data loss.
 * 2. Overlapping Field Conflict Detection: If a concurrent edit modifies a
 *    field that has already advanced past `baseVersion` with a different value,
 *    strict mode (`strategy: "strict"`) rejects the edit with a 409 conflict
 *    and returns a structured field-level diff + recovery snapshot so the
 *    client can rebase or roll back cleanly.
 * 3. Deterministic LWW / Rebase Retry: When `strategy: "lww"` or
 *    `submitEditWithRebaseRetry` is used, the client's patch generator is
 *    re-invoked against the latest server record snapshot to resolve stale-base
 *    conflicts idempotently.
 * 4. Authorization & Field-Level Guards: Protected administrative fields
 *    (e.g. `feeBps`, `emergencyPaused`, `riskTier`) cannot be edited by non-admin
 *    actors, and cross-owner edits are rejected before any merge computation.
 */

export class ConcurrentEditAuthorizationError extends Error {
  constructor(message, code = "CONCURRENT_EDIT_UNAUTHORIZED") {
    super(message);
    this.name = "ConcurrentEditAuthorizationError";
    this.code = code;
    this.statusCode = 403;
  }
}

export class ConcurrentEditConflictError extends Error {
  constructor(message, { conflicts = [], serverVersion, baseVersion, serverSnapshot } = {}) {
    super(message);
    this.name = "ConcurrentEditConflictError";
    this.code = "CONCURRENT_EDIT_CONFLICT";
    this.statusCode = 409;
    this.retryable = true;
    this.conflicts = conflicts;
    this.serverVersion = serverVersion;
    this.baseVersion = baseVersion;
    this.serverSnapshot = serverSnapshot;
  }
}

function valuesEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export class ConcurrentEditStore {
  constructor({ adminOnlyFields = ["feeBps", "emergencyPaused", "riskTier"] } = {}) {
    this.adminOnlyFields = new Set(adminOnlyFields);
    this.records = new Map();
    this.history = new Map();
  }

  createRecord(id, ownerId, initialData) {
    const snapshot = {
      id,
      ownerId,
      version: 1,
      data: structuredClone(initialData ?? {}),
      fieldVersions: Object.fromEntries(
        Object.keys(initialData ?? {}).map((k) => [k, { version: 1, actorId: ownerId, at: 0 }])
      ),
    };
    this.records.set(id, snapshot);
    this.history.set(id, [structuredClone(snapshot)]);
    return structuredClone(snapshot);
  }

  getRecord(id) {
    const rec = this.records.get(id);
    return rec ? structuredClone(rec) : null;
  }

  applyConcurrentEdit({
    recordId,
    actor,
    baseVersion,
    changes,
    timestamp = Date.now(),
    strategy = "strict",
  }) {
    if (!actor || typeof actor.id !== "string" || !actor.role) {
      throw new ConcurrentEditAuthorizationError("Valid actor identity is required.");
    }

    const record = this.records.get(recordId);
    if (!record) {
      throw new Error(`Record "${recordId}" not found.`);
    }

    const isPrivileged = actor.role === "admin" || actor.role === "operator";
    if (!isPrivileged && record.ownerId !== actor.id) {
      throw new ConcurrentEditAuthorizationError(
        `Actor "${actor.id}" is not authorized to edit record "${recordId}".`
      );
    }

    const changeEntries = Object.entries(changes ?? {}).filter(([, v]) => v !== undefined);
    for (const [field] of changeEntries) {
      if (this.adminOnlyFields.has(field) && actor.role !== "admin") {
        throw new ConcurrentEditAuthorizationError(
          `Field "${field}" requires admin privileges to modify.`,
          "PROTECTED_FIELD_FORBIDDEN"
        );
      }
    }

    if (!Number.isInteger(baseVersion) || baseVersion < 1 || baseVersion > record.version) {
      throw new ConcurrentEditConflictError(
        `Invalid baseVersion ${baseVersion} (current server version is ${record.version}).`,
        {
          conflicts: [],
          serverVersion: record.version,
          baseVersion,
          serverSnapshot: structuredClone(record.data),
        }
      );
    }

    const conflicts = [];
    const appliedFields = [];
    const unchangedFields = [];
    const nextData = structuredClone(record.data);
    const nextFieldVersions = structuredClone(record.fieldVersions);

    for (const [field, proposedValue] of changeEntries) {
      const currentVal = record.data[field];
      const fieldMeta = record.fieldVersions[field] ?? { version: 1, actorId: record.ownerId, at: 0 };

      if (valuesEqual(currentVal, proposedValue)) {
        unchangedFields.push(field);
        continue;
      }

      const modifiedSinceBase = fieldMeta.version > baseVersion;
      if (!modifiedSinceBase) {
        nextData[field] = structuredClone(proposedValue);
        appliedFields.push(field);
      } else if (strategy === "lww") {
        const incomingWins =
          timestamp > fieldMeta.at ||
          (timestamp === fieldMeta.at && String(actor.id) >= String(fieldMeta.actorId));
        if (incomingWins) {
          nextData[field] = structuredClone(proposedValue);
          appliedFields.push(field);
        } else {
          conflicts.push({
            field,
            serverValue: structuredClone(currentVal),
            proposedValue: structuredClone(proposedValue),
            winnerActorId: fieldMeta.actorId,
          });
        }
      } else {
        conflicts.push({
          field,
          serverValue: structuredClone(currentVal),
          proposedValue: structuredClone(proposedValue),
          winnerActorId: fieldMeta.actorId,
        });
      }
    }

    if (conflicts.length > 0 && strategy === "strict") {
      throw new ConcurrentEditConflictError(
        `Concurrent edit conflict on field(s): ${conflicts.map((c) => c.field).join(", ")}`,
        {
          conflicts,
          serverVersion: record.version,
          baseVersion,
          serverSnapshot: structuredClone(record.data),
        }
      );
    }

    if (appliedFields.length > 0) {
      const nextVersion = record.version + 1;
      for (const field of appliedFields) {
        nextFieldVersions[field] = {
          version: nextVersion,
          actorId: actor.id,
          at: timestamp,
        };
      }
      record.version = nextVersion;
      record.data = nextData;
      record.fieldVersions = nextFieldVersions;
      this.history.get(recordId)?.push(structuredClone(record));
    }

    return {
      version: record.version,
      data: structuredClone(record.data),
      applied: appliedFields.sort(),
      unchanged: unchangedFields.sort(),
      rejected: conflicts,
    };
  }

  async submitEditWithRebaseRetry({
    recordId,
    actor,
    buildChangesFn,
    maxRetries = 3,
  }) {
    let attempt = 0;
    while (attempt <= maxRetries) {
      attempt += 1;
      const latest = this.getRecord(recordId);
      if (!latest) throw new Error(`Record "${recordId}" not found.`);

      const { baseVersion, changes } = await buildChangesFn(latest, attempt);
      try {
        const res = this.applyConcurrentEdit({
          recordId,
          actor,
          baseVersion,
          changes,
          strategy: "strict",
        });
        return {
          ...res,
          attemptsUsed: attempt,
        };
      } catch (err) {
        if (err instanceof ConcurrentEditConflictError && attempt <= maxRetries) {
          continue;
        }
        throw err;
      }
    }
  }

  rollbackToVersion(actor, recordId, targetVersion) {
    if (!actor || (actor.role !== "admin" && actor.role !== "operator")) {
      throw new ConcurrentEditAuthorizationError("Only admin or operator can rollback record versions.");
    }
    const snapshots = this.history.get(recordId) ?? [];
    const target = snapshots.find((s) => s.version === targetVersion);
    if (!target) {
      throw new Error(`Target version ${targetVersion} not found for record "${recordId}".`);
    }
    const current = this.records.get(recordId);
    const restored = {
      ...structuredClone(target),
      version: current.version + 1,
    };
    this.records.set(recordId, restored);
    snapshots.push(structuredClone(restored));
    return structuredClone(restored);
  }
}
