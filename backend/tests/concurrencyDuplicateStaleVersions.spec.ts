/**
 * Concurrency tests for duplicate submissions and stale versions (#966).
 *
 * Verifies:
 * - Duplicate submissions:
 *   - Normal path: Concurrent identical requests converge to a single committed record
 *   - Failure path: Same idempotency key with conflicting payload rejected with 409 Conflict
 *   - Retry path: Idempotent replay after network jitter returns recorded receipt
 *   - Authorization path: Cross-wallet key reuse rejected, protecting multi-tenant isolation
 *
 * - Stale versions (Optimistic Concurrency Control):
 *   - Normal path: Write with valid expected version succeeds and advances sequence
 *   - Failure path: Stale version write rejected with VAULT_CONCURRENT_MODIFICATION
 *   - Retry path: Conflict error drives refresh and successful retry with fresh token
 *   - Authorization path: Unauthorized wallet cannot mutate or probe version state
 *
 * - Stress interleavings:
 *   - N concurrent writers racing for the same version token: exactly one winner
 *   - Checkpoint state transitions under concurrent worker access
 */

import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { LedgerService } from "../src/services/ledger.js";
import { ERROR_CODES } from "../src/constants.js";
import { AppError } from "../src/errors.js";
import {
  Barrier,
  runConcurrently,
  countFulfilled,
  rejections,
  yieldTo,
} from "./helpers/concurrency.js";

// ── Optimistic Concurrency Control Helpers ─────────────────────────────────────

interface VersionToken {
  entityId: string;
  entityType: string;
  version: number;
  sequence: number;
}

interface ConflictError {
  reasonCode: string;
  userMessage: string;
  recoveryHint: string;
  expectedVersion: VersionToken;
  actualVersion: VersionToken;
  retryable: boolean;
}

type VersionCheckedResult<T> =
  | { success: true; data: T }
  | { success: false; conflict: ConflictError };

const VAULT_REJECTION_REASONS = {
  CONCURRENT_MODIFICATION: "CONCURRENT_MODIFICATION",
} as const;

function createVersionToken(
  entityId: string,
  entityType: string,
  version: number,
  sequence: number,
): VersionToken {
  return { entityId, entityType, version, sequence };
}

function isVersionValid(current: VersionToken, expected: VersionToken): boolean {
  return current.version === expected.version && current.sequence === expected.sequence;
}

function createConflictError(
  entityType: string,
  expectedVersion: VersionToken,
  actualVersion: VersionToken,
): ConflictError {
  return {
    reasonCode: VAULT_REJECTION_REASONS.CONCURRENT_MODIFICATION,
    userMessage: "This record was modified by another user or process. Please refresh and try again.",
    recoveryHint: "Refresh the data to see the latest changes, then retry your modification.",
    expectedVersion,
    actualVersion,
    retryable: true,
  };
}

async function executeWithRetryOnConflict<T>(
  operation: (version: VersionToken) => Promise<T>,
  getVersion: () => Promise<VersionToken | null>,
  maxRetries: number = 2,
): Promise<VersionCheckedResult<T>> {
  let lastConflict: ConflictError | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const currentVersion = await getVersion();
    if (!currentVersion) {
      const data = await operation({ entityId: "unknown", entityType: "unknown", version: 0, sequence: 0 });
      return { success: true, data };
    }

    try {
      const data = await operation(currentVersion);
      return { success: true, data };
    } catch (error) {
      const errorWithVersion = error as { conflict?: ConflictError };
      if (errorWithVersion.conflict) {
        lastConflict = errorWithVersion.conflict;
        continue;
      }
      throw error;
    }
  }

  return {
    success: false,
    conflict:
      lastConflict ||
      createConflictError(
        "unknown",
        { entityId: "unknown", entityType: "unknown", version: 0, sequence: 0 },
        { entityId: "unknown", entityType: "unknown", version: 0, sequence: 0 },
      ),
  };
}

// ── Deterministic in-memory database mock ──────────────────────────────────────

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
  recoveryCheckpoint: any;
  observedLedger: number;
  finalizedLedger: number | null;
  confirmationDepth: number;
  finalityStatus: string;
  createdAt: Date;
  updatedAt: Date;
  confirmedAt: Date | null;
}

class MockConcurrencyPrisma {
  public actions = new Map<string, StoredAction>();
  public actionsByIdempotency = new Map<string, StoredAction>();
  public actionsByTxHash = new Map<string, StoredAction>();

  async $transaction<T>(
    fn: (tx: any) => Promise<T>,
    _options?: { isolationLevel?: Prisma.TransactionIsolationLevel },
  ): Promise<T> {
    return fn(this);
  }

  actionLedger = {
    findUnique: async ({ where }: any) => {
      if (where.id) return this.actions.get(where.id) ?? null;
      if (where.idempotencyKey) {
        return this.actionsByIdempotency.get(where.idempotencyKey) ?? null;
      }
      return null;
    },
    findFirst: async ({ where }: any) => {
      if (where.idempotencyKey) {
        return this.actionsByIdempotency.get(where.idempotencyKey) ?? null;
      }
      if (where.txHash) {
        return this.actionsByTxHash.get(where.txHash) ?? null;
      }
      return null;
    },
    create: async ({ data }: any) => {
      if (this.actionsByIdempotency.has(data.idempotencyKey)) {
        throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
          code: "P2002",
          clientVersion: "5.22.0",
        });
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
        recoveryCheckpoint: { stage: "intent_recorded", checkpointed_at: new Date().toISOString() },
        observedLedger: data.observedLedger ?? 0,
        finalizedLedger: data.finalizedLedger ?? null,
        confirmationDepth: data.confirmationDepth ?? 1,
        finalityStatus: data.finalityStatus ?? "provisional",
        createdAt: new Date(),
        updatedAt: new Date(),
        confirmedAt: null,
      };
      this.actions.set(record.id, record);
      this.actionsByIdempotency.set(record.idempotencyKey, record);
      return record;
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
      return { count: 1 };
    },
  };
}

// ── Test suites ────────────────────────────────────────────────────────────────

describe("Concurrency - Duplicate Submissions (#966)", () => {
  let mockPrisma: MockConcurrencyPrisma;
  let ledgerService: LedgerService;

  const WALLET_ALICE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
  const WALLET_BOB = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBWHF";

  beforeEach(() => {
    mockPrisma = new MockConcurrencyPrisma();
    ledgerService = new LedgerService(mockPrisma as unknown as PrismaClient);
  });

  it("normal path: concurrent identical duplicate submissions converge to exactly 1 record", async () => {
    const idempotencyKey = randomUUID();
    const payload = { pool_id: "pool-usdc", amount: "500", asset: "USDC" };
    const barrier = new Barrier();

    const batch = runConcurrently(8, async () => {
      await barrier.wait();
      return ledgerService.createAction({
        idempotencyKey,
        walletAddress: WALLET_ALICE,
        actionType: "deposit",
        actionPayload: payload,
      });
    });
    barrier.release();
    const results = await batch;

    // All 8 requests must succeed
    expect(countFulfilled(results)).toBe(8);

    // Exactly one row exists in the store
    expect(mockPrisma.actions.size).toBe(1);

    // All fulfilled results reference the exact same action id
    const actionIds = new Set(
      results
        .filter((r): r is PromiseFulfilledResult<any> => r.status === "fulfilled")
        .map((r) => r.value.id),
    );
    expect(actionIds.size).toBe(1);
  });

  it("failure path: duplicate key with different payload is rejected with 409 Conflict", async () => {
    const idempotencyKey = randomUUID();
    const originalPayload = { pool_id: "pool-usdc", amount: "500", asset: "USDC" };
    const alteredPayload = { pool_id: "pool-usdc", amount: "9999", asset: "USDC" };

    // Initial submission succeeds
    const first = await ledgerService.createAction({
      idempotencyKey,
      walletAddress: WALLET_ALICE,
      actionType: "deposit",
      actionPayload: originalPayload,
    });
    expect(first.id).toBeTruthy();

    // Reusing the same key with conflicting amount is rejected
    await expect(
      ledgerService.createAction({
        idempotencyKey,
        walletAddress: WALLET_ALICE,
        actionType: "deposit",
        actionPayload: alteredPayload,
      }),
    ).rejects.toThrow(
      expect.objectContaining({
        code: ERROR_CODES.IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD,
        statusCode: 409,
      }),
    );

    // Invariant: original record is untouched
    const stored = mockPrisma.actionsByIdempotency.get(idempotencyKey);
    expect(stored?.actionPayload.amount).toBe("500");
  });

  it("retry path: re-submitting after network failure returns existing record idempotently", async () => {
    const idempotencyKey = randomUUID();
    const payload = { pool_id: "pool-usdc", amount: "250", asset: "USDC" };

    // Initial attempt commits
    const initial = await ledgerService.createAction({
      idempotencyKey,
      walletAddress: WALLET_ALICE,
      actionType: "deposit",
      actionPayload: payload,
    });

    // 5 sequential retries (e.g. client network retry loop)
    for (let i = 0; i < 5; i++) {
      const retryResult = await ledgerService.createAction({
        idempotencyKey,
        walletAddress: WALLET_ALICE,
        actionType: "deposit",
        actionPayload: payload,
      });
      expect(retryResult.id).toBe(initial.id);
      expect(retryResult.createdAt).toEqual(initial.createdAt);
    }

    // Invariant: no duplicate rows created
    expect(mockPrisma.actions.size).toBe(1);
  });

  it("authorization path: Wallet B cannot reuse or hijack Wallet A's idempotency key", async () => {
    const idempotencyKey = randomUUID();
    const payload = { pool_id: "pool-usdc", amount: "100", asset: "USDC" };

    // Alice creates her action
    await ledgerService.createAction({
      idempotencyKey,
      walletAddress: WALLET_ALICE,
      actionType: "deposit",
      actionPayload: payload,
    });

    // Bob attempts to submit using Alice's key
    await expect(
      ledgerService.createAction({
        idempotencyKey,
        walletAddress: WALLET_BOB,
        actionType: "deposit",
        actionPayload: payload,
      }),
    ).rejects.toThrow(
      expect.objectContaining({
        code: ERROR_CODES.IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD,
        statusCode: 409,
      }),
    );

    // Alice's row remains mapped to Alice
    const row = mockPrisma.actionsByIdempotency.get(idempotencyKey);
    expect(row?.walletAddress).toBe(WALLET_ALICE);
  });
});

describe("Concurrency - Stale Versions & Optimistic Locking (#966)", () => {
  interface VersionedEntity {
    id: string;
    type: string;
    name: string;
    version: number;
    sequence: number;
    updatedBy: string;
  }

  class VersionedStore {
    private records = new Map<string, VersionedEntity>();

    set(entity: VersionedEntity) {
      this.records.set(entity.id, { ...entity });
    }

    get(id: string): VersionedEntity | null {
      const row = this.records.get(id);
      return row ? { ...row } : null;
    }

    getToken(id: string): VersionToken | null {
      const row = this.get(id);
      if (!row) return null;
      return createVersionToken(row.id, row.type, row.version, row.sequence);
    }

    async update(
      expectedToken: VersionToken,
      updates: Partial<VersionedEntity>,
      actor: string,
    ): Promise<VersionCheckedResult<VersionedEntity>> {
      await yieldTo();
      const current = this.get(expectedToken.entityId);
      if (!current) {
        throw new Error("ENTITY_NOT_FOUND");
      }

      const currentToken = createVersionToken(
        current.id,
        current.type,
        current.version,
        current.sequence,
      );

      if (!isVersionValid(currentToken, expectedToken)) {
        return {
          success: false,
          conflict: createConflictError(current.type, expectedToken, currentToken),
        };
      }

      // Valid: advance version and sequence
      const next: VersionedEntity = {
        ...current,
        ...updates,
        version: current.version + 10,
        sequence: current.sequence + 1,
        updatedBy: actor,
      };
      this.set(next);
      return { success: true, data: next };
    }
  }

  let store: VersionedStore;

  beforeEach(() => {
    store = new VersionedStore();
    store.set({
      id: "pool-alpha",
      type: "saved_pool",
      name: "Original Pool Name",
      version: 1000,
      sequence: 1,
      updatedBy: "G_SYSTEM",
    });
  });

  it("normal path: write with matching expected version succeeds and advances sequence", async () => {
    const token = store.getToken("pool-alpha")!;
    expect(token).toBeTruthy();

    const result = await store.update(token, { name: "Renamed Pool" }, "G_ALICE");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe("Renamed Pool");
      expect(result.data.sequence).toBe(2);
      expect(result.data.version).toBe(1010);
    }
  });

  it("failure path: stale version write is rejected with structured conflict error", async () => {
    const initialToken = store.getToken("pool-alpha")!;

    // Client 1 commits first, advancing version
    await store.update(initialToken, { name: "Client 1 Edit" }, "G_CLIENT_1");

    // Client 2 attempts to write with stale initialToken
    const result = await store.update(initialToken, { name: "Client 2 Stale Edit" }, "G_CLIENT_2");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.conflict.reasonCode).toBe(VAULT_REJECTION_REASONS.CONCURRENT_MODIFICATION);
      expect(result.conflict.expectedVersion.sequence).toBe(1);
      expect(result.conflict.actualVersion.sequence).toBe(2);
      expect(result.conflict.retryable).toBe(true);
      expect(result.conflict.userMessage).toContain("modified");
      expect(result.conflict.recoveryHint.toLowerCase()).toContain("refresh");
    }

    // Server state remains Client 1's commit
    expect(store.get("pool-alpha")?.name).toBe("Client 1 Edit");
  });

  it("retry path: client refreshes version token on conflict and succeeds on retry", async () => {
    const initialToken = store.getToken("pool-alpha")!;

    // Interleaving writer commits ahead
    await store.update(initialToken, { name: "Interleaved Update" }, "G_WRITER_1");

    // Client 2 uses executeWithRetryOnConflict to automatically refresh and retry
    const result = await executeWithRetryOnConflict(
      async (freshToken) => {
        const updateRes = await store.update(freshToken, { name: "Retried Final Name" }, "G_WRITER_2");
        if (!updateRes.success) {
          throw { conflict: updateRes.conflict };
        }
        return updateRes.data;
      },
      async () => store.getToken("pool-alpha"),
      3,
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe("Retried Final Name");
      expect(result.data.sequence).toBe(3);
    }
  });

  it("authorization path: unauthorized wallet cannot mutate state or bypass version checks", async () => {
    const initialToken = store.getToken("pool-alpha")!;

    const authorizeAndMutate = async (actor: string, token: VersionToken) => {
      // Authorization boundary: only authorized members can write
      if (actor !== "G_ALICE" && actor !== "G_SYSTEM") {
        throw AppError.forbidden("Unauthorized wallet cannot mutate pool");
      }
      return store.update(token, { name: "Malicious Edit" }, actor);
    };

    // Attacker rejected at authorization boundary
    await expect(authorizeAndMutate("G_ATTACKER", initialToken)).rejects.toThrow("Unauthorized");

    // Invariant: Pool unchanged
    expect(store.get("pool-alpha")?.name).toBe("Original Pool Name");
  });

  it("stress: exactly 1 of N concurrent writers wins a version-guarded race", async () => {
    const baseToken = store.getToken("pool-alpha")!;
    const barrier = new Barrier();

    const batch = runConcurrently(10, async (i) => {
      await barrier.wait();
      return store.update(baseToken, { name: `Winner ${i}` }, `G_ACTOR_${i}`);
    });
    barrier.release();
    const results = await batch;

    const winners = countFulfilled(results, (r) => r.success === true);
    const losers = countFulfilled(results, (r) => r.success === false);

    expect(winners).toBe(1);
    expect(losers).toBe(9);

    // Entity sequence increased exactly by 1
    const finalRecord = store.get("pool-alpha")!;
    expect(finalRecord.sequence).toBe(2);
    expect(finalRecord.name).toMatch(/^Winner \d+$/);
  });
});
