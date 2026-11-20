import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AuditReceiptAuthorizationError,
  AuditReceiptValidationError,
  InMemoryAuditReceiptStore,
  createEd25519Signer,
  issuePrivilegedAuditReceipt,
  verifyAuditReceipt,
} from "../../src/lib/signed-audit-receipts.mjs";

describe("signed audit receipts for privileged actions (#1065)", () => {
  const signer = createEd25519Signer();
  const admin = { id: "admin-1", role: "admin" };
  const secOfficer = { id: "sec-1", role: "security_officer" };
  const regularUser = { id: "user-1", role: "user" };

  const sampleAction = {
    id: "act-priv-100",
    idempotencyKey: "idem-priv-100",
    actorId: "admin-1",
    actorRole: "admin",
    operation: "role_grant",
    target: "user:42",
    params: { role: "operator", reason: "oncall_rotation" },
    status: "confirmed",
    createdAt: "2026-11-19T10:00:00.000Z",
    updatedAt: "2026-11-19T10:00:02.000Z",
    correlationId: "corr-100",
  };

  it("normal path: issues Ed25519 signed audit receipt and verifies payload + signature", async () => {
    const store = new InMemoryAuditReceiptStore();
    const res = await issuePrivilegedAuditReceipt({
      actor: admin,
      action: sampleAction,
      signer,
      store,
    });

    assert.equal(res.created, true);
    assert.equal(res.envelope.algorithm, "ed25519");
    assert.equal(res.envelope.keyId, signer.keyId);
    assert.equal(res.envelope.payload.stage, "confirmed");
    assert.equal("params" in res.envelope.payload, false); // raw params not leaked; committed via requestDigest

    const check = verifyAuditReceipt(res.envelope, signer.publicKeyPem);
    assert.equal(check.valid, true);
    assert.equal(check.receiptId, res.envelope.payload.receiptId);
  });

  it("failure path: detects tampered payload, wrong public key, and invalid operation", async () => {
    const store = new InMemoryAuditReceiptStore();
    const { envelope } = await issuePrivilegedAuditReceipt({
      actor: secOfficer,
      action: sampleAction,
      signer,
      store,
    });

    const tampered = structuredClone(envelope);
    tampered.payload.target = "user:999";
    const tamperedCheck = verifyAuditReceipt(tampered, signer.publicKeyPem);
    assert.equal(tamperedCheck.valid, false);
    assert.equal(tamperedCheck.reason, "PAYLOAD_DIGEST_MISMATCH");

    const otherSigner = createEd25519Signer();
    const wrongKeyCheck = verifyAuditReceipt(envelope, otherSigner.publicKeyPem);
    assert.equal(wrongKeyCheck.valid, false);
    assert.equal(wrongKeyCheck.reason, "INVALID_SIGNATURE");

    await assert.rejects(
      () =>
        issuePrivilegedAuditReceipt({
          actor: admin,
          action: { ...sampleAction, operation: "unknown_op" },
          signer,
          store,
        }),
      (err) => err instanceof AuditReceiptValidationError && err.code === "UNSUPPORTED_PRIVILEGED_OPERATION",
    );
  });

  it("retry path: idempotent duplicate returns identical receipt and retries transient store errors", async () => {
    const store = new InMemoryAuditReceiptStore();
    const first = await issuePrivilegedAuditReceipt({
      actor: admin,
      action: sampleAction,
      signer,
      store,
    });
    const duplicate = await issuePrivilegedAuditReceipt({
      actor: admin,
      action: sampleAction,
      signer,
      store,
    });

    assert.equal(duplicate.created, false);
    assert.equal(duplicate.envelope.signature, first.envelope.signature);
    assert.equal(duplicate.envelope.payload.receiptId, first.envelope.payload.receiptId);

    let calls = 0;
    const flakyStore = {
      async insertIfAbsent(env) {
        calls += 1;
        if (calls === 1) {
          const err = new Error("transient write error");
          err.retryable = true;
          throw err;
        }
        return store.insertIfAbsent(env);
      },
    };

    const retried = await issuePrivilegedAuditReceipt({
      actor: admin,
      action: { ...sampleAction, id: "act-priv-101", idempotencyKey: "idem-priv-101" },
      signer,
      store: flakyStore,
      maxRetries: 2,
    });
    assert.equal(calls, 2);
    assert.equal(retried.created, true);
  });

  it("authorization path: rejects unprivileged actors from issuing audit receipts", async () => {
    await assert.rejects(
      () =>
        issuePrivilegedAuditReceipt({
          actor: regularUser,
          action: sampleAction,
          signer,
        }),
      (err) => err instanceof AuditReceiptAuthorizationError && err.statusCode === 403,
    );
  });
});
