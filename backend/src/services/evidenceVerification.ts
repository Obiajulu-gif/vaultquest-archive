/**
 * Cryptographic verification of imported external evidence (#976).
 *
 * External systems hand VaultQuest "evidence" — a signed statement that some
 * payload (a settlement report, an oracle reading, a third-party export) is
 * authentic and unmodified. Before such a record is trusted, imported, or
 * surfaced, the importer verifies it locally:
 *
 *   1. shape and supported version,
 *   2. the issuer key is one we trust (`trustedKeyIds`),
 *   3. the ed25519 signature is valid over the *canonical* claims,
 *   4. when the raw payload is supplied, it hashes to the claimed digest.
 *
 * Signatures are domain-separated (`EVIDENCE_DOMAIN`) so an evidence signature
 * can never be replayed as a receipt, webhook, or any other signed object, and
 * are computed over `canonicalJson` so key order and whitespace cannot change
 * the bytes. Verification fails closed: anything unexpected is invalid.
 */

import crypto from "crypto";
import { Keypair } from "@stellar/stellar-sdk";
import { canonicalJson } from "../utils/canonicalJson.js";

export const EVIDENCE_VERSION = 1 as const;
export const EVIDENCE_ALGORITHM = "ed25519" as const;
export const EVIDENCE_DOMAIN = "vaultquest-evidence:v1\n";

/** The fields an evidence envelope asserts, and the bytes the signature covers. */
export interface EvidenceClaims {
  version: typeof EVIDENCE_VERSION;
  evidenceId: string;
  /** External system the evidence came from (e.g. "oracle:acme"). */
  source: string;
  /** The entity the evidence is about (e.g. a pool id). */
  subject: string;
  /** sha256 (hex) of the raw payload the importer received. */
  digest: string;
  /** ISO-8601 issuance time asserted by the issuer. */
  issuedAt: string;
}

export interface SignedEvidence extends EvidenceClaims {
  algorithm: typeof EVIDENCE_ALGORITHM;
  /** Issuer's Stellar public key (G...). */
  keyId: string;
  /** Base64 ed25519 signature over EVIDENCE_DOMAIN + canonicalJson(claims). */
  signature: string;
}

export type EvidenceVerificationFailure =
  | "MALFORMED"
  | "UNSUPPORTED_VERSION"
  | "UNKNOWN_KEY"
  | "BAD_SIGNATURE"
  | "DIGEST_MISMATCH";

export interface EvidenceVerification {
  valid: boolean;
  reason?: EvidenceVerificationFailure;
}

const HEX64 = /^[0-9a-f]{64}$/;

/** sha256 of the canonical form of a payload. Stable regardless of key order. */
export function evidenceDigest(payload: unknown): string {
  return crypto.createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex");
}

export function evidenceIdFor(source: string, subject: string, digest: string): string {
  return `evid_${crypto.createHash("sha256").update(`${source}:${subject}:${digest}`).digest("hex").slice(0, 40)}`;
}

/** The exact claim bytes that are signed for an envelope. */
export function evidenceClaims(evidence: EvidenceClaims): EvidenceClaims {
  return {
    version: EVIDENCE_VERSION,
    evidenceId: evidence.evidenceId,
    source: evidence.source,
    subject: evidence.subject,
    digest: evidence.digest,
    issuedAt: evidence.issuedAt
  };
}

export function evidenceMessage(claims: EvidenceClaims): Buffer {
  return Buffer.from(EVIDENCE_DOMAIN + canonicalJson(evidenceClaims(claims)), "utf8");
}

export interface EvidenceIssuer {
  readonly keyId: string;
  sign(message: Buffer): string;
}

/**
 * Builds a signed envelope for a payload. `evidenceId` and `digest` are derived
 * from the content, so re-issuing the same payload yields the same id, and a
 * modified payload can never keep the old digest.
 */
export function issueEvidence(input: {
  source: string;
  subject: string;
  payload: unknown;
  issuer: EvidenceIssuer;
  issuedAt?: string;
}): SignedEvidence {
  const digest = evidenceDigest(input.payload);
  const claims: EvidenceClaims = {
    version: EVIDENCE_VERSION,
    evidenceId: evidenceIdFor(input.source, input.subject, digest),
    source: input.source,
    subject: input.subject,
    digest,
    issuedAt: input.issuedAt ?? new Date().toISOString()
  };
  return {
    ...claims,
    algorithm: EVIDENCE_ALGORITHM,
    keyId: input.issuer.keyId,
    signature: input.issuer.sign(evidenceMessage(claims))
  };
}

/**
 * Verifies an imported evidence envelope. Pass `options.payload` to also bind
 * the envelope to the raw payload the importer received (digest check).
 */
export function verifyImportedEvidence(
  evidence: unknown,
  trustedKeyIds: readonly string[],
  options?: { payload?: unknown }
): EvidenceVerification {
  const e = evidence as Partial<SignedEvidence> | null;
  if (
    !e ||
    typeof e !== "object" ||
    typeof e.evidenceId !== "string" ||
    typeof e.source !== "string" ||
    typeof e.subject !== "string" ||
    typeof e.digest !== "string" ||
    typeof e.issuedAt !== "string" ||
    typeof e.keyId !== "string" ||
    typeof e.signature !== "string" ||
    e.algorithm !== EVIDENCE_ALGORITHM
  ) {
    return { valid: false, reason: "MALFORMED" };
  }
  if (e.version !== EVIDENCE_VERSION) return { valid: false, reason: "UNSUPPORTED_VERSION" };
  if (!HEX64.test(e.digest)) return { valid: false, reason: "MALFORMED" };
  if (!trustedKeyIds.includes(e.keyId)) return { valid: false, reason: "UNKNOWN_KEY" };

  let ok = false;
  try {
    ok = Keypair.fromPublicKey(e.keyId).verify(
      evidenceMessage(e as EvidenceClaims),
      Buffer.from(e.signature, "base64")
    );
  } catch {
    return { valid: false, reason: "MALFORMED" };
  }
  if (!ok) return { valid: false, reason: "BAD_SIGNATURE" };

  if (options && "payload" in options) {
    if (evidenceDigest(options.payload) !== e.digest) return { valid: false, reason: "DIGEST_MISMATCH" };
  }
  return { valid: true };
}
