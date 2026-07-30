import { describe, it, expect, vi } from "vitest";
import { LedgerService } from "../src/services/ledger.js";
import { StellarIndexer, type HorizonEventSource, type XdrDecoder } from "../src/services/stellarIndexer.js";

describe("LedgerService.upsertPoolRegistryEntry Unit Tests (No Database Required) (#507)", () => {
  it("creates a new registry row keyed on poolAddress", async () => {
    const mockPrisma = {
      poolRegistry: { upsert: vi.fn(async () => ({})) }
    } as any;

    const ledger = new LedgerService(mockPrisma);
    await ledger.upsertPoolRegistryEntry({
      salt: "01",
      poolAddress: "CPOOL1",
      factoryAddress: "CFACTORY",
      admin: "GADMIN",
      asset: "GASSET",
      wasmHash: "ab12",
      deployedLedger: 100
    });

    expect(mockPrisma.poolRegistry.upsert).toHaveBeenCalledWith({
      where: { poolAddress: "CPOOL1" },
      create: {
        salt: "01",
        poolAddress: "CPOOL1",
        factoryAddress: "CFACTORY",
        admin: "GADMIN",
        asset: "GASSET",
        wasmHash: "ab12",
        deployedLedger: 100
      },
      update: {
        admin: "GADMIN",
        asset: "GASSET",
        wasmHash: "ab12"
      }
    });
  });

  it("is idempotent: replaying the same deployed event upserts rather than duplicating", async () => {
    const mockPrisma = {
      poolRegistry: { upsert: vi.fn(async () => ({})) }
    } as any;
    const ledger = new LedgerService(mockPrisma);

    const input = {
      salt: "01",
      poolAddress: "CPOOL1",
      factoryAddress: "CFACTORY",
      admin: "GADMIN",
      asset: "GASSET",
      wasmHash: "ab12",
      deployedLedger: 100
    };
    await ledger.upsertPoolRegistryEntry(input);
    await ledger.upsertPoolRegistryEntry(input);

    expect(mockPrisma.poolRegistry.upsert).toHaveBeenCalledTimes(2);
    expect(mockPrisma.poolRegistry.upsert.mock.calls[0]).toEqual(mockPrisma.poolRegistry.upsert.mock.calls[1]);
  });
});

describe("LedgerService.deactivatePoolRegistryEntry Unit Tests (#507)", () => {
  it("marks the row inactive by salt without touching other fields", async () => {
    const mockPrisma = {
      poolRegistry: { updateMany: vi.fn(async () => ({ count: 1 })) }
    } as any;

    const ledger = new LedgerService(mockPrisma);
    await ledger.deactivatePoolRegistryEntry("01");

    expect(mockPrisma.poolRegistry.updateMany).toHaveBeenCalledWith({
      where: { salt: "01" },
      data: { active: false }
    });
  });
});

describe("LedgerService.getActivePoolAddresses Unit Tests (#507)", () => {
  it("returns only active pool addresses", async () => {
    const mockPrisma = {
      poolRegistry: {
        findMany: vi.fn(async () => [{ poolAddress: "CPOOL1" }, { poolAddress: "CPOOL2" }])
      }
    } as any;

    const ledger = new LedgerService(mockPrisma);
    const addresses = await ledger.getActivePoolAddresses();

    expect(addresses).toEqual(["CPOOL1", "CPOOL2"]);
    expect(mockPrisma.poolRegistry.findMany).toHaveBeenCalledWith({
      where: { active: true },
      select: { poolAddress: true }
    });
  });

  it("returns an empty list when no pools are registered", async () => {
    const mockPrisma = {
      poolRegistry: { findMany: vi.fn(async () => []) }
    } as any;

    const ledger = new LedgerService(mockPrisma);
    expect(await ledger.getActivePoolAddresses()).toEqual([]);
  });
});

describe("StellarIndexer: factory_pool_deployed routing (#507)", () => {
  function makeRaw(overrides: Partial<{ id: string; ledger: number; txHash: string; contractId: string }> = {}) {
    return {
      id: overrides.id ?? "1",
      ledger: overrides.ledger ?? 100,
      txHash: overrides.txHash ?? "tx_deploy_1",
      contractId: overrides.contractId ?? "CFACTORY",
      topicXdr: ["ignored-by-fake-decoder"],
      valueXdr: "ignored-by-fake-decoder",
      successful: true
    };
  }

  function fakeSource(events: ReturnType<typeof makeRaw>[]): HorizonEventSource {
    return { async fetchEvents() { return events; } };
  }

  function fakeDecoder(payload: Record<string, unknown>): XdrDecoder {
    return { decode: () => payload };
  }

  it("routes a decoded fpooldep event to upsertPoolRegistryEntry, not reconcileEvent", async () => {
    const upsertPoolRegistryEntry = vi.fn(async () => {});
    const reconcileEvent = vi.fn(async () => ({ matched: false }));
    const ledger = { upsertPoolRegistryEntry, reconcileEvent } as any;

    const payload = {
      type: "fpooldep",
      salt: Buffer.from([1]),
      pool_address: "CPOOL1",
      admin: "GADMIN",
      asset: "GASSET",
      wasm_hash: Buffer.from([0xab, 0x12])
    };

    const indexer = new StellarIndexer({
      ledger,
      source: fakeSource([makeRaw()]),
      decoder: fakeDecoder(payload),
      factoryAddress: "CFACTORY"
    });

    const result = await indexer.tick();

    expect(reconcileEvent).not.toHaveBeenCalled();
    expect(upsertPoolRegistryEntry).toHaveBeenCalledWith({
      salt: "01",
      poolAddress: "CPOOL1",
      factoryAddress: "CFACTORY",
      admin: "GADMIN",
      asset: "GASSET",
      wasmHash: "ab12",
      deployedLedger: 100
    });
    expect(result.imported).toBe(1);
    expect(result.cursor).toBe("1");
  });

  it("does not upsert when the deploy event is reverted", async () => {
    const upsertPoolRegistryEntry = vi.fn(async () => {});
    const ledger = { upsertPoolRegistryEntry, reconcileEvent: vi.fn() } as any;

    const indexer = new StellarIndexer({
      ledger,
      source: fakeSource([{ ...makeRaw(), successful: false }]),
      decoder: fakeDecoder({ type: "fpooldep", salt: Buffer.from([1]), pool_address: "CPOOL1", admin: "G", asset: "G", wasm_hash: Buffer.from([1]) }),
      factoryAddress: "CFACTORY"
    });

    await indexer.tick();
    expect(upsertPoolRegistryEntry).not.toHaveBeenCalled();
  });

  it("logs and continues (does not throw) when the registry upsert fails", async () => {
    const upsertPoolRegistryEntry = vi.fn(async () => { throw new Error("db down"); });
    const ledger = { upsertPoolRegistryEntry, reconcileEvent: vi.fn() } as any;
    const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as any;

    const indexer = new StellarIndexer({
      ledger,
      source: fakeSource([makeRaw()]),
      decoder: fakeDecoder({ type: "fpooldep", salt: Buffer.from([1]), pool_address: "CPOOL1", admin: "G", asset: "G", wasm_hash: Buffer.from([1]) }),
      logger,
      factoryAddress: "CFACTORY"
    });

    const result = await indexer.tick();
    expect(logger.warn).toHaveBeenCalled();
    expect(result.cursor).toBe("1");
  });

  // #507 acceptance criteria: "spoofed pools" must be rejected. An event
  // whose topic matches fpooldep but was emitted by a contract OTHER than
  // the configured, trusted vault-factory must never be upserted into the
  // registry — its payload fields (pool_address/admin/asset/etc.) are
  // fully attacker-controlled and cannot be trusted just because the
  // event's topic string looks right.
  it("rejects (does not upsert) a fpooldep event emitted by a contract that is not the configured factory", async () => {
    const upsertPoolRegistryEntry = vi.fn(async () => {});
    const ledger = { upsertPoolRegistryEntry, reconcileEvent: vi.fn() } as any;
    const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as any;

    const indexer = new StellarIndexer({
      ledger,
      // The event is emitted by "CATTACKER", not the configured factory.
      source: fakeSource([makeRaw({ contractId: "CATTACKER" })]),
      decoder: fakeDecoder({
        type: "fpooldep",
        salt: Buffer.from([1]),
        pool_address: "CSPOOFED_POOL",
        admin: "GATTACKER",
        asset: "GATTACKER_ASSET",
        wasm_hash: Buffer.from([1])
      }),
      logger,
      factoryAddress: "CFACTORY"
    });

    const result = await indexer.tick();

    expect(upsertPoolRegistryEntry).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ contractId: "CATTACKER", expectedFactoryAddress: "CFACTORY" }),
      expect.stringContaining("spoofed")
    );
    // Cursor still advances so the (rejected) event isn't reprocessed forever.
    expect(result.cursor).toBe("1");
  });

  // Fail-closed: no configured factory address means NO fpooldep event is
  // ever trusted, not "trust whatever shows up."
  it("rejects a fpooldep event when no factoryAddress is configured at all", async () => {
    const upsertPoolRegistryEntry = vi.fn(async () => {});
    const ledger = { upsertPoolRegistryEntry, reconcileEvent: vi.fn() } as any;
    const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as any;

    const indexer = new StellarIndexer({
      ledger,
      source: fakeSource([makeRaw()]),
      decoder: fakeDecoder({ type: "fpooldep", salt: Buffer.from([1]), pool_address: "CPOOL1", admin: "G", asset: "G", wasm_hash: Buffer.from([1]) }),
      logger
      // factoryAddress intentionally omitted.
    });

    await indexer.tick();
    expect(upsertPoolRegistryEntry).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ contractId: "CFACTORY" }),
      expect.stringContaining("no factoryAddress is configured")
    );
  });
});

describe("StellarIndexer: contract-id refresh hook (#507)", () => {
  it("calls setContractIds with the resolved list before fetching, when the source supports it", async () => {
    const setContractIds = vi.fn();
    const fetchEvents = vi.fn(async () => []);
    const source = { fetchEvents, setContractIds } as unknown as HorizonEventSource;

    const ledger = { reconcileEvent: vi.fn(), upsertPoolRegistryEntry: vi.fn() } as any;
    const resolveContractIds = vi.fn(async () => ["CFACTORY", "CPOOL1"]);

    const indexer = new StellarIndexer({
      ledger,
      source,
      decoder: { decode: () => ({}) },
      resolveContractIds
    });

    await indexer.tick();

    expect(resolveContractIds).toHaveBeenCalled();
    expect(setContractIds).toHaveBeenCalledWith(["CFACTORY", "CPOOL1"]);
  });

  it("does not call setContractIds when the source doesn't expose it", async () => {
    const fetchEvents = vi.fn(async () => []);
    const source = { fetchEvents } as HorizonEventSource;
    const ledger = { reconcileEvent: vi.fn(), upsertPoolRegistryEntry: vi.fn() } as any;
    const resolveContractIds = vi.fn(async () => ["CFACTORY"]);

    const indexer = new StellarIndexer({
      ledger,
      source,
      decoder: { decode: () => ({}) },
      resolveContractIds
    });

    await expect(indexer.tick()).resolves.toBeDefined();
  });

  it("keeps the previous contract-id list when resolveContractIds throws", async () => {
    const setContractIds = vi.fn();
    const fetchEvents = vi.fn(async () => []);
    const source = { fetchEvents, setContractIds } as unknown as HorizonEventSource;
    const ledger = { reconcileEvent: vi.fn(), upsertPoolRegistryEntry: vi.fn() } as any;
    const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as any;

    const indexer = new StellarIndexer({
      ledger,
      source,
      decoder: { decode: () => ({}) },
      resolveContractIds: async () => { throw new Error("db down"); },
      logger
    });

    await indexer.tick();
    expect(setContractIds).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });
});
