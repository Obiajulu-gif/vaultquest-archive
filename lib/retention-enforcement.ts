/**
 * Data retention enforcement and post-deletion verification (#1118).
 *
 * Implements a two-phase retention lifecycle:
 *  1. `active` -> `quarantined` once a record's category TTL (`retentionMs`)
 *     elapses (unless protected by an active `legalHold`). While quarantined
 *     inside `quarantineGraceMs`, an operator can roll back / restore the
 *     record if a policy was misconfigured.
 *  2. `quarantined` -> `purged` once `purgeEligibleAt` elapses. Hard purge
 *     removes the record payload from primary and secondary stores, records an
 *     immutable tombstone digest, and runs `verifyDeletionCompleteness` across
 *     primary, index, and cache stores to issue a `DeletionVerificationCertificate`.
 */

import { createHash } from "crypto";

export type RetentionDataCategory =
  | "logs"
  | "analytics"
  | "errors"
  | "audit"
  | "cache"
  | "temp"
  | "user_export";

export const RETENTION_RECORD_STATES = {
  ACTIVE: "active",
  QUARANTINED: "quarantined",
  PURGED: "purged",
} as const;

export type RetentionRecordState =
  (typeof RETENTION_RECORD_STATES)[keyof typeof RETENTION_RECORD_STATES];

export const AUTHORIZED_RETENTION_ACTORS = [
  "system",
  "admin",
  "privacy_officer",
  "retention_worker",
] as const;

export const RETENTION_REASONS = {
  INVALID_INPUT: "RETENTION_INVALID_INPUT",
  UNAUTHORIZED_ACTOR: "RETENTION_UNAUTHORIZED_ACTOR",
  RECORD_NOT_FOUND: "RETENTION_RECORD_NOT_FOUND",
  LEGAL_HOLD_ACTIVE: "RETENTION_LEGAL_HOLD_ACTIVE",
  NOT_QUARANTINED: "RETENTION_NOT_QUARANTINED",
  ALREADY_PURGED: "RETENTION_ALREADY_PURGED",
  GRACE_PERIOD_ACTIVE: "RETENTION_GRACE_PERIOD_ACTIVE",
  RESIDUAL_DATA_DETECTED: "RETENTION_RESIDUAL_DATA_DETECTED",
} as const;

export type RetentionReason = (typeof RETENTION_REASONS)[keyof typeof RETENTION_REASONS];

export class RetentionEnforcementError extends Error {
  readonly reasonCode: RetentionReason;
  readonly retryable: boolean;

  constructor(reasonCode: RetentionReason, message: string, retryable = false) {
    super(message);
    this.name = "RetentionEnforcementError";
    this.reasonCode = reasonCode;
    this.retryable = retryable;
  }
}

export interface CategoryRetentionRule {
  readonly category: RetentionDataCategory;
  readonly retentionMs: number;
  readonly quarantineGraceMs: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_RETENTION_RULES: Readonly<Record<RetentionDataCategory, CategoryRetentionRule>> = {
  temp: { category: "temp", retentionMs: 1 * DAY_MS, quarantineGraceMs: 1 * 60 * 60 * 1000 },
  cache: { category: "cache", retentionMs: 7 * DAY_MS, quarantineGraceMs: 6 * 60 * 60 * 1000 },
  logs: { category: "logs", retentionMs: 30 * DAY_MS, quarantineGraceMs: 2 * DAY_MS },
  errors: { category: "errors", retentionMs: 60 * DAY_MS, quarantineGraceMs: 3 * DAY_MS },
  analytics: { category: "analytics", retentionMs: 90 * DAY_MS, quarantineGraceMs: 7 * DAY_MS },
  user_export: { category: "user_export", retentionMs: 14 * DAY_MS, quarantineGraceMs: 2 * DAY_MS },
  audit: { category: "audit", retentionMs: 365 * DAY_MS, quarantineGraceMs: 14 * DAY_MS },
};

export interface RetainedRecord {
  readonly id: string;
  readonly category: RetentionDataCategory;
  readonly createdAt: number;
  readonly state: RetentionRecordState;
  readonly payload: Record<string, unknown> | null;
  readonly legalHold: boolean;
  readonly legalHoldReason: string | null;
  readonly quarantinedAt: number | null;
  readonly purgeEligibleAt: number | null;
  readonly purgedAt: number | null;
  readonly tombstoneHash: string | null;
}

export interface DeletionVerificationCertificate {
  readonly certificateId: string;
  readonly runId: string;
  readonly actor: string;
  readonly verifiedAt: number;
  readonly purgedIds: readonly string[];
  readonly verifiedAbsentIds: readonly string[];
  readonly residualLeakIds: readonly string[];
  readonly skippedLegalHoldIds: readonly string[];
  readonly verified: boolean;
  readonly verificationHash: string;
}

export interface SecondaryStoreProbe {
  readonly name: string;
  hasRecord(recordId: string): boolean;
  evictRecord?(recordId: string): void;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isAuthorizedRetentionActor(actor: string): boolean {
  return (AUTHORIZED_RETENTION_ACTORS as readonly string[]).includes(actor);
}

function assertAuthorizedActor(actor: string): void {
  if (!nonEmpty(actor) || !isAuthorizedRetentionActor(actor)) {
    throw new RetentionEnforcementError(
      RETENTION_REASONS.UNAUTHORIZED_ACTOR,
      `Actor "${actor}" is not authorized to run retention enforcement or deletion verification.`,
    );
  }
}

export function computeTombstoneHash(recordId: string, category: string, purgedAt: number): string {
  return createHash("sha256")
    .update(`${recordId}:${category}:${purgedAt}`, "utf8")
    .digest("hex");
}

export function computeCertificateHash(
  cert: Omit<DeletionVerificationCertificate, "verificationHash">,
): string {
  const canonical = JSON.stringify({
    certificateId: cert.certificateId,
    runId: cert.runId,
    actor: cert.actor,
    verifiedAt: cert.verifiedAt,
    purgedIds: [...cert.purgedIds].sort(),
    verifiedAbsentIds: [...cert.verifiedAbsentIds].sort(),
    residualLeakIds: [...cert.residualLeakIds].sort(),
    skippedLegalHoldIds: [...cert.skippedLegalHoldIds].sort(),
    verified: cert.verified,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export class RetentionEnforcementEngine {
  private readonly records = new Map<string, RetainedRecord>();
  private readonly rules: Record<RetentionDataCategory, CategoryRetentionRule>;
  private readonly secondaryProbes: SecondaryStoreProbe[] = [];
  private readonly certificatesByRunId = new Map<string, DeletionVerificationCertificate>();

  constructor(
    customRules: Partial<Record<RetentionDataCategory, CategoryRetentionRule>> = {},
    secondaryProbes: SecondaryStoreProbe[] = [],
  ) {
    this.rules = { ...DEFAULT_RETENTION_RULES, ...customRules } as Record<
      RetentionDataCategory,
      CategoryRetentionRule
    >;
    this.secondaryProbes.push(...secondaryProbes);
  }

  registerRecord(params: {
    id: string;
    category: RetentionDataCategory;
    createdAt: number;
    payload: Record<string, unknown>;
    legalHold?: boolean;
    legalHoldReason?: string;
  }): RetainedRecord {
    if (!nonEmpty(params.id) || !params.payload || typeof params.payload !== "object") {
      throw new RetentionEnforcementError(
        RETENTION_REASONS.INVALID_INPUT,
        "Record id and payload object are required.",
      );
    }

    const record: RetainedRecord = {
      id: params.id,
      category: params.category,
      createdAt: params.createdAt,
      state: RETENTION_RECORD_STATES.ACTIVE,
      payload: { ...params.payload },
      legalHold: Boolean(params.legalHold),
      legalHoldReason: params.legalHold ? (params.legalHoldReason ?? "legal_hold") : null,
      quarantinedAt: null,
      purgeEligibleAt: null,
      purgedAt: null,
      tombstoneHash: null,
    };
    this.records.set(record.id, record);
    return { ...record };
  }

  getRecord(id: string): RetainedRecord | null {
    const rec = this.records.get(id);
    return rec ? { ...rec } : null;
  }

  setLegalHold(id: string, actor: string, hold: boolean, reason?: string): RetainedRecord {
    assertAuthorizedActor(actor);
    const rec = this.records.get(id);
    if (!rec) {
      throw new RetentionEnforcementError(
        RETENTION_REASONS.RECORD_NOT_FOUND,
        `Record ${id} not found.`,
      );
    }
    if (rec.state === RETENTION_RECORD_STATES.PURGED) {
      throw new RetentionEnforcementError(
        RETENTION_REASONS.ALREADY_PURGED,
        `Cannot modify legal hold on already-purged record ${id}.`,
      );
    }

    const updated: RetainedRecord = {
      ...rec,
      legalHold: hold,
      legalHoldReason: hold ? (reason ?? "legal_hold") : null,
    };
    this.records.set(id, updated);
    return { ...updated };
  }

  /**
   * Phase 1: Sweep expired `active` records into `quarantined`, skipping any
   * record under an active `legalHold`.
   */
  quarantineExpired(actor: string, now: number = Date.now()): {
    quarantinedIds: string[];
    skippedLegalHoldIds: string[];
  } {
    assertAuthorizedActor(actor);
    const quarantinedIds: string[] = [];
    const skippedLegalHoldIds: string[] = [];

    for (const [id, rec] of this.records.entries()) {
      if (rec.state !== RETENTION_RECORD_STATES.ACTIVE) continue;
      const rule = this.rules[rec.category];
      if (!rule) continue;

      if (now < rec.createdAt + rule.retentionMs) continue;

      if (rec.legalHold) {
        skippedLegalHoldIds.push(id);
        continue;
      }

      const updated: RetainedRecord = {
        ...rec,
        state: RETENTION_RECORD_STATES.QUARANTINED,
        quarantinedAt: now,
        purgeEligibleAt: now + rule.quarantineGraceMs,
      };
      this.records.set(id, updated);
      quarantinedIds.push(id);
    }

    return { quarantinedIds, skippedLegalHoldIds };
  }

  /**
   * Rollback path: restore a `quarantined` record back to `active` before it
   * is hard-purged.
   */
  restoreQuarantinedRecord(id: string, actor: string): RetainedRecord {
    assertAuthorizedActor(actor);
    const rec = this.records.get(id);
    if (!rec) {
      throw new RetentionEnforcementError(
        RETENTION_REASONS.RECORD_NOT_FOUND,
        `Record ${id} not found.`,
      );
    }
    if (rec.state === RETENTION_RECORD_STATES.PURGED) {
      throw new RetentionEnforcementError(
        RETENTION_REASONS.ALREADY_PURGED,
        `Record ${id} has already been hard-purged and cannot be restored.`,
      );
    }
    if (rec.state !== RETENTION_RECORD_STATES.QUARANTINED) {
      throw new RetentionEnforcementError(
        RETENTION_REASONS.NOT_QUARANTINED,
        `Record ${id} is ${rec.state}, not quarantined.`,
      );
    }

    const restored: RetainedRecord = {
      ...rec,
      state: RETENTION_RECORD_STATES.ACTIVE,
      quarantinedAt: null,
      purgeEligibleAt: null,
    };
    this.records.set(id, restored);
    return { ...restored };
  }

  /**
   * Phase 2: Hard-purge quarantined records whose `purgeEligibleAt` has
   * elapsed, evict secondary stores when `evictSecondary` is true, and verify
   * complete absence across primary and secondary stores.
   *
   * Idempotent on `runId` when a previous run already produced a verified
   * certificate.
   */
  purgeAndVerify(params: {
    runId: string;
    actor: string;
    now?: number;
    evictSecondary?: boolean;
  }): DeletionVerificationCertificate {
    assertAuthorizedActor(params.actor);
    if (!nonEmpty(params.runId)) {
      throw new RetentionEnforcementError(
        RETENTION_REASONS.INVALID_INPUT,
        "runId is required for purgeAndVerify.",
      );
    }

    const existingCert = this.certificatesByRunId.get(params.runId);
    if (existingCert && existingCert.verified) {
      return existingCert;
    }

    const now = params.now ?? Date.now();
    const evictSecondary = params.evictSecondary ?? true;
    const purgedIds: string[] = [];
    const skippedLegalHoldIds: string[] = [];

    for (const [id, rec] of this.records.entries()) {
      if (rec.state === RETENTION_RECORD_STATES.PURGED) {
        purgedIds.push(id);
        continue;
      }
      if (rec.state !== RETENTION_RECORD_STATES.QUARANTINED) continue;

      if (rec.legalHold) {
        skippedLegalHoldIds.push(id);
        continue;
      }

      if (rec.purgeEligibleAt !== null && now < rec.purgeEligibleAt) {
        continue;
      }

      const purged: RetainedRecord = {
        ...rec,
        state: RETENTION_RECORD_STATES.PURGED,
        payload: null,
        purgedAt: now,
        tombstoneHash: computeTombstoneHash(rec.id, rec.category, now),
      };
      this.records.set(id, purged);
      purgedIds.push(id);
    }

    const verifiedAbsentIds: string[] = [];
    const residualLeakIds: string[] = [];

    for (const id of purgedIds) {
      if (evictSecondary) {
        for (const probe of this.secondaryProbes) {
          probe.evictRecord?.(id);
        }
      }

      const primaryRec = this.records.get(id);
      const primaryLeaked = !primaryRec || primaryRec.payload !== null;
      const secondaryLeaked = this.secondaryProbes.some((probe) => probe.hasRecord(id));

      if (primaryLeaked || secondaryLeaked) {
        residualLeakIds.push(id);
      } else {
        verifiedAbsentIds.push(id);
      }
    }

    const unsignedCert = {
      certificateId: `del-cert-${params.runId}`,
      runId: params.runId,
      actor: params.actor,
      verifiedAt: now,
      purgedIds: Object.freeze([...purgedIds]),
      verifiedAbsentIds: Object.freeze([...verifiedAbsentIds]),
      residualLeakIds: Object.freeze([...residualLeakIds]),
      skippedLegalHoldIds: Object.freeze([...skippedLegalHoldIds]),
      verified: residualLeakIds.length === 0,
    };

    const cert: DeletionVerificationCertificate = Object.freeze({
      ...unsignedCert,
      verificationHash: computeCertificateHash(unsignedCert),
    });

    this.certificatesByRunId.set(params.runId, cert);

    if (!cert.verified) {
      throw new RetentionEnforcementError(
        RETENTION_REASONS.RESIDUAL_DATA_DETECTED,
        `Deletion verification failed for run ${params.runId}: residual data remained for [${residualLeakIds.join(", ")}].`,
        true,
      );
    }

    return cert;
  }
}
