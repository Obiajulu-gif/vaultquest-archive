import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { buildApp } from "../src/app.js";
import {
  generateWebhookSignature,
  InMemoryWebhookEventStore,
  WebhookService,
} from "../src/services/webhookService.js";
import { ERROR_CODES } from "../src/constants.js";

// #799 — HTTP Integration Tests for Webhooks Verification & Replay Enforcement

describe("Webhooks HTTP Integration Tests (#799)", () => {
  const FIXED_NOW = new Date("2026-10-01T12:00:00.000Z");
  const STRIPE_SECRET = "whsec_test_secret_for_http_integration_12345";
  const INTERNAL_SECRET = "internal_service_secret_min_20_chars_long_12345";
  const CUSTOM_SECRET = "custom_partner_secret_12345";
  const STELLAR_KEYPAIR = Keypair.random();

  function createTestApp(opts: { hooks?: any; store?: any } = {}) {
    const store = opts.store ?? new InMemoryWebhookEventStore({ now: () => FIXED_NOW });
    const webhookService = new WebhookService({
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
    });

    const app = buildApp({
      prisma: {} as any,
      internalSecret: INTERNAL_SECRET,
      webhookService,
      webhookEventStore: store,
      webhookSecret: INTERNAL_SECRET,
      stripeWebhookSecret: STRIPE_SECRET,
      stellarWebhookPublicKey: STELLAR_KEYPAIR.publicKey(),
      webhookToleranceSeconds: 300,
      webhookHooks: opts.hooks,
    });

    return { app, store, webhookService };
  }

  describe("POST /webhooks/stripe", () => {
    it("accepts and processes a valid Stripe payment_intent.succeeded webhook", async () => {
      let paymentHookCalled = false;
      const { app } = createTestApp({
        hooks: {
          onPaymentSucceeded: async (event: any) => {
            paymentHookCalled = true;
            return { credited: true, amount: event.payload.data.object.amount };
          },
        },
      });

      const payload = {
        id: "evt_stripe_payment_1",
        type: "payment_intent.succeeded",
        data: {
          object: {
            id: "pi_123456",
            amount: 10000,
            currency: "usd",
            status: "succeeded",
          },
        },
      };

      const nowSec = Math.floor(FIXED_NOW.getTime() / 1000);
      const signed = generateWebhookSignature({
        provider: "stripe",
        secret: STRIPE_SECRET,
        payload,
        timestamp: nowSec,
      });

      const res = await app.inject({
        method: "POST",
        url: "/webhooks/stripe",
        headers: signed.headers,
        payload: signed.rawBody,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data).toMatchObject({
        status: "processed",
        duplicate: false,
        event_id: "evt_stripe_payment_1",
        event_type: "payment_intent.succeeded",
        result: { credited: true, amount: 10000 },
      });
      expect(paymentHookCalled).toBe(true);
    });

    it("rejects invalid Stripe signature with standardized error taxonomy schema", async () => {
      const { app } = createTestApp();
      const payload = { id: "evt_1", type: "payment_intent.succeeded" };
      const nowSec = Math.floor(FIXED_NOW.getTime() / 1000);
      const signed = generateWebhookSignature({
        provider: "stripe",
        secret: "wrong_secret",
        payload,
        timestamp: nowSec,
      });

      const res = await app.inject({
        method: "POST",
        url: "/webhooks/stripe",
        headers: signed.headers,
        payload: signed.rawBody,
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toMatchObject({
        code: ERROR_CODES.WEBHOOK_SIGNATURE_INVALID,
        category: "authorization",
        status_code: 400,
        retryable: false,
      });
      expect(body.error.error_id).toBeDefined();
      expect(body.error.message).toContain("signature");
    });

    it("rejects missing Stripe signature header", async () => {
      const { app } = createTestApp();
      const res = await app.inject({
        method: "POST",
        url: "/webhooks/stripe",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ id: "evt_1", type: "test" }),
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error.code).toBe(ERROR_CODES.WEBHOOK_SIGNATURE_MISSING);
    });

    it("rejects stale event timestamp outside the 300s window", async () => {
      const { app } = createTestApp();
      const payload = { id: "evt_stale_1", type: "payment_intent.succeeded" };
      const staleTimestamp = Math.floor(FIXED_NOW.getTime() / 1000) - 3600; // 1 hour ago
      const signed = generateWebhookSignature({
        provider: "stripe",
        secret: STRIPE_SECRET,
        payload,
        timestamp: staleTimestamp,
      });

      const res = await app.inject({
        method: "POST",
        url: "/webhooks/stripe",
        headers: signed.headers,
        payload: signed.rawBody,
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toMatchObject({
        code: ERROR_CODES.WEBHOOK_TIMESTAMP_STALE,
        category: "validation",
        status_code: 400,
        retryable: false,
      });
      expect(body.error.message).toContain("stale");
    });

    it("enforces deduplication: duplicate delivery returns 200 OK without repeating side-effects", async () => {
      let sideEffectInvocations = 0;
      const { app } = createTestApp({
        hooks: {
          onPaymentSucceeded: async () => {
            sideEffectInvocations++;
            return { processedTime: FIXED_NOW.toISOString(), sideEffectInvocations };
          },
        },
      });

      const payload = { id: "evt_dedup_http_1", type: "payment_intent.succeeded" };
      const nowSec = Math.floor(FIXED_NOW.getTime() / 1000);
      const signed = generateWebhookSignature({
        provider: "stripe",
        secret: STRIPE_SECRET,
        payload,
        timestamp: nowSec,
      });

      // 1st delivery
      const res1 = await app.inject({
        method: "POST",
        url: "/webhooks/stripe",
        headers: signed.headers,
        payload: signed.rawBody,
      });
      expect(res1.statusCode).toBe(200);
      expect(res1.json().data.duplicate).toBe(false);
      expect(sideEffectInvocations).toBe(1);

      // 2nd delivery (duplicate webhook retry from Stripe)
      const res2 = await app.inject({
        method: "POST",
        url: "/webhooks/stripe",
        headers: signed.headers,
        payload: signed.rawBody,
      });
      expect(res2.statusCode).toBe(200);
      expect(res2.json().data.duplicate).toBe(true);
      expect(res2.json().data.result).toEqual({
        processedTime: FIXED_NOW.toISOString(),
        sideEffectInvocations: 1,
      });
      // Side effect hook was NOT executed a second time!
      expect(sideEffectInvocations).toBe(1);
    });
  });

  describe("POST /webhooks/internal & /webhooks/vault", () => {
    it("handles internal vault deposit confirmation and executes vault hook", async () => {
      let depositVaultId: string | null = null;
      const { app } = createTestApp({
        hooks: {
          onVaultDeposit: async (evt: any) => {
            depositVaultId = evt.payload.data.vault_id;
            return { recorded: true, vaultId: depositVaultId };
          },
        },
      });

      const payload = {
        id: "evt_vault_deposit_101",
        event: "vault.deposit_confirmed",
        data: {
          vault_id: "vault_growth_pool_01",
          wallet_address: "GBJ5G3...TEST",
          amount: "500.00",
        },
      };

      const signed = generateWebhookSignature({
        provider: "internal",
        secret: INTERNAL_SECRET,
        payload,
        timestamp: FIXED_NOW.getTime(),
      });

      const res = await app.inject({
        method: "POST",
        url: "/webhooks/internal",
        headers: signed.headers,
        payload: signed.rawBody,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().data).toMatchObject({
        status: "processed",
        event_id: "evt_vault_deposit_101",
        event_type: "vault.deposit_confirmed",
        result: { recorded: true, vaultId: "vault_growth_pool_01" },
      });
      expect(depositVaultId).toBe("vault_growth_pool_01");
    });

    it("rejects malformed non-JSON payload with WEBHOOK_EVENT_MALFORMED", async () => {
      const { app } = createTestApp();
      const res = await app.inject({
        method: "POST",
        url: "/webhooks/internal",
        headers: {
          "x-webhook-signature": "abcdef123456",
          "x-webhook-timestamp": String(FIXED_NOW.getTime()),
          "content-type": "application/json",
        },
        payload: "not json at all",
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe(ERROR_CODES.WEBHOOK_EVENT_MALFORMED);
    });
  });

  describe("POST /webhooks/stellar & /webhooks/draw-oracle", () => {
    it("verifies Ed25519 signature on prize draw callback and runs prize draw hook", async () => {
      let drawCompletedPool: string | null = null;
      const { app } = createTestApp({
        hooks: {
          onPrizeDraw: async (evt: any) => {
            drawCompletedPool = evt.payload.pool_id;
            return { drawVerified: true, round: evt.payload.round_id };
          },
        },
      });

      const payload = {
        id: "evt_draw_completed_999",
        event: "prize_draw.completed",
        pool_id: "pool_weekly_usdc",
        round_id: 42,
        winner_wallet: "GCX...WINNER",
        prize_amount: "1500.00",
      };

      const signed = generateWebhookSignature({
        provider: "stellar",
        keypair: STELLAR_KEYPAIR,
        payload,
        timestamp: Math.floor(FIXED_NOW.getTime() / 1000),
      });

      const res = await app.inject({
        method: "POST",
        url: "/webhooks/stellar",
        headers: signed.headers,
        payload: signed.rawBody,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().data).toMatchObject({
        status: "processed",
        event_id: "evt_draw_completed_999",
        event_type: "prize_draw.completed",
        result: { drawVerified: true, round: 42 },
      });
      expect(drawCompletedPool).toBe("pool_weekly_usdc");
    });
  });

  describe("Dry Run Validation (?dry_run=true)", () => {
    it("validates cryptographic signature without executing side effects or persisting event", async () => {
      let sideEffectExecuted = false;
      const { app, store } = createTestApp({
        hooks: {
          onPaymentSucceeded: async () => {
            sideEffectExecuted = true;
            return { done: true };
          },
        },
      });

      const payload = { id: "evt_dry_run_test", type: "payment_intent.succeeded" };
      const signed = generateWebhookSignature({
        provider: "stripe",
        secret: STRIPE_SECRET,
        payload,
        timestamp: Math.floor(FIXED_NOW.getTime() / 1000),
      });

      const res = await app.inject({
        method: "POST",
        url: "/webhooks/stripe?dry_run=true",
        headers: signed.headers,
        payload: signed.rawBody,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().data).toMatchObject({
        status: "verified",
        dry_run: true,
        provider: "stripe",
        event_id: "evt_dry_run_test",
        event_type: "payment_intent.succeeded",
      });

      // Side effect was not called
      expect(sideEffectExecuted).toBe(false);
      // Event was not saved in store
      expect(await store.findEvent("stripe", "evt_dry_run_test")).toBeNull();
    });
  });

  describe("Unsupported provider", () => {
    it("returns 400 WEBHOOK_PROVIDER_UNSUPPORTED for unknown provider route param", async () => {
      const { app } = createTestApp();
      const res = await app.inject({
        method: "POST",
        url: "/webhooks/unsupported_gateway",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ id: "evt_1" }),
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe(ERROR_CODES.WEBHOOK_PROVIDER_UNSUPPORTED);
    });
  });
});
