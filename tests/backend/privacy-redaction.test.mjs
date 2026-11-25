import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PrivacyLeakDetectedError,
  PrivacyRedactionAuthorizationError,
  executeRedactedExport,
  redactStructuredPayload,
  verifyNoSecretLeaks,
} from "../../src/lib/privacy-redaction.mjs";

describe("privacy redaction tests for logs and exports (#1106)", () => {
  const VALID_SEED = "S" + "A".repeat(55);
  const operator = { id: "op-1", role: "operator" };
  const complianceAdmin = { id: "comp-1", role: "compliance_admin" };
  const guest = { id: "guest-1", role: "guest" };

  it("normal path: redacts secret keys, PII fields, and inline secrets in structured logs and exports", async () => {
    const rawEntry = {
      eventId: "evt-100",
      walletSeed: VALID_SEED,
      email: "alice@example.com",
      ssn: "123-45-6789",
      nested: {
        authToken: "jwt-secret-token",
        message: `Failed signing with seed ${VALID_SEED} for alice@example.com and Bearer eyJhbGciOiJIUzI1NiJ9.payload`,
      },
    };

    const redacted = redactStructuredPayload(rawEntry);
    assert.equal(redacted.eventId, "evt-100");
    assert.equal(redacted.walletSeed, "[REDACTED_SECRET]");
    assert.equal(redacted.email, "[REDACTED_PII]");
    assert.equal(redacted.ssn, "[REDACTED_PII]");
    assert.equal(redacted.nested.authToken, "[REDACTED_SECRET]");
    assert.ok(!redacted.nested.message.includes(VALID_SEED));
    assert.ok(!redacted.nested.message.includes("alice@example.com"));
    assert.ok(redacted.nested.message.includes("[REDACTED_STELLAR_SEED]"));
    assert.ok(redacted.nested.message.includes("Bearer [REDACTED_TOKEN]"));

    const exported = await executeRedactedExport({
      actor: operator,
      records: [rawEntry],
    });
    assert.equal(exported.committed, true);
    assert.equal(exported.recordCount, 1);
    assert.ok(!JSON.stringify(exported.records).includes(VALID_SEED));
  });

  it("failure & leak-guard path: handles circular references safely and fails closed when raw secrets leak", () => {
    const circular = { name: "node-a", apiKey: "secret-123" };
    circular.self = circular;

    const safe = redactStructuredPayload(circular);
    assert.equal(safe.apiKey, "[REDACTED_SECRET]");
    assert.equal(safe.self, "[CIRCULAR]");

    assert.throws(
      () => verifyNoSecretLeaks(`{"leaked":"${VALID_SEED}"}`),
      (err) => err instanceof PrivacyLeakDetectedError && err.code === "PRIVACY_LEAK_DETECTED"
    );
  });

  it("retry & rollback path: retries transient export sink failures and marks rollback on permanent failure", async () => {
    let sinkAttempts = 0;
    const res = await executeRedactedExport({
      actor: operator,
      records: [{ id: "rec-1", email: "bob@example.com" }],
      maxRetries: 2,
      sinkFn: async () => {
        sinkAttempts += 1;
        if (sinkAttempts === 1) {
          const err = new Error("transient storage write timeout");
          err.retryable = true;
          throw err;
        }
      },
    });

    assert.equal(res.committed, true);
    assert.equal(res.attemptsUsed, 2);

    await assert.rejects(
      () =>
        executeRedactedExport({
          actor: operator,
          records: [{ id: "rec-2" }],
          maxRetries: 1,
          sinkFn: async () => {
            throw new Error("permanent sink disconnect");
          },
        }),
      /permanent sink disconnect/
    );
  });

  it("authorization path: blocks unprivileged PII unmasking while redacting secrets for all roles", async () => {
    const record = {
      id: "rec-auth",
      email: "vip@example.com",
      privateKey: VALID_SEED,
    };

    await assert.rejects(
      () =>
        executeRedactedExport({
          actor: guest,
          records: [record],
        }),
      (err) => err instanceof PrivacyRedactionAuthorizationError && err.statusCode === 403
    );

    await assert.rejects(
      () =>
        executeRedactedExport({
          actor: operator,
          records: [record],
          unmaskPii: true,
        }),
      (err) => err instanceof PrivacyRedactionAuthorizationError && err.statusCode === 403
    );

    const complianceExport = await executeRedactedExport({
      actor: complianceAdmin,
      records: [record],
      unmaskPii: true,
    });
    assert.equal(complianceExport.records[0].email, "vip@example.com");
    // Secrets remain redacted even for compliance_admin
    assert.equal(complianceExport.records[0].privateKey, "[REDACTED_SECRET]");
  });
});
