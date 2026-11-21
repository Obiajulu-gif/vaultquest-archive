/**
 * Signed, hash-chained audit receipts for administrative changes (#1115).
 *
 * Every administrative mutation (fee update, pause toggle, parameter override,
 * role change) produces an immutable, cryptographically signed receipt chained
 * to the previous receipt's digest (`prevReceiptHash`). The receipt captures
 * both `beforeState` and `afterState` so operators can verify provenance and
 * derive an exact rollback payload.
 */

import { createHash, createHmac, timingSafeEqual } from "crypto";

export const GENESIS_RECEIPT_HASH = "GENESIS";

export const AUTHORIZED_ADMIN_ROLES = ["admin", "super_admin", "security_admin", "maintainer"] as const;
export type AuthorizedAdminRole = (typeof AUTHORIZED_ADMIN_ROLES)[number];

export const AUDIT_RECEIPT_REASONS = {
  INVALID_INPUT: "AUDIT_RECEIPT_INVALID_INPUT",
  UNAUTHORIZED_ACTOR: "AUDIT_RECEIPT_UNAUTHORIZED_ACTOR",
  SIGNING_KEY_MISSING: "AUDIT_RECEIPT_SIGNING_KEY_MISSING",
  VERIFICATION_KEY_MISSING: "AUDIT_RECEIPT_VERIFICATION_KEY_MISSING",
  PAYLOAD_HASH_MISMATCH: "AUDIT_RECEIPT_PAYLOAD_HASH_MISMATCH",
  SIGNATURE_INVALID: "AUDIT_RECEIPT_SIGNATURE_INVALID",
  CHAIN_BROKEN: "AUDIT_RECEIPT_CHAIN_BROKEN",
  CONFLICTING_CHANGE_ID: "AUDIT_RECEIPT_CONFLICTING_CHANGE_ID",
  RECEIPT_NOT_FOUND: "AUDIT_RECEIPT_NOT_FOUND",
} as const;

export type AuditReceiptReason =
  (typeof AUDIT_RECEIPT_REASONS)[keyof typeof AUDIT_RECEIPT_REASONS];

export class AuditReceiptError extends Error {
  readonly reasonCode: AuditReceiptReason;
  readonly retryable: boolean;

  constructor(reasonCode: AuditReceiptReason, message: string, retryable = false) {
    super(message);
    this.name = "AuditReceiptError";
    this.reasonCode = reasonCode;
    this.retryable = retryable;
  }
}

export interface AdminChangeReceipt {
  readonly receiptId: string;
  readonly sequence: number;
  readonly prevReceiptHash: string;
  readonly changeId: string;
  readonly actor: string;
  readonly actorRole: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly beforeState: Readonly<Record<string, unknown>>;
  readonly afterState: Readonly<Record<string, unknown>>;
  readonly reason: string;
  readonly issuedAt: number;
  readonly keyId: string;
  readonly payloadHash: string;
  readonly signature: string;
  readonly rollbackOfReceiptId?: string;
}

export interface SigningKeyRing {
  /** Key ID used to sign newly issued receipts. */
  readonly activeKeyId: string;
  /** Map of keyId -> secret key material (active + retired verification keys). */
  readonly keys: Readonly<Record<string, string>>;
}

export interface IssueAdminReceiptParams {
  receiptId: string;
  sequence: number;
  prevReceiptHash: string;
  changeId: string;
  actor: string;
  actorRole: string;
  action: string;
  targetType: string;
  targetId: string;
  beforeState: Record<string, unknown>;
  afterState: Record<string, unknown>;
  reason: string;
  issuedAt?: number;
  rollbackOfReceiptId?: string;
}

export interface ReceiptVerificationResult {
  readonly valid: boolean;
  readonly reasonCode?: AuditReceiptReason;
  readonly message?: string;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Deterministic canonical JSON serializer (recursively sorts object keys) so
 * `payloadHash` and `signature` are invariant to property insertion order.
 */
export function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeJson(item)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const sortedKeys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  const entries = sortedKeys.map((k) => `${JSON.stringify(k)}:${canonicalizeJson(obj[k])}`);
  return `{${entries.join(",")}}`;
}

export function computeReceiptPayloadHash(
  receipt: Omit<AdminChangeReceipt, "payloadHash" | "signature">,
): string {
  const canonical = canonicalizeJson({
    receiptId: receipt.receiptId,
    sequence: receipt.sequence,
    prevReceiptHash: receipt.prevReceiptHash,
    changeId: receipt.changeId,
    actor: receipt.actor,
    actorRole: receipt.actorRole,
    action: receipt.action,
    targetType: receipt.targetType,
    targetId: receipt.targetId,
    beforeState: receipt.beforeState,
    afterState: receipt.afterState,
    reason: receipt.reason,
    issuedAt: receipt.issuedAt,
    keyId: receipt.keyId,
    rollbackOfReceiptId: receipt.rollbackOfReceiptId ?? null,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function signPayloadHash(payloadHash: string, secret: string): string {
  return createHmac("sha256", secret).update(payloadHash, "utf8").digest("hex");
}

export function isAuthorizedAdminRole(role: string): boolean {
  return (AUTHORIZED_ADMIN_ROLES as readonly string[]).includes(role);
}

/**
 * Issue a signed admin-change receipt.
 */
export function issueSignedAdminReceipt(
  params: IssueAdminReceiptParams,
  keyRing: SigningKeyRing,
): AdminChangeReceipt {
  if (
    !nonEmpty(params.receiptId) ||
    !nonEmpty(params.changeId) ||
    !nonEmpty(params.actor) ||
    !nonEmpty(params.actorRole) ||
    !nonEmpty(params.action) ||
    !nonEmpty(params.targetType) ||
    !nonEmpty(params.targetId) ||
    !nonEmpty(params.reason) ||
    !nonEmpty(params.prevReceiptHash)
  ) {
    throw new AuditReceiptError(
      AUDIT_RECEIPT_REASONS.INVALID_INPUT,
      "All receipt identity, action, target, reason, and prevReceiptHash fields are required.",
    );
  }

  if (!Number.isInteger(params.sequence) || params.sequence < 1) {
    throw new AuditReceiptError(
      AUDIT_RECEIPT_REASONS.INVALID_INPUT,
      "Receipt sequence must be a positive integer.",
    );
  }

  if (!isAuthorizedAdminRole(params.actorRole)) {
    throw new AuditReceiptError(
      AUDIT_RECEIPT_REASONS.UNAUTHORIZED_ACTOR,
      `Role "${params.actorRole}" is not authorized to perform audited admin changes.`,
    );
  }

  const secret = keyRing.keys[keyRing.activeKeyId];
  if (!nonEmpty(keyRing.activeKeyId) || !nonEmpty(secret)) {
    throw new AuditReceiptError(
      AUDIT_RECEIPT_REASONS.SIGNING_KEY_MISSING,
      `Active signing key "${keyRing.activeKeyId}" is missing from keyRing.`,
    );
  }

  const issuedAt = params.issuedAt ?? Date.now();
  const unsigned = {
    receiptId: params.receiptId,
    sequence: params.sequence,
    prevReceiptHash: params.prevReceiptHash,
    changeId: params.changeId,
    actor: params.actor,
    actorRole: params.actorRole,
    action: params.action,
    targetType: params.targetType,
    targetId: params.targetId,
    beforeState: Object.freeze({ ...params.beforeState }),
    afterState: Object.freeze({ ...params.afterState }),
    reason: params.reason,
    issuedAt,
    keyId: keyRing.activeKeyId,
    ...(params.rollbackOfReceiptId ? { rollbackOfReceiptId: params.rollbackOfReceiptId } : {}),
  };

  const payloadHash = computeReceiptPayloadHash(unsigned);
  const signature = signPayloadHash(payloadHash, secret);

  return Object.freeze({
    ...unsigned,
    payloadHash,
    signature,
  });
}

/**
 * Verify a single receipt's payload digest and cryptographic signature.
 */
export function verifyAuditReceipt(
  receipt: AdminChangeReceipt,
  keyRing: Pick<SigningKeyRing, "keys">,
): ReceiptVerificationResult {
  const secret = keyRing.keys[receipt.keyId];
  if (!nonEmpty(secret)) {
    return {
      valid: false,
      reasonCode: AUDIT_RECEIPT_REASONS.VERIFICATION_KEY_MISSING,
      message: `Unknown verification keyId "${receipt.keyId}".`,
    };
  }

  const expectedHash = computeReceiptPayloadHash(receipt);
  if (expectedHash !== receipt.payloadHash) {
    return {
      valid: false,
      reasonCode: AUDIT_RECEIPT_REASONS.PAYLOAD_HASH_MISMATCH,
      message: `Receipt ${receipt.receiptId} payloadHash does not match canonical payload.`,
    };
  }

  const expectedSig = signPayloadHash(expectedHash, secret);
  const a = Buffer.from(expectedSig, "utf8");
  const b = Buffer.from(receipt.signature, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return {
      valid: false,
      reasonCode: AUDIT_RECEIPT_REASONS.SIGNATURE_INVALID,
      message: `Receipt ${receipt.receiptId} signature verification failed.`,
    };
  }

  return { valid: true };
}

/**
 * Verify an ordered chain of receipts for contiguous sequences, unbroken
 * `prevReceiptHash` links, and valid signatures.
 */
export function verifyAuditReceiptChain(
  receipts: readonly AdminChangeReceipt[],
  keyRing: Pick<SigningKeyRing, "keys">,
): ReceiptVerificationResult {
  let expectedPrevHash = GENESIS_RECEIPT_HASH;

  for (let i = 0; i < receipts.length; i++) {
    const r = receipts[i];
    const expectedSeq = i + 1;
    if (r.sequence !== expectedSeq) {
      return {
        valid: false,
        reasonCode: AUDIT_RECEIPT_REASONS.CHAIN_BROKEN,
        message: `Expected sequence ${expectedSeq} at index ${i}, found ${r.sequence}.`,
      };
    }

    if (r.prevReceiptHash !== expectedPrevHash) {
      return {
        valid: false,
        reasonCode: AUDIT_RECEIPT_REASONS.CHAIN_BROKEN,
        message: `Receipt ${r.receiptId} prevReceiptHash mismatch at sequence ${r.sequence}.`,
      };
    }

    const single = verifyAuditReceipt(r, keyRing);
    if (!single.valid) return single;

    expectedPrevHash = r.payloadHash;
  }

  return { valid: true };
}

/**
 * Append-only ledger of signed admin receipts with idempotent retry on
 * `changeId` and one-step verified rollback generation.
 */
export class SignedAuditReceiptLedger {
  private readonly receipts: AdminChangeReceipt[] = [];
  private readonly byChangeId = new Map<string, AdminChangeReceipt>();
  private keyRing: SigningKeyRing;

  constructor(keyRing: SigningKeyRing) {
    this.keyRing = keyRing;
  }

  rotateSigningKey(newKeyId: string, newSecret: string): void {
    if (!nonEmpty(newKeyId) || !nonEmpty(newSecret)) {
      throw new AuditReceiptError(
        AUDIT_RECEIPT_REASONS.INVALID_INPUT,
        "newKeyId and newSecret must be non-empty.",
      );
    }
    this.keyRing = {
      activeKeyId: newKeyId,
      keys: {
        ...this.keyRing.keys,
        [newKeyId]: newSecret,
      },
    };
  }

  /**
   * Record an admin change and return its signed receipt.
   *
   * Idempotent on `changeId`: if the same `changeId` is retried with the same
   * actor, action, and target, the existing receipt is returned without
   * appending a duplicate sequence entry. If `changeId` is reused for a
   * different mutation, `CONFLICTING_CHANGE_ID` is thrown.
   */
  recordChange(
    params: Omit<IssueAdminReceiptParams, "receiptId" | "sequence" | "prevReceiptHash"> & {
      receiptId?: string;
    },
  ): { receipt: AdminChangeReceipt; deduplicatedRetry: boolean } {
    const existing = this.byChangeId.get(params.changeId);
    if (existing) {
      const sameIntent =
        existing.actor === params.actor &&
        existing.action === params.action &&
        existing.targetType === params.targetType &&
        existing.targetId === params.targetId &&
        canonicalizeJson(existing.afterState) === canonicalizeJson(params.afterState);

      if (!sameIntent) {
        throw new AuditReceiptError(
          AUDIT_RECEIPT_REASONS.CONFLICTING_CHANGE_ID,
          `changeId "${params.changeId}" was already used for a different admin mutation.`,
        );
      }
      return { receipt: existing, deduplicatedRetry: true };
    }

    const sequence = this.receipts.length + 1;
    const prevReceiptHash =
      sequence === 1
        ? GENESIS_RECEIPT_HASH
        : this.receipts[this.receipts.length - 1].payloadHash;

    const receipt = issueSignedAdminReceipt(
      {
        ...params,
        receiptId: params.receiptId ?? `rcpt-${sequence}`,
        sequence,
        prevReceiptHash,
      },
      this.keyRing,
    );

    this.receipts.push(receipt);
    this.byChangeId.set(receipt.changeId, receipt);
    return { receipt, deduplicatedRetry: false };
  }

  /**
   * Generate and record a signed rollback receipt that restores `beforeState`
   * of an earlier verified receipt.
   */
  rollbackReceipt(
    targetReceiptId: string,
    actor: string,
    actorRole: string,
    reason: string,
    issuedAt?: number,
  ): AdminChangeReceipt {
    const target = this.receipts.find((r) => r.receiptId === targetReceiptId);
    if (!target) {
      throw new AuditReceiptError(
        AUDIT_RECEIPT_REASONS.RECEIPT_NOT_FOUND,
        `Receipt ${targetReceiptId} not found.`,
      );
    }

    const verified = verifyAuditReceipt(target, this.keyRing);
    if (!verified.valid) {
      throw new AuditReceiptError(
        verified.reasonCode ?? AUDIT_RECEIPT_REASONS.SIGNATURE_INVALID,
        verified.message ?? "Cannot roll back an unverified receipt.",
      );
    }

    const { receipt } = this.recordChange({
      changeId: `rollback:${target.receiptId}:${this.receipts.length + 1}`,
      actor,
      actorRole,
      action: `${target.action}.rollback`,
      targetType: target.targetType,
      targetId: target.targetId,
      beforeState: { ...target.afterState },
      afterState: { ...target.beforeState },
      reason,
      issuedAt,
      rollbackOfReceiptId: target.receiptId,
    });

    return receipt;
  }

  verifyIntegrity(): ReceiptVerificationResult {
    return verifyAuditReceiptChain(this.receipts, this.keyRing);
  }

  listReceipts(): AdminChangeReceipt[] {
    return [...this.receipts];
  }
}
