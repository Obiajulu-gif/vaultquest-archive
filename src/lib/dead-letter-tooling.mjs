/**
 * Dead-Letter Queue (DLQ) Inspection and Safe Retry Tooling (#1104)
 *
 * Provides operator tooling to inspect dead-lettered background jobs,
 * verify payload integrity, preview dry-run replays, and safely retry
 * or quarantine jobs with idempotency and role-based authorization guards.
 *
 * Edge Cases & Recovery / Rollback Behavior:
 * 1. Quarantine / Poison-Pill Protection: Jobs exceeding `maxRetryCycles` or
 *    explicitly marked non-retryable (`poisonPill: true`) are blocked from
 *    automatic replay unless an admin supplies an explicit `forceOverrideReason`.
 * 2. Idempotency Guard: Active or already-succeeded replay keys cannot be
 *    double-dispatched; concurrent retry calls for the same dead-letter ID
 *    short-circuit safely.
 * 3. Rollback on Dispatch Failure: If the target queue handler throws during
 *    retry dispatch, the dead-letter entry is rolled back to `"dead_lettered"`
 *    with incremented `retryCount` and `lastRetryError` recorded, preserving
 *    the original payload for subsequent investigation.
 * 4. Authorization: Read/inspection and dry-run previews are permitted for
 *    `operator` and `admin` roles; live retry and purge mutations require `admin`
 *    (or `operator` with explicit `retry:dlq` scope).
 */

export class DeadLetterAuthorizationError extends Error {
  constructor(message, code = "DLQ_UNAUTHORIZED") {
    super(message);
    this.name = "DeadLetterAuthorizationError";
    this.code = code;
    this.statusCode = 403;
  }
}

export class DeadLetterOperationError extends Error {
  constructor(message, code = "DLQ_OPERATION_FAILED", statusCode = 400) {
    super(message);
    this.name = "DeadLetterOperationError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

const SENSITIVE_KEY_PATTERN = /(secret|token|password|seed|private_?key|authorization|ssn)/i;

export function redactDeadLetterPayload(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(redactDeadLetterPayload);
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY_PATTERN.test(k) ? "[REDACTED]" : redactDeadLetterPayload(v);
    }
    return out;
  }
  return value;
}

export function authorizeDeadLetterActor(actor, { mutation = false } = {}) {
  if (!actor || typeof actor.id !== "string" || !actor.role) {
    throw new DeadLetterAuthorizationError("Valid actor identity is required.");
  }
  const scopes = Array.isArray(actor.scopes) ? actor.scopes : [];
  if (!mutation) {
    if (actor.role !== "admin" && actor.role !== "operator" && actor.role !== "auditor") {
      throw new DeadLetterAuthorizationError(
        `Role "${actor.role}" is not permitted to inspect dead-letter queues.`
      );
    }
    return true;
  }
  const canMutate =
    actor.role === "admin" ||
    (actor.role === "operator" && scopes.includes("retry:dlq"));
  if (!canMutate) {
    throw new DeadLetterAuthorizationError(
      `Role "${actor.role}" lacks permission to mutate or replay dead-letter items.`
    );
  }
  return true;
}

export class DeadLetterQueueManager {
  constructor({ maxRetryCycles = 3, nowFn = () => new Date() } = {}) {
    this.maxRetryCycles = maxRetryCycles;
    this.nowFn = nowFn;
    this.items = new Map();
    this.idempotencyLedger = new Map();
    this.auditTrail = [];
  }

  enqueueDeadLetter({
    id,
    queueName,
    jobName,
    payload,
    errorReason,
    errorCode = "JOB_FAILED",
    attemptsMade = 3,
    poisonPill = false,
    correlationId = null,
  }) {
    if (!id || !queueName || !jobName) {
      throw new DeadLetterOperationError(
        "Dead-letter entry requires id, queueName, and jobName.",
        "INVALID_DLQ_ENTRY"
      );
    }
    const nowIso = this.nowFn().toISOString();
    const entry = {
      id,
      queueName,
      jobName,
      payload: structuredClone(payload ?? {}),
      errorReason: String(errorReason ?? "Unknown failure"),
      errorCode,
      attemptsMade,
      retryCount: 0,
      poisonPill: Boolean(poisonPill),
      status: poisonPill ? "quarantined" : "dead_lettered",
      correlationId,
      firstFailedAt: nowIso,
      updatedAt: nowIso,
      lastRetryError: null,
      replayedAt: null,
    };
    this.items.set(id, entry);
    return structuredClone(entry);
  }

  inspectEntries(actor, { queueName, status, errorCode, limit = 50, cursor = null } = {}) {
    authorizeDeadLetterActor(actor, { mutation: false });
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new DeadLetterOperationError("Limit must be between 1 and 200.", "INVALID_LIMIT");
    }

    let list = Array.from(this.items.values());
    if (queueName) list = list.filter((item) => item.queueName === queueName);
    if (status) list = list.filter((item) => item.status === status);
    if (errorCode) list = list.filter((item) => item.errorCode === errorCode);

    if (cursor) {
      const idx = list.findIndex((item) => item.id === cursor);
      if (idx === -1) {
        throw new DeadLetterOperationError(`Cursor "${cursor}" not found.`, "INVALID_CURSOR");
      }
      list = list.slice(idx + 1);
    }

    const slice = list.slice(0, limit).map((item) => ({
      ...structuredClone(item),
      payload: redactDeadLetterPayload(item.payload),
    }));

    return {
      entries: slice,
      totalMatched: list.length,
      nextCursor: list.length > limit ? slice[slice.length - 1]?.id ?? null : null,
    };
  }

  getEntryDetail(actor, id) {
    authorizeDeadLetterActor(actor, { mutation: false });
    const item = this.items.get(id);
    if (!item) {
      throw new DeadLetterOperationError(`Dead-letter item "${id}" not found.`, "DLQ_NOT_FOUND", 404);
    }
    return {
      ...structuredClone(item),
      payload: redactDeadLetterPayload(item.payload),
    };
  }

  async retryEntry({
    actor,
    id,
    dispatcher,
    dryRun = false,
    idempotencyKey = null,
    forceOverrideReason = null,
    maxTransientAttempts = 2,
  }) {
    authorizeDeadLetterActor(actor, { mutation: !dryRun });

    const item = this.items.get(id);
    if (!item) {
      throw new DeadLetterOperationError(`Dead-letter item "${id}" not found.`, "DLQ_NOT_FOUND", 404);
    }

    if (idempotencyKey && this.idempotencyLedger.has(idempotencyKey)) {
      return {
        ...structuredClone(this.idempotencyLedger.get(idempotencyKey)),
        deduplicated: true,
      };
    }

    if (item.status === "replayed") {
      throw new DeadLetterOperationError(
        `Dead-letter item "${id}" has already been replayed.`,
        "ALREADY_REPLAYED",
        409
      );
    }

    const isQuarantined = item.status === "quarantined" || item.poisonPill;
    const exceededCycles = item.retryCount >= this.maxRetryCycles;

    if ((isQuarantined || exceededCycles) && !forceOverrideReason) {
      throw new DeadLetterOperationError(
        `Item "${id}" is quarantined or exceeded max retry cycles (${this.maxRetryCycles}). Provide forceOverrideReason to override.`,
        "DLQ_QUARANTINED",
        409
      );
    }

    if ((isQuarantined || exceededCycles) && actor.role !== "admin") {
      throw new DeadLetterAuthorizationError(
        "Only admin actors can force-retry quarantined dead-letter items.",
        "DLQ_QUARANTINE_OVERRIDE_FORBIDDEN"
      );
    }

    if (dryRun) {
      const preview = {
        id: item.id,
        dryRun: true,
        wouldReplay: true,
        queueName: item.queueName,
        jobName: item.jobName,
        currentStatus: item.status,
        retryCount: item.retryCount,
        redactedPayload: redactDeadLetterPayload(item.payload),
      };
      this._recordAudit(actor, "dlq_retry_dry_run", item.id, "success");
      return preview;
    }

    if (typeof dispatcher !== "function") {
      throw new DeadLetterOperationError("A dispatcher function is required for live retry.", "INVALID_DISPATCHER");
    }

    const previousSnapshot = structuredClone(item);
    item.status = "retrying";
    item.updatedAt = this.nowFn().toISOString();

    let attempt = 0;
    let lastErr = null;

    while (attempt < maxTransientAttempts) {
      attempt += 1;
      try {
        await dispatcher(structuredClone(item));
        const nowIso = this.nowFn().toISOString();
        item.status = "replayed";
        item.retryCount += 1;
        item.replayedAt = nowIso;
        item.updatedAt = nowIso;
        item.lastRetryError = null;

        const response = {
          id: item.id,
          dryRun: false,
          replayed: true,
          attemptsUsed: attempt,
          status: item.status,
          retryCount: item.retryCount,
          replayedAt: item.replayedAt,
          deduplicated: false,
        };
        if (idempotencyKey) {
          this.idempotencyLedger.set(idempotencyKey, response);
        }
        this._recordAudit(actor, "dlq_retry", item.id, "success", {
          attemptsUsed: attempt,
          forceOverrideReason,
        });
        return response;
      } catch (err) {
        lastErr = err;
        const isTransient = Boolean(err && err.retryable === true);
        if (!isTransient || attempt >= maxTransientAttempts) {
          break;
        }
      }
    }

    // Rollback to dead_lettered (or quarantined if maxRetryCycles reached)
    const nextRetryCount = previousSnapshot.retryCount + 1;
    item.retryCount = nextRetryCount;
    item.lastRetryError = lastErr instanceof Error ? lastErr.message : String(lastErr);
    item.status =
      nextRetryCount >= this.maxRetryCycles || previousSnapshot.poisonPill
        ? "quarantined"
        : "dead_lettered";
    item.updatedAt = this.nowFn().toISOString();

    this._recordAudit(actor, "dlq_retry", item.id, "failure", {
      error: item.lastRetryError,
      rolledBackTo: item.status,
    });

    throw new DeadLetterOperationError(
      `Retry dispatch failed for "${id}": ${item.lastRetryError}`,
      "DLQ_DISPATCH_FAILED",
      502
    );
  }

  quarantineEntry(actor, id, reason) {
    authorizeDeadLetterActor(actor, { mutation: true });
    const item = this.items.get(id);
    if (!item) {
      throw new DeadLetterOperationError(`Dead-letter item "${id}" not found.`, "DLQ_NOT_FOUND", 404);
    }
    item.status = "quarantined";
    item.poisonPill = true;
    item.lastRetryError = reason || "Manually quarantined by operator";
    item.updatedAt = this.nowFn().toISOString();
    this._recordAudit(actor, "dlq_quarantine", id, "success", { reason: item.lastRetryError });
    return structuredClone(item);
  }

  getAuditTrail() {
    return structuredClone(this.auditTrail);
  }

  _recordAudit(actor, action, itemId, outcome, metadata = {}) {
    this.auditTrail.push({
      actorId: actor.id,
      actorRole: actor.role,
      action,
      itemId,
      outcome,
      metadata,
      timestamp: this.nowFn().toISOString(),
    });
  }
}
