import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";

export const RECEIPT_VERSION = 1;
export const RECEIPT_ALGORITHM = "ed25519";
export const RECEIPT_DOMAIN = "vaultquest-receipt:v1\n";

/** Chain sentinel used by the first admin-change receipt in a ledger (#1163). */
export const AUDIT_RECEIPT_GENESIS_HASH = "GENESIS";

export const AUDIT_RECEIPT_CHAIN_REASONS = Object.freeze({
  INVALID_INPUT: "AUDIT_RECEIPT_INVALID_INPUT",
  VERIFICATION_KEY_MISSING: "AUDIT_RECEIPT_VERIFICATION_KEY_MISSING",
  CHAIN_SEQUENCE_GAP: "AUDIT_RECEIPT_CHAIN_SEQUENCE_GAP",
  CHAIN_BROKEN: "AUDIT_RECEIPT_CHAIN_BROKEN",
  ROLLBACK_TARGET_NOT_FOUND: "AUDIT_RECEIPT_ROLLBACK_TARGET_NOT_FOUND",
  ROLLBACK_LINK_INVALID: "AUDIT_RECEIPT_ROLLBACK_LINK_INVALID",
  TARGET_RECEIPT_INVALID: "AUDIT_RECEIPT_TARGET_INVALID",
});

export const PRIVILEGED_AUDIT_OPERATIONS = [
  "role_grant",
  "role_revoke",
  "config_change",
  "repair_execute",
  "key_rotation",
  "emergency_pause",
];

export const RECEIPT_STAGES = [
  "requested",
  "submitted",
  "confirmed",
  "failed",
  "reverted",
  "orphaned",
];

const STATUS_TO_STAGE = {
  pending: "requested",
  requested: "requested",
  submitted: "submitted",
  confirmed: "confirmed",
  failed: "failed",
  reverted: "reverted",
  orphaned: "orphaned",
};

const AUTHORIZED_ISSUER_ROLES = new Set(["admin", "security_officer"]);

export class AuditReceiptAuthorizationError extends Error {
  constructor(message) {
    super(message);
    this.name = "AuditReceiptAuthorizationError";
    this.code = "AUDIT_RECEIPT_UNAUTHORIZED";
    this.statusCode = 403;
  }
}

export class AuditReceiptValidationError extends Error {
  constructor(message, code = "AUDIT_RECEIPT_INVALID") {
    super(message);
    this.name = "AuditReceiptValidationError";
    this.code = code;
    this.statusCode = 400;
  }
}

/**
 * Deterministic canonical JSON serialization (sorted object keys).
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  const entries = keys
    .filter((k) => value[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`);
  return `{${entries.join(",")}}`;
}

function sha256Hex(input) {
  return createHash("sha256").update(input).digest("hex");
}

function toIsoTimestamp(ts) {
  if (!ts) return new Date(0).toISOString();
  if (ts instanceof Date) return ts.toISOString();
  const parsed = new Date(ts);
  if (Number.isNaN(parsed.getTime())) {
    throw new AuditReceiptValidationError(`Invalid timestamp: ${ts}`);
  }
  return parsed.toISOString();
}

/**
 * Generate an Ed25519 keypair + keyId for signing and verifying audit receipts.
 */
export function createEd25519Signer(keyIdPrefix = "vq-audit") {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
  const keyId = `${keyIdPrefix}-${sha256Hex(publicKeyPem).slice(0, 12)}`;
  return { keyId, publicKeyPem, privateKeyPem };
}

/**
 * Authorize an actor to issue signed audit receipts for privileged actions.
 */
export function authorizeAuditReceiptIssuer(actor) {
  if (!actor || typeof actor.id !== "string" || !actor.id.trim()) {
    throw new AuditReceiptAuthorizationError("Authenticated actor is required to issue audit receipts.");
  }
  const role = typeof actor.role === "string" ? actor.role.toLowerCase() : "";
  const scopes = new Set(Array.isArray(actor.scopes) ? actor.scopes : []);

  if (!AUTHORIZED_ISSUER_ROLES.has(role) && !scopes.has("audit:issue")) {
    throw new AuditReceiptAuthorizationError(
      `Actor ${actor.id} with role '${role || "none"}' is not authorized to issue privileged audit receipts.`,
    );
  }
  return true;
}

/**
 * Derive deterministic receipt payload from an action snapshot (no wall-clock/random).
 */
export function buildAuditReceiptPayload(action) {
  if (!action || typeof action !== "object") {
    throw new AuditReceiptValidationError("Action snapshot is required.");
  }
  if (!action.id || !action.idempotencyKey || !action.actorId) {
    throw new AuditReceiptValidationError("Action requires id, idempotencyKey, and actorId.");
  }
  if (!PRIVILEGED_AUDIT_OPERATIONS.includes(action.operation)) {
    throw new AuditReceiptValidationError(
      `Unsupported privileged operation '${action.operation}'.`,
      "UNSUPPORTED_PRIVILEGED_OPERATION",
    );
  }

  // Optional, additive chain fields (#1163). Existing callers are unchanged;
  // when present they are covered by the signed canonical payload.
  if (
    action.sequence !== undefined &&
    (!Number.isInteger(action.sequence) || action.sequence < 1)
  ) {
    throw new AuditReceiptValidationError(
      "Receipt sequence must be a positive integer.",
      AUDIT_RECEIPT_CHAIN_REASONS.INVALID_INPUT,
    );
  }
  if (
    action.prevReceiptHash !== undefined &&
    (typeof action.prevReceiptHash !== "string" || !action.prevReceiptHash.trim())
  ) {
    throw new AuditReceiptValidationError(
      "prevReceiptHash must be a non-empty string.",
      AUDIT_RECEIPT_CHAIN_REASONS.INVALID_INPUT,
    );
  }
  if (
    action.rollbackOfReceiptId !== undefined &&
    (typeof action.rollbackOfReceiptId !== "string" || !action.rollbackOfReceiptId.trim())
  ) {
    throw new AuditReceiptValidationError(
      "rollbackOfReceiptId must be a non-empty string.",
      AUDIT_RECEIPT_CHAIN_REASONS.INVALID_INPUT,
    );
  }

  const stage = STATUS_TO_STAGE[action.status];
  if (!stage) {
    throw new AuditReceiptValidationError(`Unsupported action status '${action.status}'.`);
  }

  const receiptId = sha256Hex(`${action.id}:${stage}`);
  const requestDigest = sha256Hex(
    canonicalJson({
      actorId: action.actorId,
      operation: action.operation,
      target: action.target ?? null,
      params: action.params ?? {},
      idempotencyKey: action.idempotencyKey,
    }),
  );

  return {
    version: RECEIPT_VERSION,
    receiptId,
    operation: action.operation,
    stage,
    actionId: action.id,
    idempotencyKey: action.idempotencyKey,
    ...(action.sequence !== undefined ? { sequence: action.sequence } : {}),
    ...(action.prevReceiptHash !== undefined ? { prevReceiptHash: action.prevReceiptHash } : {}),
    ...(action.rollbackOfReceiptId !== undefined ? { rollbackOfReceiptId: action.rollbackOfReceiptId } : {}),
    actor: {
      id: action.actorId,
      role: action.actorRole ?? "unknown",
    },
    target: action.target ?? null,
    requestDigest,
    requestedAt: toIsoTimestamp(action.createdAt),
    occurredAt: toIsoTimestamp(action.occurredAt ?? action.updatedAt ?? action.createdAt),
    correlationId: action.correlationId ?? action.id,
    errorCode: action.errorCode ?? null,
  };
}

/**
 * In-memory idempotent receipt store (`insertIfAbsent` by receiptId).
 */
export class InMemoryAuditReceiptStore {
  constructor() {
    this.receipts = new Map();
  }

  async insertIfAbsent(envelope) {
    const existing = this.receipts.get(envelope.payload.receiptId);
    if (existing) {
      return { envelope: structuredClone(existing), created: false };
    }
    const copy = structuredClone(envelope);
    this.receipts.set(envelope.payload.receiptId, copy);
    return { envelope: copy, created: true };
  }

  async getByReceiptId(receiptId) {
    const found = this.receipts.get(receiptId);
    return found ? structuredClone(found) : null;
  }

  /** Ordered snapshot for chain verification (#1163). */
  list() {
    return Array.from(this.receipts.values(), (envelope) => structuredClone(envelope));
  }
}

/**
 * Sign and persist a privileged audit receipt with idempotency and retry handling.
 */
export async function issuePrivilegedAuditReceipt({
  actor,
  action,
  signer,
  store = new InMemoryAuditReceiptStore(),
  maxRetries = 2,
}) {
  authorizeAuditReceiptIssuer(actor);

  if (!signer?.privateKeyPem || !signer?.keyId) {
    throw new AuditReceiptValidationError("Valid Ed25519 signer (keyId, privateKeyPem) is required.");
  }

  const payload = buildAuditReceiptPayload(action);
  const canonicalPayload = canonicalJson(payload);
  const message = Buffer.from(`${RECEIPT_DOMAIN}${canonicalPayload}`, "utf8");
  const signature = sign(null, message, signer.privateKeyPem).toString("base64");

  const envelope = {
    algorithm: RECEIPT_ALGORITHM,
    domain: RECEIPT_DOMAIN,
    keyId: signer.keyId,
    payload,
    payloadDigest: sha256Hex(canonicalPayload),
    signature,
  };

  let attempt = 0;
  while (true) {
    try {
      return await store.insertIfAbsent(envelope);
    } catch (err) {
      if (err?.retryable && attempt < maxRetries) {
        attempt += 1;
        continue;
      }
      const wrapped = new Error(`Failed to persist audit receipt: ${err?.message ?? String(err)}`);
      wrapped.code = "RECEIPT_PERSISTENCE_FAILED";
      wrapped.cause = err;
      throw wrapped;
    }
  }
}

/**
 * Verify a signed audit receipt's Ed25519 signature, domain, and receiptId integrity.
 */
export function verifyAuditReceipt(envelope, publicKeyPem) {
  if (!envelope || !envelope.payload || !envelope.signature) {
    return { valid: false, reason: "MALFORMED_ENVELOPE" };
  }
  if (envelope.algorithm !== RECEIPT_ALGORITHM || envelope.domain !== RECEIPT_DOMAIN) {
    return { valid: false, reason: "UNSUPPORTED_ALGORITHM_OR_DOMAIN" };
  }

  const expectedReceiptId = sha256Hex(`${envelope.payload.actionId}:${envelope.payload.stage}`);
  if (envelope.payload.receiptId !== expectedReceiptId) {
    return { valid: false, reason: "RECEIPT_ID_MISMATCH" };
  }

  const canonicalPayload = canonicalJson(envelope.payload);
  if (envelope.payloadDigest && sha256Hex(canonicalPayload) !== envelope.payloadDigest) {
    return { valid: false, reason: "PAYLOAD_DIGEST_MISMATCH" };
  }

  const message = Buffer.from(`${RECEIPT_DOMAIN}${canonicalPayload}`, "utf8");
  let sigOk = false;
  try {
    sigOk = verify(null, message, publicKeyPem, Buffer.from(envelope.signature, "base64"));
  } catch {
    sigOk = false;
  }

  if (!sigOk) {
    return { valid: false, reason: "INVALID_SIGNATURE" };
  }

  return { valid: true, reason: null, receiptId: expectedReceiptId };
}

/**
 * Verify an ordered admin-change receipt chain (#1163).
 *
 * Checks contiguous 1-based sequences, `prevReceiptHash` links to the previous
 * receipt's payload digest, each Ed25519 signature, and that rollback receipts
 * point backwards to a receipt earlier in the same chain.
 */
export function verifyAdminChangeReceiptChain(envelopes, publicKeyPem) {
  if (!publicKeyPem) {
    return {
      valid: false,
      reason: AUDIT_RECEIPT_CHAIN_REASONS.VERIFICATION_KEY_MISSING,
      checked: 0,
    };
  }
  if (!Array.isArray(envelopes)) {
    return {
      valid: false,
      reason: AUDIT_RECEIPT_CHAIN_REASONS.INVALID_INPUT,
      checked: 0,
    };
  }

  let expectedPrevHash = AUDIT_RECEIPT_GENESIS_HASH;
  for (let i = 0; i < envelopes.length; i += 1) {
    const envelope = envelopes[i];
    const payload = envelope?.payload;
    if (!payload || !envelope.payloadDigest) {
      return { valid: false, reason: "MALFORMED_ENVELOPE", checked: i };
    }
    if (!Number.isInteger(payload.sequence) || payload.sequence !== i + 1) {
      return {
        valid: false,
        reason: AUDIT_RECEIPT_CHAIN_REASONS.CHAIN_SEQUENCE_GAP,
        checked: i,
      };
    }
    if (payload.prevReceiptHash !== expectedPrevHash) {
      return { valid: false, reason: AUDIT_RECEIPT_CHAIN_REASONS.CHAIN_BROKEN, checked: i };
    }

    const single = verifyAuditReceipt(envelope, publicKeyPem);
    if (!single.valid) return { valid: false, reason: single.reason, checked: i };

    if (payload.rollbackOfReceiptId) {
      const targetIndex = envelopes.findIndex(
        (candidate) => candidate?.payload?.receiptId === payload.rollbackOfReceiptId,
      );
      if (targetIndex < 0 || targetIndex >= i) {
        return {
          valid: false,
          reason: AUDIT_RECEIPT_CHAIN_REASONS.ROLLBACK_LINK_INVALID,
          checked: i,
        };
      }
    }

    expectedPrevHash = envelope.payloadDigest;
  }

  return { valid: true, reason: null, checked: envelopes.length };
}

/**
 * Append-only, hash-chained admin-change receipt ledger (#1163).
 *
 * Each receipt links to the previous receipt's payload digest, so an edited,
 * reordered, or removed receipt is detectable even when the store itself is
 * compromised. Retries are idempotent on `changeId`, and rollbacks are signed
 * receipts that reference the verified receipt they invert.
 *
 * The store must implement `insertIfAbsent()` from `issuePrivilegedAuditReceipt`;
 * implementing `list()` enables cross-process chain verification by returning
 * all persisted envelopes in insertion order.
 */
export class AdminChangeReceiptChain {
  constructor({ signer, store = new InMemoryAuditReceiptStore(), maxRetries = 2, nowFn = () => new Date() } = {}) {
    if (!signer?.privateKeyPem || !signer?.keyId) {
      throw new AuditReceiptValidationError("Valid Ed25519 signer (keyId, privateKeyPem) is required.");
    }
    this.signer = signer;
    this.store = store;
    this.maxRetries = maxRetries;
    this.nowFn = nowFn;
    this.entries = typeof store.list === "function" ? store.list() : [];
  }

  /** Payload digest of the most recent receipt, or the chain genesis sentinel. */
  get head() {
    const last = this.entries[this.entries.length - 1];
    return last?.payloadDigest ?? AUDIT_RECEIPT_GENESIS_HASH;
  }

  listReceipts() {
    return this.entries.map((envelope) => structuredClone(envelope));
  }

  getReceiptByChangeId(changeId) {
    const found = this.entries.find((envelope) => envelope.payload.idempotencyKey === changeId);
    return found ? structuredClone(found) : null;
  }

  /**
   * Sign and persist an admin-change receipt. A repeated `changeId` returns the
   * original receipt instead of advancing the chain (idempotent retry).
   */
  async recordChange({
    changeId,
    actor,
    actorRole,
    operation,
    target,
    beforeState = {},
    afterState = {},
    reason = "",
    correlationId,
    occurredAt,
    rollbackOfReceiptId,
  }) {
    authorizeAuditReceiptIssuer(actor);
    if (typeof changeId !== "string" || !changeId.trim()) {
      throw new AuditReceiptValidationError(
        "changeId is required.",
        AUDIT_RECEIPT_CHAIN_REASONS.INVALID_INPUT,
      );
    }

    const duplicate = this.getReceiptByChangeId(changeId);
    if (duplicate) {
      return { envelope: duplicate, created: false, deduplicatedRetry: true };
    }

    const timestamp = occurredAt ?? this.nowFn().toISOString();
    const action = {
      id: changeId,
      idempotencyKey: changeId,
      actorId: actor.id,
      actorRole: actorRole ?? actor.role,
      operation,
      target: target ?? null,
      // Raw states stay out of the signed payload; only their digest is committed.
      params: { beforeState, afterState, reason },
      status: "confirmed",
      createdAt: timestamp,
      occurredAt: timestamp,
      correlationId: correlationId ?? changeId,
      sequence: this.entries.length + 1,
      prevReceiptHash: this.head,
      ...(rollbackOfReceiptId ? { rollbackOfReceiptId } : {}),
    };

    const result = await issuePrivilegedAuditReceipt({
      actor,
      action,
      signer: this.signer,
      store: this.store,
      maxRetries: this.maxRetries,
    });
    if (result.created) this.entries.push(result.envelope);
    return { ...result, deduplicatedRetry: !result.created };
  }

  /** Verify every receipt and every link in the chain. */
  verifyChain(publicKeyPem = this.signer.publicKeyPem) {
    const envelopes = typeof this.store.list === "function" ? this.store.list() : this.entries;
    return verifyAdminChangeReceiptChain(envelopes, publicKeyPem);
  }

  /**
   * Record a verified rollback of an earlier receipt. `beforeState`/`afterState`
   * are supplied by the caller (normally the target's original values) because
   * raw state is intentionally not stored inside a receipt.
   */
  async rollback({ targetReceiptId, actor, actorRole, reason = "", beforeState = {}, afterState = {}, correlationId }) {
    authorizeAuditReceiptIssuer(actor);
    const target = this.entries.find((envelope) => envelope.payload.receiptId === targetReceiptId);
    if (!target) {
      throw new AuditReceiptValidationError(
        `Receipt ${targetReceiptId} not found.`,
        AUDIT_RECEIPT_CHAIN_REASONS.ROLLBACK_TARGET_NOT_FOUND,
      );
    }

    const check = verifyAuditReceipt(target, this.signer.publicKeyPem);
    if (!check.valid) {
      throw new AuditReceiptValidationError(
        `Cannot roll back an unverified receipt: ${check.reason}`,
        AUDIT_RECEIPT_CHAIN_REASONS.TARGET_RECEIPT_INVALID,
      );
    }

    return this.recordChange({
      changeId: `rollback:${targetReceiptId}`,
      actor,
      actorRole: actorRole ?? actor.role,
      operation: target.payload.operation,
      target: target.payload.target,
      beforeState,
      afterState,
      reason,
      correlationId: correlationId ?? target.payload.correlationId,
      rollbackOfReceiptId: targetReceiptId,
    });
  }
}
