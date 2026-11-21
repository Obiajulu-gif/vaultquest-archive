import { describe, it, expect } from "vitest";
import {
  AUDIT_RECEIPT_REASONS,
  AuditReceiptError,
  GENESIS_RECEIPT_HASH,
  SignedAuditReceiptLedger,
  verifyAuditReceipt,
  verifyAuditReceiptChain,
  type SigningKeyRing,
} from "./signed-audit-receipts";

const KEY_RING: SigningKeyRing = {
  activeKeyId: "k-2026-q4",
  keys: {
    "k-2026-q4": "test-only-hmac-key-material-q4",
  },
};

function reasonOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err instanceof AuditReceiptError ? err.reasonCode : `unexpected:${String(err)}`;
  }
}

describe("Signed audit receipts for admin changes (#1115)", () => {
  it("issues hash-chained signed receipts and verifies chain integrity across key rotation", () => {
    const ledger = new SignedAuditReceiptLedger(KEY_RING);

    const r1 = ledger.recordChange({
      changeId: "chg-1",
      actor: "admin-alice",
      actorRole: "admin",
      action: "pool.fee_update",
      targetType: "pool",
      targetId: "pool-1",
      beforeState: { feeBps: 50 },
      afterState: { feeBps: 75 },
      reason: "Governance proposal #12",
      issuedAt: 1_760_000_000_000,
    });

    expect(r1.deduplicatedRetry).toBe(false);
    expect(r1.receipt.sequence).toBe(1);
    expect(r1.receipt.prevReceiptHash).toBe(GENESIS_RECEIPT_HASH);

    // Rotate signing key and issue a second receipt; both old and new must verify.
    ledger.rotateSigningKey("k-2027-q1", "test-only-hmac-key-material-q1");

    const r2 = ledger.recordChange({
      changeId: "chg-2",
      actor: "sec-bob",
      actorRole: "security_admin",
      action: "pool.pause_toggle",
      targetType: "pool",
      targetId: "pool-1",
      beforeState: { paused: false },
      afterState: { paused: true },
      reason: "Emergency maintenance",
      issuedAt: 1_760_000_060_000,
    });

    expect(r2.receipt.sequence).toBe(2);
    expect(r2.receipt.prevReceiptHash).toBe(r1.receipt.payloadHash);
    expect(r2.receipt.keyId).toBe("k-2027-q1");
    expect(ledger.verifyIntegrity().valid).toBe(true);
  });

  it("handles idempotent retries on changeId and rejects conflicting changeId reuse", () => {
    const ledger = new SignedAuditReceiptLedger(KEY_RING);
    const first = ledger.recordChange({
      changeId: "chg-retry",
      actor: "admin-alice",
      actorRole: "admin",
      action: "pool.fee_update",
      targetType: "pool",
      targetId: "pool-1",
      beforeState: { feeBps: 50 },
      afterState: { feeBps: 75 },
      reason: "Retry test",
    });

    const retry = ledger.recordChange({
      changeId: "chg-retry",
      actor: "admin-alice",
      actorRole: "admin",
      action: "pool.fee_update",
      targetType: "pool",
      targetId: "pool-1",
      beforeState: { feeBps: 50 },
      afterState: { feeBps: 75 },
      reason: "Retry test",
    });

    expect(retry.deduplicatedRetry).toBe(true);
    expect(retry.receipt.receiptId).toBe(first.receipt.receiptId);
    expect(ledger.listReceipts().length).toBe(1);

    expect(
      reasonOf(() =>
        ledger.recordChange({
          changeId: "chg-retry",
          actor: "admin-alice",
          actorRole: "admin",
          action: "pool.fee_update",
          targetType: "pool",
          targetId: "pool-1",
          beforeState: { feeBps: 50 },
          afterState: { feeBps: 99 }, // different afterState
          reason: "Tampered retry",
        }),
      ),
    ).toBe(AUDIT_RECEIPT_REASONS.CONFLICTING_CHANGE_ID);
  });

  it("rejects unauthorized roles and detects payload tampering, forged signatures, and broken chains", () => {
    const ledger = new SignedAuditReceiptLedger(KEY_RING);
    expect(
      reasonOf(() =>
        ledger.recordChange({
          changeId: "chg-unauth",
          actor: "viewer-dan",
          actorRole: "viewer",
          action: "pool.fee_update",
          targetType: "pool",
          targetId: "pool-1",
          beforeState: { feeBps: 50 },
          afterState: { feeBps: 75 },
          reason: "Should fail",
        }),
      ),
    ).toBe(AUDIT_RECEIPT_REASONS.UNAUTHORIZED_ACTOR);

    const { receipt } = ledger.recordChange({
      changeId: "chg-valid",
      actor: "admin-alice",
      actorRole: "admin",
      action: "pool.fee_update",
      targetType: "pool",
      targetId: "pool-1",
      beforeState: { feeBps: 50 },
      afterState: { feeBps: 75 },
      reason: "Valid change",
    });

    // Tamper with afterState without recomputing hash
    const tamperedPayload = { ...receipt, afterState: { feeBps: 0 } };
    expect(verifyAuditReceipt(tamperedPayload, KEY_RING)).toEqual({
      valid: false,
      reasonCode: AUDIT_RECEIPT_REASONS.PAYLOAD_HASH_MISMATCH,
      message: expect.stringMatching(/payloadHash does not match/),
    });

    // Tamper with signature
    const forgedSig = { ...receipt, signature: "0".repeat(64) };
    expect(verifyAuditReceipt(forgedSig, KEY_RING).reasonCode).toBe(
      AUDIT_RECEIPT_REASONS.SIGNATURE_INVALID,
    );

    // Broken prevReceiptHash link
    const brokenChain = verifyAuditReceiptChain(
      [{ ...receipt, prevReceiptHash: "wrong-prev" }],
      KEY_RING,
    );
    expect(brokenChain.reasonCode).toBe(AUDIT_RECEIPT_REASONS.CHAIN_BROKEN);
  });

  it("generates a verified rollback receipt restoring beforeState", () => {
    const ledger = new SignedAuditReceiptLedger(KEY_RING);
    const { receipt } = ledger.recordChange({
      changeId: "chg-to-revert",
      actor: "admin-alice",
      actorRole: "admin",
      action: "pool.fee_update",
      targetType: "pool",
      targetId: "pool-1",
      beforeState: { feeBps: 50 },
      afterState: { feeBps: 90 },
      reason: "Accidental high fee",
    });

    const rollback = ledger.rollbackReceipt(
      receipt.receiptId,
      "sec-bob",
      "security_admin",
      "Revert accidental fee bump",
    );

    expect(rollback.sequence).toBe(2);
    expect(rollback.rollbackOfReceiptId).toBe(receipt.receiptId);
    expect(rollback.beforeState).toEqual({ feeBps: 90 });
    expect(rollback.afterState).toEqual({ feeBps: 50 });
    expect(ledger.verifyIntegrity().valid).toBe(true);
  });
});
