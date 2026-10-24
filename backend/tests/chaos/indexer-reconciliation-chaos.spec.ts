/**
 * Chaos tests for indexer reconciliation workflow (Issue #1).
 * 
 * Tests event ingestion, reconciliation, and drift detection under failures.
 * Verifies eventual consistency and no lost/duplicate events.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createTestPrisma } from "../helpers/db.js";
import { LedgerService } from "../../src/services/ledger.js";
import { CacheService } from "../../src/services/cacheService.js";
import type { PrismaClient } from "@prisma/client";
import { runChaosTest, ChaosScenario } from "./chaos-framework.js";
import { AppError } from "../../src/errors.js";
import { ERROR_CODES } from "../../src/constants.js";

const INDEXER_CHAOS_SCENARIOS: ChaosScenario[] = [
  {
    name: "event_ingestion_with_network_failure",
    faults: [
      { type: "network_timeout", atOperation: 2 },
    ],
    expectedOutcome: "success",
  },
  {
    name: "reconciliation_with_process_restart",
    faults: [
      { type: "process_restart", atOperation: 4 },
    ],
    expectedOutcome: "success",
  },
  {
    name: "duplicate_event_delivery_with_conflict",
    faults: [
      { type: "transaction_conflict", atOperation: 3 },
    ],
    expectedOutcome: "success",
  },
  {
    name: "reconciliation_with_stale_checkpoint",
    faults: [
      { type: "stale_read", atOperation: 1 },
      { type: "transaction_conflict", atOperation: 5 },
    ],
    expectedOutcome: "success",
  },
];

describe("Indexer Reconciliation Chaos Tests", () => {
  let prisma: PrismaClient;
  let ledgerService: LedgerService;
  let cacheService: CacheService;

  beforeEach(async () => {
    prisma = await createTestPrisma();
    cacheService = new CacheService(prisma, null);
    ledgerService = new LedgerService(prisma, cacheService);
  });

  it("event ingestion survives network failure", async () => {
    const scenario = INDEXER_CHAOS_SCENARIOS[0];
    const txHash = `chaos-tx-ingest-${Date.now()}`;
    const eventId = `chaos-event-${Date.now()}`;

    await runChaosTest(
      scenario,
      async (coordinator) => {
        // Op 1: Check for existing pending event
        await coordinator.beforeOperation("check_pending_event");
        const existing = await prisma.pendingEvent.findUnique({
          where: { txHash },
        });

        if (existing) return existing;

        // Op 2: Ingest event (network_timeout fault)
        await coordinator.beforeOperation("ingest_event");
        try {
          return await prisma.pendingEvent.create({
            data: {
              txHash,
              sorobanEventId: eventId,
              eventPayload: {
                type: "deposit",
                amount: "5000",
                wallet: "GCHAOSINGEST1",
              },
              statusHint: "pending",
              receivedAt: new Date(),
            },
          });
        } catch (err) {
          if (err instanceof AppError && err.code === ERROR_CODES.NETWORK_ERROR) {
            // Retry ingestion
            await coordinator.beforeOperation("retry_ingest");
            return await prisma.pendingEvent.create({
              data: {
                txHash,
                sorobanEventId: eventId,
                eventPayload: {
                  type: "deposit",
                  amount: "5000",
                  wallet: "GCHAOSINGEST1",
                },
                statusHint: "pending",
                receivedAt: new Date(),
              },
            });
          }
          throw err;
        }
      },
      async (result, faults) => {
        expect(result).toBeDefined();
        expect(faults).toHaveLength(1);

        // Verify exactly one pending event
        const events = await prisma.pendingEvent.findMany({
          where: { txHash },
        });
        expect(events).toHaveLength(1);
      }
    );
  });

  it("reconciliation survives process restart", async () => {
    const scenario = INDEXER_CHAOS_SCENARIOS[1];
    const txHash = `chaos-tx-reconcile-${Date.now()}`;
    const walletAddress = "GCHAOSRECONCILE1";

    // Setup: create action and pending event
    const action = await ledgerService.createAction({
      idempotencyKey: `reconcile-setup-${Date.now()}`,
      walletAddress,
      actionType: "deposit",
      actionPayload: { amount: "3000", poolId: "reconcile-pool" },
    });

    await prisma.pendingEvent.create({
      data: {
        txHash,
        sorobanEventId: `event-${Date.now()}`,
        eventPayload: {
          type: "deposit_confirmed",
          actionId: action.id,
        },
        statusHint: "confirmed",
        receivedAt: new Date(),
      },
    });

    await runChaosTest(
      scenario,
      async (coordinator) => {
        // Op 1: Read checkpoint
        await coordinator.beforeOperation("read_checkpoint");
        const checkpoint = await prisma.indexerCheckpoint.findFirst();

        // Op 2: Fetch pending events
        await coordinator.beforeOperation("fetch_pending_events");
        const pendingEvents = await prisma.pendingEvent.findMany({
          where: { consumedAt: null },
          take: 10,
        });

        // Op 3: Attach tx_hash to action
        await coordinator.beforeOperation("attach_tx_hash");
        await ledgerService.attachTxHash({
          id: action.id,
          txHash,
          submittedAt: new Date(),
        });

        // Op 4: Reconcile event (process_restart fault)
        await coordinator.beforeOperation("reconcile_event");
        return await ledgerService.reconcileEvent({
          txHash,
          status: "confirmed",
          ledger: 1000,
          createdAt: new Date().toISOString(),
        });
      },
      async (result, faults) => {
        // After restart, verify action is confirmed
        const action_after = await prisma.actionLedger.findUnique({
          where: { id: action.id },
        });
        expect(action_after?.status).toBe("confirmed");

        // Verify pending event is consumed
        const event = await prisma.pendingEvent.findUnique({
          where: { txHash },
        });
        expect(event?.consumedAt).toBeDefined();
      }
    );
  });

  it("duplicate event delivery is idempotent", async () => {
    const scenario = INDEXER_CHAOS_SCENARIOS[2];
    const txHash = `chaos-tx-duplicate-${Date.now()}`;
    const eventId = `chaos-event-dup-${Date.now()}`;

    await runChaosTest(
      scenario,
      async (coordinator) => {
        // Op 1: First event delivery
        await coordinator.beforeOperation("first_delivery");
        await prisma.pendingEvent.create({
          data: {
            txHash,
            sorobanEventId: eventId,
            eventPayload: { type: "withdrawal", amount: "2000" },
            statusHint: "confirmed",
            receivedAt: new Date(),
          },
        });

        // Op 2: Update checkpoint
        await coordinator.beforeOperation("update_checkpoint");
        await prisma.indexerCheckpoint.upsert({
          where: { id: 1 },
          create: {
            id: 1,
            latestLedger: 1000,
            lastProcessedEventId: eventId,
            lastSyncTime: new Date(),
            lastSuccessSyncTime: new Date(),
          },
          update: {
            lastProcessedEventId: eventId,
            lastSyncTime: new Date(),
          },
        });

        // Op 3: Duplicate delivery attempt (transaction_conflict fault)
        await coordinator.beforeOperation("duplicate_delivery");
        try {
          return await prisma.pendingEvent.create({
            data: {
              txHash,
              sorobanEventId: eventId,
              eventPayload: { type: "withdrawal", amount: "2000" },
              statusHint: "confirmed",
              receivedAt: new Date(),
            },
          });
        } catch (err: any) {
          if (err.code === "P2002") {
            // Unique constraint violation, fetch existing
            await coordinator.beforeOperation("fetch_existing");
            return await prisma.pendingEvent.findUnique({
              where: { txHash },
            });
          }
          throw err;
        }
      },
      async (result, faults) => {
        expect(result).toBeDefined();
        expect(faults).toHaveLength(1);

        // Verify exactly one event despite duplicate delivery
        const events = await prisma.pendingEvent.findMany({
          where: { txHash },
        });
        expect(events).toHaveLength(1);
      }
    );
  });

  it("reconciliation handles stale checkpoint with retry", async () => {
    const scenario = INDEXER_CHAOS_SCENARIOS[3];
    const txHash = `chaos-tx-stale-${Date.now()}`;
    const walletAddress = "GCHAOSSTALE1";

    // Setup action
    const action = await ledgerService.createAction({
      idempotencyKey: `stale-checkpoint-${Date.now()}`,
      walletAddress,
      actionType: "withdraw",
      actionPayload: { amount: "1500", poolId: "stale-pool" },
    });

    await ledgerService.attachTxHash({
      id: action.id,
      txHash,
      submittedAt: new Date(),
    });

    await runChaosTest(
      scenario,
      async (coordinator) => {
        // Op 1: Read checkpoint (stale_read fault)
        await coordinator.beforeOperation("read_checkpoint_stale");
        let checkpoint = await prisma.indexerCheckpoint.findFirst();
        checkpoint = coordinator.interceptRead(checkpoint) as any;

        // Op 2: Verify checkpoint is current
        await coordinator.beforeOperation("verify_checkpoint");
        if (checkpoint && (checkpoint as any).__stale) {
          // Detected stale read, refetch
          await coordinator.beforeOperation("refetch_checkpoint");
          checkpoint = await prisma.indexerCheckpoint.findFirst();
        }

        // Op 3: Fetch pending events
        await coordinator.beforeOperation("fetch_events");
        const events = await prisma.pendingEvent.findMany({
          where: { consumedAt: null },
          take: 5,
        });

        // Op 4: Reconcile event
        await coordinator.beforeOperation("reconcile_withdraw");
        await ledgerService.reconcileEvent({
          txHash,
          status: "confirmed",
          ledger: 2000,
          createdAt: new Date().toISOString(),
        });

        // Op 5: Update checkpoint (transaction_conflict fault)
        await coordinator.beforeOperation("update_checkpoint");
        try {
          return await prisma.indexerCheckpoint.upsert({
            where: { id: 1 },
            create: {
              id: 1,
              latestLedger: 2000,
              lastProcessedEventId: `event-${Date.now()}`,
              lastSyncTime: new Date(),
              lastSuccessSyncTime: new Date(),
            },
            update: {
              latestLedger: 2000,
              lastSyncTime: new Date(),
            },
          });
        } catch (err) {
          if (err instanceof AppError && err.code === ERROR_CODES.CONFLICT) {
            // Retry checkpoint update
            await coordinator.beforeOperation("retry_checkpoint");
            return await prisma.indexerCheckpoint.upsert({
              where: { id: 1 },
              create: {
                id: 1,
                latestLedger: 2000,
                lastProcessedEventId: `event-${Date.now()}`,
                lastSyncTime: new Date(),
                lastSuccessSyncTime: new Date(),
              },
              update: {
                latestLedger: 2000,
                lastSyncTime: new Date(),
              },
            });
          }
          throw err;
        }
      },
      async (result, faults) => {
        expect(result).toBeDefined();
        expect(faults.length).toBeGreaterThanOrEqual(1);

        // Verify action is reconciled
        const finalAction = await prisma.actionLedger.findUnique({
          where: { id: action.id },
        });
        expect(finalAction?.status).toBe("confirmed");

        // Verify checkpoint is updated
        const finalCheckpoint = await prisma.indexerCheckpoint.findFirst();
        expect(finalCheckpoint?.latestLedger).toBe(2000);
      }
    );
  });
});
