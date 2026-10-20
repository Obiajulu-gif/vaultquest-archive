import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  WebhookService,
  InMemoryWebhookEventStore,
  generateWebhookSignature,
  STELLAR_WEBHOOK_DOMAIN,
} from "../src/services/webhookService.js";
import { ERROR_CODES } from "../src/constants.js";
import { AppError } from "../src/errors.js";

// #799 — Signed webhook verification and replay-window enforcement unit tests

describe("WebhookService Unit Tests (#799)", () => {
  const FIXED_NOW = new Date("2026-10-01T12:00:00.000Z");
  const STRIPE_SECRET = "whsec_test_secret_1234567890abcdef";
  const INTERNAL_SECRET = "internal_webhook_secret_abcdef1234567890";
  const CUSTOM_SECRET = "custom_secret_key_987654321";
  const STELLAR_KEYPAIR = Keypair.random();

  function createService(overrides = {}) {
    const store = new InMemoryWebhookEventStore({ now: () => FIXED_NOW });
    const service = new WebhookService({
      store,
      secrets: {
        stripe: STRIPE_SECRET,
        internal: INTERNAL_SECRET,
        custom: CUSTOM_SECRET,
        stellarPublicKey: STELLAR_KEYPAIR.publicKey(),
      },
      defaultToleranceSeconds: 300,
      futureToleranceSeconds: 60,
      now: () => FIXED_NOW,
      ...overrides,
    });
    return { store, service };
  }

  describe("Stripe Webhook Verification", () => {
    it("successfully verifies a valid Stripe webhook", () => {
      const { service } = createService();
      const payload = {
        id: "evt_12345",
        type: "payment_intent.succeeded",
        data: { object: { amount: 5000, currency: "usd" } },
      };
      const nowSec = Math.floor(FIXED_NOW.getTime() / 1000);
      const signed = generateWebhookSignature({
        provider: "stripe",
        secret: STRIPE_SECRET,
        payload,
        timestamp: nowSec,
      });

      const verified = service.verifyAndParse({
        provider: "stripe",
        rawBody: signed.rawBody,
        headers: signed.headers,
      });

      expect(verified.provider).toBe("stripe");
      expect(verified.eventId).toBe("evt_12345");
      expect(verified.eventType).toBe("payment_intent.succeeded");
      expect(verified.payload.id).toBe("evt_12345");
      expect(verified.timestamp).toEqual(new Date(nowSec * 1000));
    });

    it("rejects when Stripe signature header is missing", () => {
      const { service } = createService();
      const rawBody = JSON.stringify({ id: "evt_123", type: "test" });

      expect(() =>
        service.verifyAndParse({
          provider: "stripe",
          rawBody,
          headers: {},
        })
      ).toThrowError(expect.objectContaining({ code: ERROR_CODES.WEBHOOK_SIGNATURE_MISSING }));
    });

    it("rejects when Stripe signature is invalid / tampered payload", () => {
      const { service } = createService();
      const payload = { id: "evt_123", type: "test" };
      const nowSec = Math.floor(FIXED_NOW.getTime() / 1000);
      const signed = generateWebhookSignature({
        provider: "stripe",
        secret: STRIPE_SECRET,
        payload,
        timestamp: nowSec,
      });

      const tamperedBody = JSON.stringify({ id: "evt_123", type: "test", tampered: true });

      expect(() =>
        service.verifyAndParse({
          provider: "stripe",
          rawBody: tamperedBody,
          headers: signed.headers,
        })
      ).toThrowError(expect.objectContaining({ code: ERROR_CODES.WEBHOOK_SIGNATURE_INVALID }));
    });

    it("rejects when Stripe secret does not match", () => {
      const { service } = createService();
      const payload = { id: "evt_123", type: "test" };
      const nowSec = Math.floor(FIXED_NOW.getTime() / 1000);
      const signed = generateWebhookSignature({
        provider: "stripe",
        secret: "wrong_secret_key_123456",
        payload,
        timestamp: nowSec,
      });

      expect(() =>
        service.verifyAndParse({
          provider: "stripe",
          rawBody: signed.rawBody,
          headers: signed.headers,
        })
      ).toThrowError(expect.objectContaining({ code: ERROR_CODES.WEBHOOK_SIGNATURE_INVALID }));
    });

    it("rejects stale events older than tolerance window (replay window enforcement)", () => {
      const { service } = createService({ defaultToleranceSeconds: 300 });
      const payload = { id: "evt_stale", type: "test" };
      const staleTimestamp = Math.floor(FIXED_NOW.getTime() / 1000) - 301; // 301 seconds ago (over 300s window)
      const signed = generateWebhookSignature({
        provider: "stripe",
        secret: STRIPE_SECRET,
        payload,
        timestamp: staleTimestamp,
      });

      expect(() =>
        service.verifyAndParse({
          provider: "stripe",
          rawBody: signed.rawBody,
          headers: signed.headers,
        })
      ).toThrowError(expect.objectContaining({ code: ERROR_CODES.WEBHOOK_TIMESTAMP_STALE }));
    });

    it("rejects future events beyond clock skew tolerance", () => {
      const { service } = createService({ futureToleranceSeconds: 60 });
      const payload = { id: "evt_future", type: "test" };
      const futureTimestamp = Math.floor(FIXED_NOW.getTime() / 1000) + 120; // 2 minutes in the future
      const signed = generateWebhookSignature({
        provider: "stripe",
        secret: STRIPE_SECRET,
        payload,
        timestamp: futureTimestamp,
      });

      expect(() =>
        service.verifyAndParse({
          provider: "stripe",
          rawBody: signed.rawBody,
          headers: signed.headers,
        })
      ).toThrowError(expect.objectContaining({ code: ERROR_CODES.WEBHOOK_TIMESTAMP_STALE }));
    });
  });

  describe("Internal / VaultQuest Webhook Verification", () => {
    it("successfully verifies internal HMAC signature", () => {
      const { service } = createService();
      const payload = {
        id: "evt_internal_1",
        event: "vault.deposit_confirmed",
        data: { vault_id: "vault_abc", amount: "1000000" },
      };
      const nowMs = FIXED_NOW.getTime();
      const signed = generateWebhookSignature({
        provider: "internal",
        secret: INTERNAL_SECRET,
        payload,
        timestamp: nowMs,
      });

      const verified = service.verifyAndParse({
        provider: "internal",
        rawBody: signed.rawBody,
        headers: signed.headers,
      });

      expect(verified.provider).toBe("internal");
      expect(verified.eventId).toBe("evt_internal_1");
      expect(verified.eventType).toBe("vault.deposit_confirmed");
    });

    it("rejects missing signature header", () => {
      const { service } = createService();
      const rawBody = JSON.stringify({ id: "evt_1", event: "vault.deposit_confirmed" });

      expect(() =>
        service.verifyAndParse({
          provider: "internal",
          rawBody,
          headers: { "x-webhook-timestamp": String(FIXED_NOW.getTime()) },
        })
      ).toThrowError(expect.objectContaining({ code: ERROR_CODES.WEBHOOK_SIGNATURE_MISSING }));
    });

    it("rejects missing timestamp header", () => {
      const { service } = createService();
      const rawBody = JSON.stringify({ id: "evt_1", event: "vault.deposit_confirmed" });

      expect(() =>
        service.verifyAndParse({
          provider: "internal",
          rawBody,
          headers: { "x-webhook-signature": "some_sig" },
        })
      ).toThrowError(expect.objectContaining({ code: ERROR_CODES.WEBHOOK_TIMESTAMP_MISSING }));
    });

    it("rejects invalid signature", () => {
      const { service } = createService();
      const payload = { id: "evt_1", event: "vault.deposit_confirmed" };
      const signed = generateWebhookSignature({
        provider: "internal",
        secret: INTERNAL_SECRET,
        payload,
        timestamp: FIXED_NOW.getTime(),
      });

      expect(() =>
        service.verifyAndParse({
          provider: "internal",
          rawBody: signed.rawBody,
          headers: { ...signed.headers, "x-webhook-signature": "invalid_signature_hex" },
        })
      ).toThrowError(expect.objectContaining({ code: ERROR_CODES.WEBHOOK_SIGNATURE_INVALID }));
    });

    it("rejects stale internal webhook", () => {
      const { service } = createService({ defaultToleranceSeconds: 300 });
      const payload = { id: "evt_1", event: "vault.deposit_confirmed" };
      const staleTime = FIXED_NOW.getTime() - 400 * 1000;
      const signed = generateWebhookSignature({
        provider: "internal",
        secret: INTERNAL_SECRET,
        payload,
        timestamp: staleTime,
      });

      expect(() =>
        service.verifyAndParse({
          provider: "internal",
          rawBody: signed.rawBody,
          headers: signed.headers,
        })
      ).toThrowError(expect.objectContaining({ code: ERROR_CODES.WEBHOOK_TIMESTAMP_STALE }));
    });
  });

  describe("Stellar Ed25519 Webhook Verification", () => {
    it("successfully verifies Stellar Ed25519 signed callback", () => {
      const { service } = createService();
      const payload = {
        id: "evt_stellar_draw_1",
        event: "prize_draw.completed",
        pool_id: "pool_stellar_1",
        winner: "GDGQDAV4Q3...",
      };
      const nowSec = Math.floor(FIXED_NOW.getTime() / 1000);
      const signed = generateWebhookSignature({
        provider: "stellar",
        keypair: STELLAR_KEYPAIR,
        payload,
        timestamp: nowSec,
      });

      const verified = service.verifyAndParse({
        provider: "stellar",
        rawBody: signed.rawBody,
        headers: signed.headers,
      });

      expect(verified.provider).toBe("stellar");
      expect(verified.eventId).toBe("evt_stellar_draw_1");
      expect(verified.eventType).toBe("prize_draw.completed");
    });

    it("rejects when signature does not match public key", () => {
      const { service } = createService();
      const payload = { id: "evt_1", event: "prize_draw.completed" };
      const wrongKeypair = Keypair.random();
      const signed = generateWebhookSignature({
        provider: "stellar",
        keypair: wrongKeypair,
        payload,
        timestamp: Math.floor(FIXED_NOW.getTime() / 1000),
      });

      // Pass configured public key of STELLAR_KEYPAIR instead of wrongKeypair
      expect(() =>
        service.verifyAndParse({
          provider: "stellar",
          rawBody: signed.rawBody,
          headers: { ...signed.headers, "x-public-key": STELLAR_KEYPAIR.publicKey() },
        })
      ).toThrowError(expect.objectContaining({ code: ERROR_CODES.WEBHOOK_SIGNATURE_INVALID }));
    });
  });

  describe("Custom HMAC Webhook Verification", () => {
    it("verifies a valid custom HMAC-SHA256 webhook", () => {
      const { service } = createService();
      const payload = { id: "custom_evt_1", type: "partner.alert", data: { foo: "bar" } };
      const nowSec = Math.floor(FIXED_NOW.getTime() / 1000);
      const signed = generateWebhookSignature({
        provider: "custom",
        secret: CUSTOM_SECRET,
        payload,
        timestamp: nowSec,
      });

      const verified = service.verifyAndParse({
        provider: "custom",
        rawBody: signed.rawBody,
        headers: signed.headers,
      });

      expect(verified.provider).toBe("custom");
      expect(verified.eventId).toBe("custom_evt_1");
      expect(verified.eventType).toBe("partner.alert");
    });
  });

  describe("Malformed Payloads and Unsupported Providers", () => {
    it("rejects invalid JSON payload", () => {
      const { service } = createService();
      expect(() =>
        service.verifyAndParse({
          provider: "internal",
          rawBody: "{ not valid json",
          headers: {
            "x-webhook-signature": "sig",
            "x-webhook-timestamp": String(FIXED_NOW.getTime()),
          },
        })
      ).toThrowError(expect.objectContaining({ code: ERROR_CODES.WEBHOOK_EVENT_MALFORMED }));
    });

    it("rejects unsupported provider", () => {
      const { service } = createService();
      expect(() =>
        service.verifyAndParse({
          provider: "unsupported_provider" as any,
          rawBody: "{}",
          headers: {},
        })
      ).toThrowError(expect.objectContaining({ code: ERROR_CODES.WEBHOOK_PROVIDER_UNSUPPORTED }));
    });
  });

  describe("Event Deduplication & Replay Prevention (processEvent)", () => {
    it("executes handler once for a new event and records it as processed", async () => {
      const { service, store } = createService();
      const payload = { id: "evt_unique_1", event: "vault.deposit_confirmed" };
      const signed = generateWebhookSignature({
        provider: "internal",
        secret: INTERNAL_SECRET,
        payload,
        timestamp: FIXED_NOW.getTime(),
      });

      const verified = service.verifyAndParse({
        provider: "internal",
        rawBody: signed.rawBody,
        headers: signed.headers,
      });

      let executionCount = 0;
      const result = await service.processEvent(verified, async (evt) => {
        executionCount++;
        return { deposited: true, amount: 100 };
      });

      expect(result.duplicate).toBe(false);
      expect(result.wasDuplicate).toBe(false);
      expect(result.data).toEqual({ deposited: true, amount: 100 });
      expect(executionCount).toBe(1);

      const stored = await store.findEvent("internal", "evt_unique_1");
      expect(stored).not.toBeNull();
      expect(stored?.status).toBe("processed");
      expect(stored?.response).toEqual({ deposited: true, amount: 100 });
    });

    it("does NOT repeat side-effects on duplicate delivery of a valid event", async () => {
      const { service } = createService();
      const payload = { id: "evt_dedup_test", event: "vault.deposit_confirmed" };
      const signed = generateWebhookSignature({
        provider: "internal",
        secret: INTERNAL_SECRET,
        payload,
        timestamp: FIXED_NOW.getTime(),
      });

      const verified = service.verifyAndParse({
        provider: "internal",
        rawBody: signed.rawBody,
        headers: signed.headers,
      });

      let sideEffectCount = 0;
      const handler = async () => {
        sideEffectCount++;
        return { actionTaken: true, sideEffectCount };
      };

      // First delivery
      const firstResult = await service.processEvent(verified, handler);
      expect(firstResult.duplicate).toBe(false);
      expect(sideEffectCount).toBe(1);

      // Second delivery with identical event ID
      const secondResult = await service.processEvent(verified, handler);
      expect(secondResult.duplicate).toBe(true);
      expect(secondResult.wasDuplicate).toBe(true);
      expect(secondResult.data).toEqual({ actionTaken: true, sideEffectCount: 1 }); // Cached response
      expect(sideEffectCount).toBe(1); // Side effect was NOT repeated!

      // Third delivery
      const thirdResult = await service.processEvent(verified, handler);
      expect(thirdResult.duplicate).toBe(true);
      expect(sideEffectCount).toBe(1);
    });

    it("marks event failed if handler throws and allows retry", async () => {
      const { service, store } = createService();
      const payload = { id: "evt_fail_retry", event: "vault.deposit_confirmed" };
      const signed = generateWebhookSignature({
        provider: "internal",
        secret: INTERNAL_SECRET,
        payload,
        timestamp: FIXED_NOW.getTime(),
      });

      const verified = service.verifyAndParse({
        provider: "internal",
        rawBody: signed.rawBody,
        headers: signed.headers,
      });

      // First delivery throws error
      await expect(
        service.processEvent(verified, async () => {
          throw new Error("Temporary network glitch");
        })
      ).rejects.toThrow("Temporary network glitch");

      const stored = await store.findEvent("internal", "evt_fail_retry");
      expect(stored?.status).toBe("failed");
      expect(stored?.error).toBe("Temporary network glitch");

      // Retry delivery succeeds
      const retryResult = await service.processEvent(verified, async () => {
        return { recovered: true };
      });

      expect(retryResult.duplicate).toBe(false);
      expect(retryResult.data).toEqual({ recovered: true });

      const updatedStored = await store.findEvent("internal", "evt_fail_retry");
      expect(updatedStored?.status).toBe("processed");
    });
  });

  describe("Expired event cleanup", () => {
    it("cleans up expired webhook events", async () => {
      const store = new InMemoryWebhookEventStore({ now: () => FIXED_NOW });
      const service = new WebhookService({ store, eventTtlSeconds: 10, now: () => FIXED_NOW });

      await store.claimEvent({
        provider: "stripe",
        eventId: "evt_old",
        eventType: "payment.succeeded",
        payloadHash: "hash1",
        status: "processed",
        response: null,
        error: null,
        processedAt: new Date(FIXED_NOW.getTime() - 20000),
        expiresAt: new Date(FIXED_NOW.getTime() - 1000), // Expired
      });

      await store.claimEvent({
        provider: "stripe",
        eventId: "evt_fresh",
        eventType: "payment.succeeded",
        payloadHash: "hash2",
        status: "processed",
        response: null,
        error: null,
        processedAt: FIXED_NOW,
        expiresAt: new Date(FIXED_NOW.getTime() + 100000), // Active
      });

      const deleted = await service.cleanupExpiredEvents();
      expect(deleted).toBe(1);

      expect(await store.findEvent("stripe", "evt_old")).toBeNull();
      expect(await store.findEvent("stripe", "evt_fresh")).not.toBeNull();
    });
  });
});
