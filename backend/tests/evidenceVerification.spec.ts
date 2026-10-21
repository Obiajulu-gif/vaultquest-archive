import { describe, it, expect } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  EVIDENCE_DOMAIN,
  evidenceDigest,
  evidenceIdFor,
  issueEvidence,
  verifyImportedEvidence,
  type EvidenceIssuer,
} from "../src/services/evidenceVerification.js";

function keypairIssuer(kp: Keypair): EvidenceIssuer {
  return { keyId: kp.publicKey(), sign: (message) => kp.sign(message).toString("base64") };
}

describe("evidence verification (#976)", () => {
  it("accepts evidence signed by a trusted key and bound to its payload", () => {
    const kp = Keypair.random();
    const payload = { settlement: "ok", amount: "100.0000000", pool: "p-1" };
    const signed = issueEvidence({
      source: "oracle:acme",
      subject: "p-1",
      payload,
      issuer: keypairIssuer(kp),
      issuedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(verifyImportedEvidence(signed, [kp.publicKey()])).toEqual({ valid: true });
    // Binding the raw payload proves it was not swapped after signing.
    expect(verifyImportedEvidence(signed, [kp.publicKey()], { payload })).toEqual({ valid: true });
  });

  it("derives a stable id and digest so a re-import is idempotent", () => {
    const payload = { b: 2, a: 1 };
    const reordered = { a: 1, b: 2 };
    expect(evidenceDigest(payload)).toBe(evidenceDigest(reordered));

    const kp = Keypair.random();
    const signer = keypairIssuer(kp);
    const first = issueEvidence({ source: "s", subject: "x", payload, issuer: signer, issuedAt: "2026-01-01T00:00:00.000Z" });
    const second = issueEvidence({ source: "s", subject: "x", payload: reordered, issuer: signer, issuedAt: "2026-01-01T00:00:00.000Z" });
    expect(first.evidenceId).toBe(second.evidenceId);
    expect(first.signature).toBe(second.signature);
    expect(first.evidenceId).toBe(evidenceIdFor("s", "x", evidenceDigest(payload)));
  });

  it("rejects a tampered claim set (bad signature)", () => {
    const kp = Keypair.random();
    const signed = issueEvidence({ source: "oracle:acme", subject: "p-1", payload: { v: 1 }, issuer: keypairIssuer(kp) });
    const tampered = { ...signed, subject: "p-2" };
    expect(verifyImportedEvidence(tampered, [kp.publicKey()])).toEqual({ valid: false, reason: "BAD_SIGNATURE" });
  });

  it("rejects an untrusted issuer key", () => {
    const kp = Keypair.random();
    const other = Keypair.random();
    const signed = issueEvidence({ source: "s", subject: "x", payload: { v: 1 }, issuer: keypairIssuer(kp) });
    expect(verifyImportedEvidence(signed, [other.publicKey()])).toEqual({ valid: false, reason: "UNKNOWN_KEY" });
  });

  it("rejects a payload that does not match the signed digest", () => {
    const kp = Keypair.random();
    const signed = issueEvidence({ source: "s", subject: "x", payload: { v: 1 }, issuer: keypairIssuer(kp) });
    expect(verifyImportedEvidence(signed, [kp.publicKey()], { payload: { v: 2 } })).toEqual({
      valid: false,
      reason: "DIGEST_MISMATCH",
    });
  });

  it("fails closed on malformed or unsupported envelopes", () => {
    const kp = Keypair.random();
    expect(verifyImportedEvidence(null, [kp.publicKey()])).toEqual({ valid: false, reason: "MALFORMED" });
    expect(verifyImportedEvidence({ algorithm: "ed25519" }, [kp.publicKey()])).toEqual({ valid: false, reason: "MALFORMED" });

    const signed = issueEvidence({ source: "s", subject: "x", payload: { v: 1 }, issuer: keypairIssuer(kp) });
    expect(verifyImportedEvidence({ ...signed, version: 99 }, [kp.publicKey()])).toEqual({
      valid: false,
      reason: "UNSUPPORTED_VERSION",
    });
    expect(verifyImportedEvidence({ ...signed, digest: "not-a-hash" }, [kp.publicKey()])).toEqual({
      valid: false,
      reason: "MALFORMED",
    });
  });

  it("domain-separates its signatures", () => {
    expect(EVIDENCE_DOMAIN).toBe("vaultquest-evidence:v1\n");
  });
});
