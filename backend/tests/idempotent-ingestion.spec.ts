import { describe, it, expect, vi } from "vitest";
import { LedgerService, type ReconcileEventInput } from "../src/services/ledger.js";
import {
  StellarIndexer,
  type RawHorizonEvent,
} from "../src/services/stellarIndexer.js";

function b64(value: unknown): string {
  return Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64");
}

function makeEvent(overrides: Partial<RawHorizonEvent> = {}): RawHorizonEvent {
  return {
    id: overrides.id ?? "0000000000000000100-0000000001",
    ledger: overrides.ledger ?? 100,
    txHash: overrides.txHash ?? "tx_idempotent_1",
    contractId: overrides.contractId ?? "CDRIP_TEST",
    topicXdr: overrides.topicXdr ?? [b64("deposit")],
    valueXdr: overrides.valueXdr ?? b64({ amount: "1000", vault_id: "v1" }),
    successful: overrides.successful ?? true,
    ledgerClosedAt: overrides.ledgerClosedAt ?? new Date().toISOString(),
  };
}

function withTransactionMock(mockPrisma: Record<string, unknown>) {
  mockPrisma.$transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(mockPrisma));
  return mockPrisma;
}

describe("Guarantee Idempotent Event Ingestion in Action-Ledger Unit Tests (#726)", () => {
  it("reconcileEvent safely no-ops and skips side effects when row is already in terminal state", async () => {
    const callbackFn = vi.fn();

    const mockActionRow = {
      id: "act_1",
      txHash: "tx_already_confirmed",
      status: "confirmed", // already in terminal state
      actionType: "select_winner",
    };

    const actionUpdate = vi.fn(async () => ({}));
    const mockPrisma = withTransactionMock({
      actionLedger: {
        findFirst: vi.fn(async () => mockActionRow),
        update: actionUpdate,
      },
      actionLease: {
        deleteMany: vi.fn(async () => ({ count: 0 })),
      },
    }) as any;

    const ledger = new LedgerService(mockPrisma);
    ledger.onActionConfirmed(callbackFn);

    const input: ReconcileEventInput = {
      txHash: "tx_already_confirmed",
      sorobanEventId: "0000000000000000100-0000000001",
      eventPayload: { winner: "GALICE" },
      statusHint: "confirmed",
    };

    // First redundant delivery
    const res1 = await ledger.reconcileEvent(input);
    expect(res1.matched).toBe(true);

    // Second redundant delivery
    const res2 = await ledger.reconcileEvent(input);
    expect(res2.matched).toBe(true);

    // Assert update was NEVER called and callback was NEVER fired
    expect(actionUpdate).not.toHaveBeenCalled();
    expect(callbackFn).not.toHaveBeenCalled();
  });

  it("reconcileEvents batch deduplication correctly preserves multi-event transactions", async () => {
    const callbackFn = vi.fn();

    const rows = [
      { id: "act_1", txHash: "tx_multi_1", status: "submitted", actionType: "select_winner" },
    ];

    const actionUpdate = vi.fn(async () => ({}));
    const pendingEventCreateMany = vi.fn(async () => ({ count: 0 }));

    const mockPrisma = withTransactionMock({
      actionLedger: {
        findMany: vi.fn(async () => rows),
        update: actionUpdate,
      },
      actionLease: {
        deleteMany: vi.fn(async () => ({ count: 1 })),
      },
      pendingEvent: {
        createMany: pendingEventCreateMany,
      },
    }) as any;

    const ledger = new LedgerService(mockPrisma);
    ledger.onActionConfirmed(callbackFn);

    const batch: ReconcileEventInput[] = [
      {
        txHash: "tx_multi_1",
        sorobanEventId: "0000000000000000100-0000000001",
        eventPayload: { winner: "GALICE" },
        statusHint: "confirmed",
      },
      {
        txHash: "tx_unmatched_1",
        sorobanEventId: "0000000000000000100-0000000002",
        eventPayload: { amount: "100" },
        statusHint: "confirmed",
      },
    ];

    const outcomes = await ledger.reconcileEvents(batch);
    expect(outcomes).toHaveLength(2);
    expect(outcomes[0].matched).toBe(true);
    expect(outcomes[1].matched).toBe(false);

    // Confirm callback fired exactly once for newly confirmed select_winner
    expect(callbackFn).toHaveBeenCalledTimes(1);
    expect(callbackFn).toHaveBeenCalledWith("act_1", "select_winner");

    // Unmatched parked in pending_events with skipDuplicates
    expect(pendingEventCreateMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({
          txHash: "tx_unmatched_1",
          sorobanEventId: "0000000000000000100-0000000002",
        }),
      ]),
      skipDuplicates: true,
    });
  });

  it("appendChainEvents uses skipDuplicates on event ID for atomic insert-or-ignore", async () => {
    const chainEventCreateMany = vi.fn(async () => ({ count: 2 }));
    const mockPrisma = {
      chainEvent: {
        createMany: chainEventCreateMany,
      },
    } as any;

    const ledger = new LedgerService(mockPrisma);
    const rawEvents: RawHorizonEvent[] = [
      makeEvent({ id: "0000000000000000100-0000000001", txHash: "tx_1" }),
      makeEvent({ id: "0000000000000000100-0000000002", txHash: "tx_1" }), // same txHash, distinct event ID
    ];

    await ledger.appendChainEvents(rawEvents);

    expect(chainEventCreateMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ id: "0000000000000000100-0000000001", txHash: "tx_1" }),
        expect.objectContaining({ id: "0000000000000000100-0000000002", txHash: "tx_1" }),
      ],
      skipDuplicates: true,
    });
  });

  it("StellarIndexer intra-batch deduplication correctly deduplicates by raw.id", async () => {
    const appendChainEventsMock = vi.fn(async () => {});
    const reconcileEventsMock = vi.fn(async () => [{ txHash: "tx_1", matched: true }]);

    const mockLedger = {
      appendChainEvents: appendChainEventsMock,
      reconcileEvents: reconcileEventsMock,
      upsertPoolRegistryEntry: vi.fn(async () => {}),
      quarantineEvent: vi.fn(async () => {}),
    } as unknown as LedgerService;

    const decoderMock = {
      decode: vi.fn((_raw: RawHorizonEvent) => ({ type: "deposit", amount: "100" })),
    };

    const duplicateEvents: RawHorizonEvent[] = [
      makeEvent({ id: "0000000000000000100-0000000001", txHash: "tx_1", ledger: 100 }),
      makeEvent({ id: "0000000000000000100-0000000001", txHash: "tx_1", ledger: 100 }), // duplicate event ID
    ];

    const indexer = new StellarIndexer({
      ledger: mockLedger,
      source: {
        fetchEvents: vi.fn(async () => duplicateEvents),
      },
      decoder: decoderMock,
    });

    const result = await indexer.tick();
    expect(result.processed).toBe(2);
    expect(result.duplicates).toBe(1);
    expect(result.imported).toBe(1);
  });
});
