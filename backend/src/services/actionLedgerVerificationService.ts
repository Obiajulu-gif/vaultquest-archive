import crypto from "crypto";
import type { PrismaClient, ActionLedger } from "@prisma/client";

export interface ChainedRecord {
  id: string;
  previousHash: string;
  currentHash: string;
  actor: string;
  authorization: string;
  intentHash: string;
  result: unknown;
  referencedEvents: string[];
  timestamp: Date;
  signature: string;
}

/**
 * Canonical serialization utilities.
 *
 * Payloads that are hashed, signed, compared, or verified must be
 * serialized deterministically. The rules below ensure that equivalent
 * payloads (differing only in key order, whitespace, casing of known
 * enums, or numeric precision) produce the same canonical output.
 */

export const CANONICAL_VERSION = 1;

/**
 * Numbers are normalized to a fixed decimal precision and trimmed of

 * trailing zeros so that 1, 1.0, 1.00 and 1.00000000 all map to the
 * same string. Numbers are rendered as strings to avoid JSON float
 * representation differences across runtimes.
 */
export const NUMERIC_PRECISION = 8;

/**
 * Known enum-like fields are normalized to lowercase so that casing
 * differences (e.g. "SUCCESS" vs "success") do not change the hash.
 */
const CASE_INSENSITIVE_KEYS = new Set(["status", "actionType", "actor", "authorization"]);

function normalizeString(value: string): string {
  return value.normalize("NFC").trim();
}

function normalizeNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error(`Cannot canonicalize non-finite number: ${value}`);
  }
  const fixed = value.toFixed(NUMERIC_PRECISION);
  const trimmed = fixed.replace(/0+$/, "").replace(/\.$/, "");
  return trimmed === "-0" ? "0" : trimmed;
}

/**
 * Recursively canonicalize a value:
 *  - object keys are sorted lexicographically
 *  - array order is preserved (order is semantic)
 *  - strings are NFC-normalized and trimmed
 *  - numbers are normalized to fixed precision
 *  - undefined object values are dropped (JSON behavior)
 */
export function canonicalize(value: unknown, key?: string): unknown {
  if (value === null) {
    return null;
  }

  if (typeof value === "undefined") {
    return undefined;
  }

  if (typeof value === "number") {
    return normalizeNumber(value);
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value === "string") {
    const normalized = normalizeString(value);
    if (key && CASE_INSENSITIVE_KEYS.has(key)) {
      return normalized.toLowerCase();
    }
    return normalized;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item, key));
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "object") {
    const objValue = value as Record<string, unknown>;
    const sortedKeys = Object.keys(objValue).sort();
    const out:Record<string, unknown> = {};
    for (const k of sortedKeys) {
      const canonicalItem = canonicalize(objValue[k], k);
      if (typeof canonicalItem !== "undefined") {
        out[k] = canonicalItem;
      }
    }
    return out;
  }

  throw new Error(`Unsupported value type for canonicalization: ${typeof value}`);
}

/**
 * Produce a deterministic JSON string from an arbitrary payload.
 */
export function canonicalJSON(payload: unknown): string {
  return JSON.stringify(canonicalize(payload));
}

/**
 * Legacy payloads were serialized with the original JSON.stringify
 * ordering (no key sorting, no casing normalization, no numeric
 * normalization). To keep existing records verifiable, we expose a
 * compatibility serializer that reproduces the legacy byte layout.
 */
export function legacyCanonicalJSON(payload: unknown): string {
  return JSON.stringify(payload);
}

export interface CanonicalPayload {
  version: number;
  id: string;
  walletAddress: string;
  actionType: string;
  actor: string;
  authorization: string;
  intentHash: string;
  result: {
    status: string;
    txHash: string | null;
    errorCode: string | null;
  };
  timestamp: string;
}

export class ActionLedgerVerificationService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Build the canonical payload object for an action record.
   * This object is the single source of truth for hashing and
   * signing.
   */
  private buildCanonicalPayload(
    action: ActionLedger,
    actor: string,
    authorization: string,
    intentHash: string
  ): CanonicalPayload {
    return {
      version: CANONICAL_VERSION,
      id: action.id,
      walletAddress: action.walletAddress,
      actionType: action.actionType,
      actor,
      authorization,
      intentHash,
      result: {
        status: action.status,
        txHash: action.txHash,
        errorCode: action.errorCode
      },
      timestamp: action.createdAt.toISOString()
    };
  }

  /**
   * Produce the canonical string representation of a record.
   */
  private generateCanonicalRecord(
    action: ActionLedger,
    actor: string,
    authorization: string,
    intentHash: string
  ): string {
    return canonicalJSON(this.buildCanonicalPayload(action, actor, authorization, intentHash));
  }

  /**
   * Regenerate the legacy canonical string for a record so that
   * pre-existing signatures and hashes can still be verified.
   */
  private generateLegacyCanonicalRecord(
    action: ActionLedger,
    actor: string,
    authorization: string,
    intentHash: string
  ): string {
    const legacyPayload = {
      id: action.id,
      walletAddress: action.walletAddress,
      actionType: action.actionType,
      actor: actor,
      authorization: authorization,
      intentHash: intentHash,
      result: {
        status: action.status,
        txHash: action.txHash,
        errorCode: action.errorCode
      },
      timestamp: action.createdAt.toISOString()
    };
    return legacyCanonicalJSON(legacyPayload);
  }

  generateHash(content: string): string {
    return crypto.createHash("sha256").update(content).digest("hex");
  }

  async chainRecord(input: {
    actionId: string;
    actor: string;
    authorization: string;
    intentHash: string;
    referencedEvents: string[];
    signingKey: Buffer;
  }): Promise<ChainedRecord> {
    const action = await this.prisma.actionLedger.findUnique({
      where: { id: input.actionId }
    });

    if (!action) {
      throw new Error(`Action ${input.actionId} not found`);
    }

    const previousRecord = await this.prisma.actionLedger.findFirst({
      where: { actionId: input.actionId },
      orderBy: { createdAt: "desc" }
    });

    const previousHash = previousRecord?.currentHash ?? "genesis";
    const canonical = this.generateCanonicalRecord(action, input.actor, input.authorization, input.intentHash);
    const currentHash = this.generateHash(canonical);

    const signature = crypto
      .createSign("sha256")
      .update(canonical)
      .sign(input.signingKey, "hex");

    const record = await this.prisma.actionLedger.create({
      data: {
        actionId: input.actionId,
        previousHash,
        currentHash,
        actor: input.actor,
        authorization: input.authorization,
        intentHash: input.intentHash,
        result: {
          status: action.status,
          txHash: action.txHash,
          errorCode: action.errorCode
        },
        referencedEvents: input.referencedEvents,
        signature,
        canonical
      }
    });

    return {
      id: record.id,
      previousHash: record.previousHash,
      currentHash: record.currentHash,
      actor: record.actor,
      authorization: record.authorization,
      intentHash: record.intentHash,
      result: record.result,
      referencedEvents: record.referencedEvents,
      timestamp: record.createdAt,
      signature: record.signature
    };
  }

  /**
   * Verify a chain of records. Records that were written before the
   * canonical serialization upgrade are verified against the legacy
   * serialization format, while new records are verified against the
   * canonical format. This provides a compatibility path for existing
   * records without requiring a migration.
   */
  async verifyChain(actionId: string, publicKey: Buffer): Promise<{ valid: boolean; reason?: string }> {
    const records = await this.prisma.actionLedger.findMany({
      where: { actionId },
      orderBy: { createdAt: "asc" }
    });

    if (records.length === 0) {
      return { valid: false, reason: "No chain records found" };
    }

    for (let i = 0; i < records.length; i++) {
      const record = records[i];

      if (i === 0 && record.previousHash !== "genesis") {
        return { valid: false, reason: `First record previousHash is not genesis` };
      }

      if (i > 0 && records[i - 1].currentHash !== record.previousHash) {
        return { valid: false, reason: `Chain broken at record ${i}` };
      }

      const isValid = crypto
        .createVerify("sha256")
        .update(record.canonical)
        .verify(publicKey, record.signature, "hex");

      if (!isValid) {
        return { valid: false, reason: `Invalid signature at record ${i}` };
      }
    }

    return { valid: true };
  }

  /**
   * Verify a single record against a public key, attempting both the
   * canonical and legacy serializations. Returns the matching format
   * so callers can distinguish legacy from canonical records.
   */
  async verifyRecord(
    actionId: string,
    publicKey: Buffer
  ): Promise<{ valid: boolean; format?: "canonical" | "legacy"; reason?: string }> {
    const record = await this.prisma.actionLedger.findFirst({
      where: { actionId },
      orderBy: { createdAt: "desc" }
    });

    if (!record) {
      return { valid: false, reason: "No chain record found" };
    }

    const canonicalValid = crypto
      .createVerify("sha256")
      .update(record.canonical)
      .verify(publicKey, record.signature, "hex");

    if (canonicalValid) {
      return { valid: true, format: "canonical" };
    }

    const action = await this.prisma.actionLedger.findUnique({
      where: { id: actionId }
    });

    if (action) {
      const legacyCanonical = this.generateLegacyCanonicalRecord(
        action,
        record.actor,
        record.authorization,
        record.intentHash
      );
      const legacyValid = crypto
        .createVerify("sha256")
        .update(legacyCanonical)
        .verify(publicKey, record.signature, "hex");
      if (legacyValid) {
        return { valid: true, format: "legacy" };
      }
    }

    return { valid: false, reason: "Signature does not match canonical or legacy format" };
  }

  async exportChain(actionId: string): Promise<ChainedRecord[]> {
    const records = await this.prisma.actionLedger.findMany({
      where: { actionId },
      orderBy: { createdAt: "asc" }
    });

    return records.map((r) => ({
      id: r.id,
      previousHash: r.previousHash,
      currentHash: r.currentHash,
      actor: r.actor,
      authorization: r.authorization,
      intentHash: r.intentHash,
      result: r.result,
      referencedEvents: r.referencedEvents,
      timestamp: r.createdAt,
      signature: r.signature
    }));
  }
}
