// SPDX-License-Identifier: MIT

/**
 * Signed audit receipts for admin changes (#1163).
 *
 * Covers normal issuance, tampering/link failures, idempotent retry and
 * rollback recovery, and issuer authorization for the hash-chained ledger.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AdminChangeReceiptChain,
  AUDIT_RECEIPT_CHAIN_REASONS,
  AUDIT_RECEIPT_GENESIS_HASH,
  AuditReceiptAuthorizationError,
  AuditReceiptValidationError,
  InMemoryAuditReceiptStore,
  createEd25519Signer,
  verifyAdminChangeReceiptChain,
  verifyAuditReceipt,
} from "../../src/lib/signed-audit-receipts.mjs";

describe("signed audit receipts for admin changes (#1163)", () => {
  const signer = createEd25519Signer();
  const admin = { id: "admin-1", role: "admin" };
  const change = {
    changeId: "chg-fee-1",
    actor: admin,
    operation: "config_change",
    target: "pool:pool-1",
    beforeState: { feeBps: 50 },
    afterState: { feeBps: 75 },
    reason: "Governance proposal #12",
    occurredAt: "2026-11-22T10:00:00.000Z",
  };

  it("normal path: issues hash-chained, verifiable admin change receipts", async () => {
    const store = new InMemoryAuditReceiptStore();
    const chain = new AdminChangeReceiptChain({ signer, store });

    const first = await chain.recordChange(change);
    assert.equal(first.created, true);
    assert.equal(first.envelope.payload.sequence, 1);
    assert.equal(first.envelope.payload.prevReceiptHash, AUDIT_RECEIPT_GENESIS_HASH);

    const second = await chain.recordChange({
      ...change,
      changeId: "chg-pause-2",
      operation: "emergency_pause",
      afterState: { paused: true },
    });
    assert.equal(second.envelope.payload.sequence, 2);
    assert.equal(second.envelope.payload.prevReceiptHash, first.envelope.payloadDigest);

    assert.equal(verifyAuditReceipt(second.envelope, signer.publicKeyPem).valid, true);
    const check = chain.verifyChain();
    assert.equal(check.valid, true);
    assert.equal(check.checked, 2);
    assert.equal(
      verifyAdminChangeReceiptChain(chain.listReceipts(), signer.publicKeyPem).valid,
      true,
    );
  });

  it("failure path: detects payload tampering, sequence gaps, broken links and invalid rollbacks", async () => {
    const store = new InMemoryAuditReceiptStore();
    const chain = new AdminChangeReceiptChain({ signer, store });
    const first = await chain.recordChange(change);
    await chain.recordChange({ ...change, changeId: "chg-pause-2", operation: "emergency_pause" });

    const tampered = store.receipts.get(first.envelope.payload.receiptId);
    tampered.payload.target = "pool:pool-999";

    let check = chain.verifyChain();
    assert.equal(check.valid, false);
    assert.equal(check.reason, "PAYLOAD_DIGEST_MISMATCH");

    tampered.payload.target = change.target;
    tampered.payload.sequence = 7;
    check = chain.verifyChain();
    assert.equal(check.reason, AUDIT_RECEIPT_CHAIN_REASONS.CHAIN_SEQUENCE_GAP);

    tampered.payload.sequence = 1;
    tampered.payload.prevReceiptHash = "deadbeef";
    check = chain.verifyChain();
    assert.equal(check.reason, AUDIT_RECEIPT_CHAIN_REASONS.CHAIN_BROKEN);

    // Restore structural fields so the signature check (not the link check) is
    // what rejects a bogus verification key.
    tampered.payload.prevReceiptHash = AUDIT_RECEIPT_GENESIS_HASH;
    assert.equal(chain.verifyChain("not-a-public-key").reason, "INVALID_SIGNATURE");

    await assert.rejects(
      () => chain.rollback({ targetReceiptId: "missing-receipt", actor: admin }),
      (err) =>
        err instanceof AuditReceiptValidationError &&
        err.code === AUDIT_RECEIPT_CHAIN_REASONS.ROLLBACK_TARGET_NOT_FOUND,
    );
  });

  it("retry & recovery path: deduplicates retries, survives transient writes and records verified rollbacks", async () => {
    const baseStore = new InMemoryAuditReceiptStore();
    let insertCalls = 0;
    const flakyStore = {
      async insertIfAbsent(envelope) {
        insertCalls += 1;
        if (insertCalls === 1) {
          const err = new Error("transient store write");
          err.retryable = true;
          throw err;
        }
        return baseStore.insertIfAbsent(envelope);
      },
      list() {
        return baseStore.list();
      },
    };
    const chain = new AdminChangeReceiptChain({ signer, store: flakyStore });
    const first = await chain.recordChange(change);
    assert.equal(insertCalls, 2); // one transient failure, then committed

    const duplicate = await chain.recordChange({ ...change, reason: "client retried" });
    assert.equal(duplicate.deduplicatedRetry, true);
    assert.equal(duplicate.envelope.signature, first.envelope.signature);
    assert.equal(chain.listReceipts().length, 1);

    const rollback = await chain.rollback({
      targetReceiptId: first.envelope.payload.receiptId,
      actor: admin,
      reason: "Governance proposal withdrawn",
      beforeState: { feeBps: 75 },
      afterState: { feeBps: 50 },
    });
    assert.equal(rollback.envelope.payload.rollbackOfReceiptId, first.envelope.payload.receiptId);
    assert.equal(rollback.envelope.payload.prevReceiptHash, first.envelope.payloadDigest);
    assert.equal(chain.verifyChain().valid, true);

    // A rollback whose target was tampered with is refused before it is signed.
    const tamperedTarget = baseStore.receipts.get(first.envelope.payload.receiptId);
    tamperedTarget.payload.target = "pool:pool-999";
    await assert.rejects(
      () =>
        chain.rollback({
          targetReceiptId: first.envelope.payload.receiptId,
          actor: admin,
          beforeState: { feeBps: 75 },
          afterState: { feeBps: 50 },
        }),
      (err) =>
        err instanceof AuditReceiptValidationError &&
        err.code === AUDIT_RECEIPT_CHAIN_REASONS.TARGET_RECEIPT_INVALID,
    );
  });

  it("authorization path: only privileged issuers can record or roll back admin receipts", async () => {
    const chain = new AdminChangeReceiptChain({
      signer,
      store: new InMemoryAuditReceiptStore(),
    });
    const viewer = { id: "viewer-1", role: "user" };

    await assert.rejects(
      () => chain.recordChange({ ...change, actor: viewer }),
      (err) => err instanceof AuditReceiptAuthorizationError && err.statusCode === 403,
    );

    const auditor = { id: "auditor-1", role: "auditor", scopes: ["audit:issue"] };
    const issued = await chain.recordChange({ ...change, actor: auditor });
    assert.equal(issued.created, true);

    await assert.rejects(
      () => chain.rollback({ targetReceiptId: issued.envelope.payload.receiptId, actor: viewer }),
      (err) => err instanceof AuditReceiptAuthorizationError && err.statusCode === 403,
    );
  });
});
