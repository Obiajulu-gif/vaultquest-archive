import { describe, it, expect, beforeEach } from "vitest";
import {
  DuplicateSuppressionService,
  InMemoryDuplicateSuppressionStore,
} from "../src/services/duplicateSuppressionService.js";

describe("Duplicate Suppression Service (#993)", () => {
  let store: InMemoryDuplicateSuppressionStore;
  let simulatedTime: Date;
  let service: DuplicateSuppressionService;

  beforeEach(() => {
    store = new InMemoryDuplicateSuppressionStore();
    simulatedTime = new Date("2026-10-16T12:00:00Z");
    service = new DuplicateSuppressionService(store, () => simulatedTime);
  });

  describe("Notifications: Normal, Duplicate, and Sliding Window Paths", () => {
    it("allows the initial notification and suppresses duplicate alerts within the sliding window", async () => {
      const input = {
        recipient: "GBBD3A7FQ6HZN2XR5DBLD3YIYS3L2ORWVUYVY4QBEAC3IKWMUOCFLA5",
        type: "maturity_reminder",
        scope: "vault" as const,
        subject: "vault-usdc-01",
        payload: { roundId: "round-102", locksAt: "2026-10-17T00:00:00Z" },
        windowSeconds: 300,
      };

      // 1. Initial notification
      const first = await service.evaluateNotification(input);
      expect(first.suppressed).toBe(false);
      expect(first.reason).toBe("allowed");
      expect(first.occurrenceCount).toBe(1);

      // 2. Duplicate notification 30 seconds later
      simulatedTime = new Date(simulatedTime.getTime() + 30 * 1000);
      const duplicate = await service.evaluateNotification(input);
      expect(duplicate.suppressed).toBe(true);
      expect(duplicate.reason).toBe("duplicate_in_window");
      expect(duplicate.occurrenceCount).toBe(2);

      // 3. After sliding window expires (301 seconds later)
      simulatedTime = new Date(simulatedTime.getTime() + 301 * 1000);
      const afterWindow = await service.evaluateNotification(input);
      expect(afterWindow.suppressed).toBe(false);
      expect(afterWindow.reason).toBe("allowed");
      expect(afterWindow.occurrenceCount).toBe(1);
    });

    it("always allows critical severity notifications through, bypassing suppression", async () => {
      const input = {
        recipient: "GBBD3A7FQ6HZN2XR5DBLD3YIYS3L2ORWVUYVY4QBEAC3IKWMUOCFLA5",
        type: "circuit_breaker_paused",
        severity: "critical" as const,
        payload: { vaultId: "vault-usdc-01", reason: "Solvency invariant discrepancy" },
      };

      const first = await service.evaluateNotification(input);
      expect(first.suppressed).toBe(false);

      // Second critical alert within seconds is still allowed
      simulatedTime = new Date(simulatedTime.getTime() + 5 * 1000);
      const second = await service.evaluateNotification(input);
      expect(second.suppressed).toBe(false);
      expect(second.reason).toBe("critical_bypass");
    });
  });

  describe("Webhooks: Normal, Concurrent, and Content-Deduplication Paths", () => {
    const webhookInput = {
      provider: "stellar",
      eventId: "evt-soroban-9988",
      eventType: "pool_deposit",
      payload: {
        poolId: "vault-usdc-01",
        depositor: "GBBD3A7FQ6HZN2XR5DBLD3YIYS3L2ORWVUYVY4QBEAC3IKWMUOCFLA5",
        amount: "5000000000",
      },
      windowSeconds: 600,
    };

    it("claims an initial webhook and suppresses concurrent in-flight duplicates", async () => {
      // 1. Initial claim
      const claim1 = await service.evaluateWebhook(webhookInput);
      expect(claim1.allowed).toBe(true);
      expect(claim1.suppressed).toBe(false);
      expect(claim1.reason).toBe("new");

      // 2. Concurrent duplicate while still processing
      const claim2 = await service.evaluateWebhook(webhookInput);
      expect(claim2.allowed).toBe(false);
      expect(claim2.suppressed).toBe(true);
      expect(claim2.reason).toBe("concurrent_in_flight");

      // 3. Mark processed
      await service.markWebhookProcessed("stellar", "evt-soroban-9988", { status: "ok" });

      // 4. Repeated delivery after processing
      const claim3 = await service.evaluateWebhook(webhookInput);
      expect(claim3.allowed).toBe(false);
      expect(claim3.suppressed).toBe(true);
      expect(claim3.reason).toBe("already_processed");
    });

    it("suppresses webhooks with different eventIds but identical payload content hash", async () => {
      // Claim initial
      await service.evaluateWebhook(webhookInput);
      await service.markWebhookProcessed("stellar", "evt-soroban-9988", { success: true });

      // Retried webhook with a newly assigned synthetic eventId but identical content
      const duplicateDifferentId = {
        ...webhookInput,
        eventId: "evt-soroban-9988-retry-alt-id",
      };

      const result = await service.evaluateWebhook(duplicateDifferentId);
      expect(result.allowed).toBe(false);
      expect(result.suppressed).toBe(true);
      expect(result.reason).toBe("already_processed");
    });
  });

  describe("Failure Recovery & Retry Path", () => {
    it("permits retries after a previous delivery failure so transient errors can recover", async () => {
      const webhook = {
        provider: "stripe",
        eventId: "evt_charge_failed_123",
        eventType: "payment_intent.payment_failed",
        payload: { id: "pi_123", amount: 1000 },
      };

      // 1. Initial claim
      const initial = await service.evaluateWebhook(webhook);
      expect(initial.allowed).toBe(true);

      // 2. Processing fails due to temporary network error
      await service.markWebhookFailed("stripe", "evt_charge_failed_123", "Horizon RPC timeout");

      // 3. Provider retries delivery 10s later -> MUST NOT BE SUPPRESSED!
      simulatedTime = new Date(simulatedTime.getTime() + 10 * 1000);
      const retry = await service.evaluateWebhook(webhook);
      expect(retry.allowed).toBe(true);
      expect(retry.suppressed).toBe(false);
      expect(retry.reason).toBe("retry_allowed_after_failure");
    });
  });

  describe("Authorization Path: Emergency Force Dispatch", () => {
    it("allows maintainer to force dispatch with bypass", async () => {
      const input = {
        recipient: "GBBD3A7FQ6HZN2XR5DBLD3YIYS3L2ORWVUYVY4QBEAC3IKWMUOCFLA5",
        type: "governance_vote",
        forceDispatch: true,
        actorRole: "maintainer" as const,
      };

      const res = await service.evaluateNotification(input);
      expect(res.suppressed).toBe(false);
      expect(res.reason).toBe("force_bypass");
    });

    it("rejects unauthorized user attempts to force dispatch bypass", async () => {
      const input = {
        recipient: "GBBD3A7FQ6HZN2XR5DBLD3YIYS3L2ORWVUYVY4QBEAC3IKWMUOCFLA5",
        type: "governance_vote",
        forceDispatch: true,
        actorRole: "user" as const,
      };

      await expect(service.evaluateNotification(input)).rejects.toThrow(/Only maintainers or system services/i);
    });
  });

  describe("Pruning Expired Entries", () => {
    it("prunes expired notification and webhook entries from the sliding window", async () => {
      await service.evaluateNotification({
        recipient: "G1",
        type: "alert",
        windowSeconds: 60,
      });

      await service.evaluateWebhook({
        provider: "p1",
        eventId: "e1",
        eventType: "t1",
        payload: { a: 1 },
        windowSeconds: 60,
      });

      // Advance clock past expiration
      simulatedTime = new Date(simulatedTime.getTime() + 120 * 1000);
      const pruned = await service.pruneExpired();
      expect(pruned).toBeGreaterThanOrEqual(2);
    });
  });
});
