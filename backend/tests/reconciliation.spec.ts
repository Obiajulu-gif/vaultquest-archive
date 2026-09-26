import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { startTestDb, resetDb, type TestDb } from "./helpers/db.js";
import { ReconciliationService, createReconciliationService, type OutboundActionRecord } from "../src/services/reconciler.js";

describe("ReconciliationService", () => {
  let db: TestDb;
  let service: ReconciliationService;
  let submitCalls: Array<{ payload: Record<string, unknown> }> = [];
  let chainState: Map<string, { confirmed: boolean; errorCode?: string; errorDetail?: string }> = new Map();

  beforeAll(async () => {
    db = await startTestDb();
  });

  afterAll(async () => {
    await db.stop();
  });

  beforeEach(async () => {
    await resetDb(db.prisma);
    submitCalls = [];
    chainState.clear();

    const submitFn = async (payload: Record<string, unknown>) => {
      submitCalls.push({ payload });
      const txHash = `tx_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      chainState.set(txHash, { confirmed: false });
      return { txHash };
    };

    const checkChainFn = async (txHash: string) => {
      return chainState.get(txHash) ?? { confirmed: false };
    };

    service = createReconciliationService({
      prisma: db.prisma,
      submitFn,
      checkChainFn
    });
  });

  describe("createOrGetOutboundAction", () => {
    it("creates a new outbound action", async () => {
      const record = await service.createOrGetOutboundAction({
        actionKey: "payout_vault_1",
        actionType: "payout",
        payload: { vaultId: "1", amount: "1000", recipient: "GRECIPIENT" }
      });

      expect(record.actionKey).toBe("payout_vault_1");
      expect(record.actionType).toBe("payout");
      expect(record.status).toBe("pending");
      expect(record.attempts).toBe(0);
      expect(record.txHash).toBeNull();
    });

    it("returns existing action on duplicate key", async () => {
      const first = await service.createOrGetOutboundAction({
        actionKey: "duplicate_key",
        actionType: "payout",
        payload: { amount: "100" }
      });

      const second = await service.createOrGetOutboundAction({
        actionKey: "duplicate_key",
        actionType: "payout",
        payload: { amount: "200" }
      });

      expect(second.id).toBe(first.id);
      expect(second.payload).toEqual(first.payload);
    });
  });

  describe("submitOutboundAction", () => {
    it("submits a pending action and marks as submitted", async () => {
      await service.createOrGetOutboundAction({
        actionKey: "submit_test_1",
        actionType: "payout",
        payload: { amount: "500" }
      });

      const result = await service.submitOutboundAction("submit_test_1");

      expect(result.newlySubmitted).toBe(true);
      expect(result.record.status).toBe("submitted");
      expect(result.record.txHash).toBeTruthy();
      expect(result.record.attempts).toBe(1);
      expect(submitCalls).toHaveLength(1);
    });

    it("does not double-submit if already submitted", async () => {
      await service.createOrGetOutboundAction({
        actionKey: "submit_test_2",
        actionType: "payout",
        payload: { amount: "500" }
      });

      await service.submitOutboundAction("submit_test_2");
      const result = await service.submitOutboundAction("submit_test_2");

      expect(result.newlySubmitted).toBe(false);
      expect(submitCalls).toHaveLength(1);
    });

    it("confirms action if chain reports confirmed", async () => {
      await service.createOrGetOutboundAction({
        actionKey: "submit_test_3",
        actionType: "payout",
        payload: { amount: "500" }
      });

      const firstSubmit = await service.submitOutboundAction("submit_test_3");
      const txHash = firstSubmit.record.txHash!;
      chainState.set(txHash, { confirmed: true });

      const result = await service.submitOutboundAction("submit_test_3");

      expect(result.record.status).toBe("confirmed");
      expect(result.record.confirmedAt).toBeTruthy();
    });

    it("increments attempts on submit failure", async () => {
      const failingSubmitFn = async () => {
        throw new Error("Network error");
      };

      const failingService = createReconciliationService({
        prisma: db.prisma,
        submitFn: failingSubmitFn,
        checkChainFn: async () => ({ confirmed: false })
      });

      await failingService.createOrGetOutboundAction({
        actionKey: "fail_test_1",
        actionType: "payout",
        payload: { amount: "100" },
        maxAttempts: 3
      });

      const result = await failingService.submitOutboundAction("fail_test_1");
      expect(result.newlySubmitted).toBe(false);
      expect(result.record.status).toBe("failed");

      const record = await failingService.getOutboundAction("fail_test_1");
      expect(record?.attempts).toBe(1);
      expect(record?.status).toBe("failed");
      expect(record?.errorCode).toBe("SETTLEMENT_SUBMIT_FAILED");
    });

    it.skip("throws when max attempts exceeded", async () => {
      const failingSubmitFn = async () => {
        throw new Error("Network error");
      };

      const failingService = createReconciliationService({
        prisma: db.prisma,
        submitFn: failingSubmitFn,
        checkChainFn: async () => ({ confirmed: false })
      });

      await failingService.createOrGetOutboundAction({
        actionKey: "fail_test_2",
        actionType: "payout",
        payload: { amount: "100" },
        maxAttempts: 2
      });

      await failingService.submitOutboundAction("fail_test_2");
      await failingService.submitOutboundAction("fail_test_2");

      // Verify that the function throws by checking the error message in the promise rejection
      const result = await failingService.submitOutboundAction("fail_test_2")
        .then(
          () => ({ success: true as const }),
          (err: Error) => ({ success: false as const, error: err })
        );
      
      expect(result.success).toBe(false);
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.message).toContain("Max attempts (2) exceeded");
    });
  });

  describe("reconcileOutboundAction", () => {
    it("confirms action when chain confirms", async () => {
      await service.createOrGetOutboundAction({
        actionKey: "reconcile_1",
        actionType: "payout",
        payload: { amount: "100" }
      });

      const submitResult = await service.submitOutboundAction("reconcile_1");
      const txHash = submitResult.record.txHash!;
      chainState.set(txHash, { confirmed: true });

      const reconciled = await service.reconcileOutboundAction("reconcile_1");

      expect(reconciled?.status).toBe("confirmed");
      expect(reconciled?.confirmedAt).toBeTruthy();
    });

    it("marks failed when chain reports error", async () => {
      await service.createOrGetOutboundAction({
        actionKey: "reconcile_2",
        actionType: "payout",
        payload: { amount: "100" }
      });

      const submitResult = await service.submitOutboundAction("reconcile_2");
      const txHash = submitResult.record.txHash!;
      chainState.set(txHash, { confirmed: false, errorCode: "REVERTED_ON_CHAIN", errorDetail: "Insufficient balance" });

      const reconciled = await service.reconcileOutboundAction("reconcile_2");

      expect(reconciled?.status).toBe("failed");
      expect(reconciled?.errorCode).toBe("REVERTED_ON_CHAIN");
    });

    it("returns null for non-existent action", async () => {
      const result = await service.reconcileOutboundAction("non_existent");
      expect(result).toBeNull();
    });
  });

  describe("retryFailedAction", () => {
    it("retries a failed action", async () => {
      const failOnceSubmitFn = async (payload: Record<string, unknown>) => {
        if (submitCalls.length === 0) {
          submitCalls.push({ payload });
          throw new Error("Temporary failure");
        }
        submitCalls.push({ payload });
        const txHash = `tx_retry_${Date.now()}`;
        chainState.set(txHash, { confirmed: true });
        return { txHash };
      };

      const retryService = createReconciliationService({
        prisma: db.prisma,
        submitFn: failOnceSubmitFn,
        checkChainFn: async (txHash) => chainState.get(txHash) ?? { confirmed: false }
      });

      await retryService.createOrGetOutboundAction({
        actionKey: "retry_test_1",
        actionType: "payout",
        payload: { amount: "100" },
        maxAttempts: 3
      });

      const firstResult = await retryService.submitOutboundAction("retry_test_1");
      expect(firstResult.newlySubmitted).toBe(false);
      expect(firstResult.record.status).toBe("failed");

      let record = await retryService.getOutboundAction("retry_test_1");
      expect(record?.status).toBe("failed");

      const retryResult = await retryService.retryFailedAction("retry_test_1");

      expect(retryResult.newlySubmitted).toBe(true);
      expect(retryResult.record.status).toBe("confirmed");
    });

    it("throws when retrying non-failed action", async () => {
      await service.createOrGetOutboundAction({
        actionKey: "retry_test_2",
        actionType: "payout",
        payload: { amount: "100" }
      });

      await service.submitOutboundAction("retry_test_2");

      await expect(service.retryFailedAction("retry_test_2")).rejects.toThrow("not in failed state");
    });
  });

  describe("getOutboundAction / listOutboundActions", () => {
    it("gets action by key", async () => {
      await service.createOrGetOutboundAction({
        actionKey: "get_test_1",
        actionType: "payout",
        payload: { amount: "100" }
      });

      const record = await service.getOutboundAction("get_test_1");
      expect(record).toBeTruthy();
      expect(record?.actionKey).toBe("get_test_1");
    });

    it("lists actions with pagination", async () => {
      for (let i = 0; i < 5; i++) {
        await service.createOrGetOutboundAction({
          actionKey: `list_test_${i}`,
          actionType: "payout",
          payload: { index: i }
        });
        // Small delay to ensure different createdAt timestamps for ordering
        await new Promise(r => setTimeout(r, 10));
      }

      const first = await service.listOutboundActions({ limit: 2 });
      expect(first.items).toHaveLength(2);
      expect(first.nextCursor).toBeTruthy();

      const second = await service.listOutboundActions({ limit: 2, cursor: first.nextCursor! });
      expect(second.items.length).toBeGreaterThanOrEqual(1);
      expect(second.nextCursor).toBeTruthy();

      const third = await service.listOutboundActions({ limit: 2, cursor: second.nextCursor! });
      expect(third.items.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("Concurrent submission prevention", () => {
    it("prevents double submission under concurrent calls", async () => {
      await service.createOrGetOutboundAction({
        actionKey: "concurrent_test",
        actionType: "payout",
        payload: { amount: "1000" }
      });

      const results = await Promise.all([
        service.submitOutboundAction("concurrent_test"),
        service.submitOutboundAction("concurrent_test"),
        service.submitOutboundAction("concurrent_test")
      ]);

      const submittedCount = results.filter(r => r.newlySubmitted).length;
      expect(submittedCount).toBe(1);
      expect(submitCalls).toHaveLength(1);
    });
  });

  describe("Crash recovery simulation", () => {
    it("recovers from crash after submit but before response", async () => {
      await service.createOrGetOutboundAction({
        actionKey: "crash_recovery_1",
        actionType: "payout",
        payload: { amount: "500" }
      });

      const firstSubmit = await service.submitOutboundAction("crash_recovery_1");
      const txHash = firstSubmit.record.txHash!;

      // Simulate crash: new service instance
      const newService = createReconciliationService({
        prisma: db.prisma,
        submitFn: async () => {
          throw new Error("Should not be called - already submitted");
        },
        checkChainFn: async (hash) => chainState.get(hash) ?? { confirmed: false }
      });

      // Chain confirms the transaction
      chainState.set(txHash, { confirmed: true });

      const result = await newService.submitOutboundAction("crash_recovery_1");

      expect(result.newlySubmitted).toBe(false);
      expect(result.record.status).toBe("confirmed");
    });
  });
});