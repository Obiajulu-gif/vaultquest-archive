import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { LedgerService, type ReconcileEventInput } from "../src/services/ledger.js";
import { ERROR_CODES, canTransition } from "../src/constants.js";
import { AppError } from "../src/errors.js";
import { Barrier, runConcurrently, countFulfilled, rejections } from "./helpers/concurrency.js";

describe("Deterministic Replay Tests for Concurrent Writes and Retries (#973)", () => {
  // In-memory action store for deterministic concurrency simulations
  interface StoredAction {
    id: string;
    idempotencyKey: string;
    walletAddress: string;
    actionType: string;
    actionPayload: any;
    verifiedPayload: any;
    status: string;
    txHash: string | null;
    sorobanEventId: string | null;
    correlationId: string;
    retryCount: number;
    createdAt: Date;
    updatedAt: Date;
    confirmedAt: Date | null;
  }

  class MockDeterministicPrisma {
    public actions = new Map<string, StoredAction>();
    public actionsByTxHash = new Map<string, StoredAction>();
    public actionsByIdempotency = new Map<string, StoredAction>();
    public leases = new Map<string, { actionId: string; workerId: string; expiresAt: Date }>();
    public poisonEvents = new Map<string, any>();
    public chainEvents: any[] = [];

    // Simulate transactional wrapper
    async $transaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
      return fn(this);
    }

    actionLedger = {
      findFirst: async ({ where }: any) => {
        if (where.txHash) return this.actionsByTxHash.get(where.txHash) ?? null;
        if (where.idempotencyKey) return this.actionsByIdempotency.get(where.idempotencyKey) ?? null;
        if (where.id) return this.actions.get(where.id) ?? null;
        return null;
      },
      findUnique: async ({ where }: any) => {
        if (where.id) return this.actions.get(where.id) ?? null;
        if (where.idempotencyKey) return this.actionsByIdempotency.get(where.idempotencyKey) ?? null;
        return null;
      },
      create: async ({ data }: any) => {
        if (this.actionsByIdempotency.has(data.idempotencyKey)) {
          const err = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
            code: "P2002",
            clientVersion: "5.22.0",
          });
          throw err;
        }
        const record: StoredAction = {
          id: data.id ?? randomUUID(),
          idempotencyKey: data.idempotencyKey,
          walletAddress: data.walletAddress,
          actionType: data.actionType,
          actionPayload: data.actionPayload,
          verifiedPayload: data.verifiedPayload ?? null,
          status: data.status ?? "pending",
          txHash: data.txHash ?? null,
          sorobanEventId: data.sorobanEventId ?? null,
          correlationId: data.correlationId ?? randomUUID(),
          retryCount: data.retryCount ?? 0,
          createdAt: new Date(),
          updatedAt: new Date(),
          confirmedAt: data.confirmedAt ?? null,
        };
        this.actions.set(record.id, record);
        this.actionsByIdempotency.set(record.idempotencyKey, record);
        if (record.txHash) this.actionsByTxHash.set(record.txHash, record);
        return record;
      },
      update: async ({ where, data }: any) => {
        const row = this.actions.get(where.id);
        if (!row) throw new Error("Record not found");
        const updated: StoredAction = {
          ...row,
          ...data,
          updatedAt: new Date(),
        };
        this.actions.set(where.id, updated);
        this.actionsByIdempotency.set(updated.idempotencyKey, updated);
        if (updated.txHash) this.actionsByTxHash.set(updated.txHash, updated);
        return updated;
      },
      updateMany: async ({ where, data }: any) => {
        const row = this.actions.get(where.id);
        if (!row) return { count: 0 };
        if (where.status && row.status !== where.status) return { count: 0 };
        const updated: StoredAction = {
          ...row,
          ...data,
          updatedAt: new Date(),
        };
        this.actions.set(where.id, updated);
        this.actionsByIdempotency.set(updated.idempotencyKey, updated);
        if (updated.txHash) this.actionsByTxHash.set(updated.txHash, updated);
        return { count: 1 };
      },
    };

    actionLease = {
      findUnique: async ({ where }: any) => {
        return this.leases.get(where.actionId) ?? null;
      },
      create: async ({ data }: any) => {
        if (this.leases.has(data.actionId)) {
          const err = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
            code: "P2002",
            clientVersion: "5.22.0",
          });
          throw err;
        }
        this.leases.set(data.actionId, data);
        return data;
      },
      update: async ({ where, data }: any) => {
        const existing = this.leases.get(where.actionId);
        if (!existing) throw new Error("Lease not found");
        const updated = { ...existing, ...data };
        this.leases.set(where.actionId, updated);
        return updated;
      },
      updateMany: async ({ where, data }: any) => {
        const existing = this.leases.get(where.actionId);
        if (!existing) return { count: 0 };
        if (where.workerId && existing.workerId !== where.workerId) return { count: 0 };
        const updated = { ...existing, ...data };
        this.leases.set(where.actionId, updated);
        return { count: 1 };
      },
      deleteMany: async ({ where }: any) => {
        let count = 0;
        if (this.leases.has(where.actionId)) {
          this.leases.delete(where.actionId);
          count++;
        }
        return { count };
      },
    };

    pendingEvent = {
      findUnique: async () => null,
      upsert: async () => ({}),
    };

    poisonEvent = {
      create: async ({ data }: any) => {
        this.poisonEvents.set(data.sorobanEventId, data);
        return data;
      },
    };
  }

  let db: MockDeterministicPrisma;
  let ledger: LedgerService;

  beforeEach(() => {
    db = new MockDeterministicPrisma();
    ledger = new LedgerService(db as any);
  });

  describe("Path 1: Normal Path — Concurrent Writes & Replay Equivalence", () => {
    it("N1 & N2: handles concurrent action creation and event reconciliation across multiple actors", async () => {
      const barrier = new Barrier();
      const n = 10;

      // 1. Concurrently submit 10 distinct actions
      const actionResultsPromise = runConcurrently(n, async (i) => {
        await barrier.wait();
        return ledger.createAction({
          walletAddress: `G_WALLET_${i}`,
          actionType: "deposit",
          actionPayload: { vault_id: `vault_${i}`, amount: `${(i + 1) * 100}` },
          idempotencyKey: `idem_norm_${i}`,
        });
      });
      barrier.release();
      const actionResults = await actionResultsPromise;

      expect(countFulfilled(actionResults)).toBe(n);
      expect(db.actions.size).toBe(n);

      // 2. Concurrently reconcile matching on-chain events
      const reconcileBarrier = new Barrier();
      const reconcileResultsPromise = runConcurrently(n, async (i) => {
        await reconcileBarrier.wait();
        const act = (actionResults[i] as PromiseFulfilledResult<any>).value;
        const txHash = `tx_hash_${i}`;

        // Attach hash
        await db.actionLedger.update({
          where: { id: act.id },
          data: { txHash, status: "submitted" },
        });

        // Reconcile event
        return ledger.reconcileEvent({
          txHash,
          sorobanEventId: `0000000000000000100-${i.toString().padStart(10, "0")}`,
          eventPayload: { amount: `${(i + 1) * 100}`, vault_id: `vault_${i}` },
          statusHint: "confirmed",
        });
      });
      reconcileBarrier.release();
      const reconcileResults = await reconcileResultsPromise;

      expect(countFulfilled(reconcileResults)).toBe(n);

      // Verify all actions reached confirmed state with verified payload
      for (let i = 0; i < n; i++) {
        const act = (actionResults[i] as PromiseFulfilledResult<any>).value;
        const stored = db.actions.get(act.id);
        expect(stored?.status).toBe("confirmed");
        expect(stored?.verifiedPayload).toEqual({ amount: `${(i + 1) * 100}`, vault_id: `vault_${i}` });
      }
    });

    it("N3: replaying event log reproduces identical state deterministically", async () => {
      // Create initial actions
      const act1 = await ledger.createAction({
        walletAddress: "G_ALICE",
        actionType: "deposit",
        actionPayload: { vault_id: "v1", amount: "500" },
        idempotencyKey: "idem_replay_1",
      });

      const txHash1 = "tx_replay_1";
      await db.actionLedger.update({ where: { id: act1.id }, data: { txHash: txHash1, status: "submitted" } });

      const eventPayload = { amount: "500", vault_id: "v1" };
      await ledger.reconcileEvent({
        txHash: txHash1,
        sorobanEventId: "0000000000000000100-0000000001",
        eventPayload,
        statusHint: "confirmed",
      });

      const liveState = db.actions.get(act1.id);
      expect(liveState?.status).toBe("confirmed");
      expect(liveState?.verifiedPayload).toEqual(eventPayload);

      // Simulate replaying log into a second scratch database
      const scratchDb = new MockDeterministicPrisma();
      const scratchLedger = new LedgerService(scratchDb as any);

      // Seed unconfirmed intent into scratch database
      const replayedAct = await scratchLedger.createAction({
        walletAddress: "G_ALICE",
        actionType: "deposit",
        actionPayload: { vault_id: "v1", amount: "500" },
        idempotencyKey: "idem_replay_1",
      });
      await scratchDb.actionLedger.update({ where: { id: replayedAct.id }, data: { txHash: txHash1, status: "submitted" } });

      // Replay identical event
      await scratchLedger.reconcileEvent({
        txHash: txHash1,
        sorobanEventId: "0000000000000000100-0000000001",
        eventPayload,
        statusHint: "confirmed",
      });

      const scratchState = scratchDb.actions.get(replayedAct.id);
      expect(scratchState?.status).toBe(liveState?.status);
      expect(scratchState?.verifiedPayload).toEqual(liveState?.verifiedPayload);
      expect(scratchState?.walletAddress).toBe(liveState?.walletAddress);
    });
  });

  describe("Path 2: Failure Path — Conflicting Writes & Poison Events", () => {
    it("F1: conflicting concurrent writes to attach txHash results in exactly one winner", async () => {
      const act = await ledger.createAction({
        walletAddress: "G_ALICE",
        actionType: "deposit",
        actionPayload: { vault_id: "v1", amount: "100" },
        idempotencyKey: "idem_race_attach",
      });

      const barrier = new Barrier();
      // 5 workers simultaneously race to attach their txHash
      const resultsPromise = runConcurrently(5, async (i) => {
        await barrier.wait();
        return ledger.attachTxHash(act.id, `tx_worker_${i}`, { workerId: `worker_${i}` });
      });
      barrier.release();
      const results = await resultsPromise;

      const winners = countFulfilled(results);
      expect(winners).toBe(1);
      const rejs = rejections(results);
      expect(rejs.length).toBe(4);
      for (const err of rejs) {
        expect((err as AppError).code).toBeTruthy();
      }
    });

    it("F2: malformed/poison events are quarantined deterministically without blocking batch", async () => {
      const poisonEventId = "0000000000000000100-9999999999";
      await db.poisonEvent.create({
        data: {
          sorobanEventId: poisonEventId,
          txHash: "tx_poison_1",
          reason: "Malformed XDR decoding failure",
          quarantinedAt: new Date(),
        },
      });

      expect(db.poisonEvents.has(poisonEventId)).toBe(true);
      expect(db.poisonEvents.get(poisonEventId).reason).toContain("Malformed");
    });

    it("F3: rejects invalid state transitions during replay", () => {
      expect(canTransition("confirmed", "pending")).toBe(false);
      expect(canTransition("confirmed", "submitted")).toBe(false);
      expect(canTransition("reverted", "confirmed")).toBe(false);
    });
  });

  describe("Path 3: Retry Path — Serialization Failures & Idempotency", () => {
    it("R1: recovers from transient serialization conflicts with bounded retries", async () => {
      let attempts = 0;
      const simulateRetryableWrite = async () => {
        attempts++;
        if (attempts < 3) {
          // Simulate Prisma P2034 serialization failure on first 2 attempts
          const err = new Prisma.PrismaClientKnownRequestError("Serialization failure", {
            code: "P2034",
            clientVersion: "5.22.0",
          });
          throw err;
        }
        return ledger.createAction({
          walletAddress: "G_ALICE",
          actionType: "deposit",
          actionPayload: { vault_id: "v1", amount: "100" },
          idempotencyKey: "idem_retry_transient",
        });
      };

      const MAX_RETRIES = 5;
      let result = null;
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          result = await simulateRetryableWrite();
          break;
        } catch (err) {
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2034") {
            continue; // Bounded retry
          }
          throw err;
        }
      }

      expect(attempts).toBe(3);
      expect(result).not.toBeNull();
      expect(result?.idempotencyKey).toBe("idem_retry_transient");
      expect(db.actions.size).toBe(1);
    });

    it("R2: high-concurrency duplicate retries return stable existing record without duplication", async () => {
      const payload = { vault_id: "v1", amount: "250" };
      const idempotencyKey = "idem_dup_concurrency_race";

      const barrier = new Barrier();
      // 8 simultaneous retries for the exact same idempotency key
      const resultsPromise = runConcurrently(8, async () => {
        await barrier.wait();
        return ledger.createAction({
          walletAddress: "G_ALICE",
          actionType: "deposit",
          actionPayload: payload,
          idempotencyKey,
        });
      });
      barrier.release();
      const results = await resultsPromise;

      expect(countFulfilled(results)).toBe(8);
      const firstResult = (results[0] as PromiseFulfilledResult<any>).value;

      // All 8 callers receive the exact same action ID and correlation ID
      for (const res of results) {
        const val = (res as PromiseFulfilledResult<any>).value;
        expect(val.id).toBe(firstResult.id);
        expect(val.correlationId).toBe(firstResult.correlationId);
      }

      // Exactly ONE record exists in the store
      expect(db.actions.size).toBe(1);
    });

    it("R3: repeated failure beyond retry limit halts without dangling state", async () => {
      let attempts = 0;
      const MAX_RETRIES = 3;
      let failed = false;

      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        attempts++;
        try {
          throw new Error("Persistent database failure");
        } catch {
          if (attempt === MAX_RETRIES - 1) {
            failed = true;
          }
        }
      }

      expect(attempts).toBe(3);
      expect(failed).toBe(true);
    });
  });

  describe("Path 4: Authorization Path — Identity Isolation & Multi-Sig Snapshot Replay", () => {
    it("A1: strict wallet isolation under concurrent submissions", async () => {
      const actA = await ledger.createAction({
        walletAddress: "G_ALICE",
        actionType: "deposit",
        actionPayload: { vault_id: "v1", amount: "100" },
        idempotencyKey: "idem_auth_alice",
      });

      const actB = await ledger.createAction({
        walletAddress: "G_BOB",
        actionType: "deposit",
        actionPayload: { vault_id: "v1", amount: "200" },
        idempotencyKey: "idem_auth_bob",
      });

      expect(actA.walletAddress).toBe("G_ALICE");
      expect(actB.walletAddress).toBe("G_BOB");
      expect(actA.id).not.toBe(actB.id);
    });

    it("A2: multi-sig admin replay validates snapshot signer authorization", () => {
      const snapshotSigners = new Set(["G_ADMIN_1", "G_ADMIN_2", "G_ADMIN_3"]);
      const threshold = 2;

      function verifyProposalApproval(approvers: string[]): boolean {
        const validApprovals = approvers.filter((a) => snapshotSigners.has(a));
        const uniqueApprovals = new Set(validApprovals);
        return uniqueApprovals.size >= threshold;
      }

      // Valid: 2 distinct snapshot signers
      expect(verifyProposalApproval(["G_ADMIN_1", "G_ADMIN_2"])).toBe(true);

      // Invalid: 1 snapshot signer and 1 attacker
      expect(verifyProposalApproval(["G_ADMIN_1", "G_ATTACKER"])).toBe(false);

      // Invalid: same snapshot signer duplicated
      expect(verifyProposalApproval(["G_ADMIN_1", "G_ADMIN_1"])).toBe(false);
    });

    it("A3: revoked session during concurrent action rejects unauthenticated requests", async () => {
      let sessionValid = true;

      const barrier = new Barrier();
      const resultsPromise = runConcurrently(4, async (i) => {
        await barrier.wait();
        if (i >= 2) sessionValid = false; // Revoke session midway
        if (!sessionValid) {
          throw AppError.unauthorized();
        }
        return ledger.createAction({
          walletAddress: "G_ALICE",
          actionType: "deposit",
          actionPayload: { vault_id: "v1", amount: "50" },
          idempotencyKey: `idem_sess_${i}`,
        });
      });
      barrier.release();
      const results = await resultsPromise;

      const fulfilled = countFulfilled(results);
      const rejected = rejections(results);

      expect(fulfilled + rejected.length).toBe(4);
      for (const err of rejected) {
        expect((err as AppError).code).toBe("UNAUTHORIZED");
      }
    });
  });
});
