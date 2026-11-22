import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";

export const RECEIPT_VERSION = 1;
export const RECEIPT_ALGORITHM = "ed25519";
export const RECEIPT_DOMAIN = "vaultquest-receipt:v1\n";

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
