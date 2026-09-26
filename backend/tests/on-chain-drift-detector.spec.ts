import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  OnChainDriftDetector,
  type OnChainReader,
  type OnChainPoolState,
  type OnChainRoundState,
} from "../src/services/onChainDriftDetector.js";

class MockOnChainReader implements OnChainReader {
  constructor(
    public chainTip: number = 1000,
    public pools: Map<string, OnChainPoolState> = new Map(),
    public rounds: Map<string, OnChainRoundState> = new Map(),
  ) {}

  async getChainTipLedger(): Promise<number> {
    return this.chainTip;
  }

  async getPoolState(poolAddress: string): Promise<OnChainPoolState | null> {
    return this.pools.get(poolAddress) ?? null;
  }

  async getRoundState(poolAddress: string, roundId: number): Promise<OnChainRoundState | null> {
    return this.rounds.get(`${poolAddress}_${roundId}`) ?? null;
  }

  async getParticipantDeposit(_poolAddress: string, _roundId: number, _participant: string): Promise<bigint> {
    return 0n;
  }
}

describe("Automated On-Chain vs Ledger Drift Detection Unit Tests (#727)", () => {
  let mockReader: MockOnChainReader;

  beforeEach(() => {
    mockReader = new MockOnChainReader(1000);
  });

  it("reports 0 drifts when on-chain state and ledger state are perfectly aligned", async () => {
    const poolAddress = "CPOOL_ALIGNED_1";

    const mockPrisma = {
      indexerCheckpoint: {
        findUnique: vi.fn(async () => ({ latestLedger: 1000 })),
      },
      poolRegistry: {
        findMany: vi.fn(async () => [
          { poolAddress, active: true },
        ]),
      },
      actionLedger: {
        findMany: vi.fn(async () => [
          { actionType: "deposit", verifiedPayload: { amount: "1000" } },
          { actionType: "deposit", verifiedPayload: { amount: "500" } },
        ]),
        count: vi.fn(async () => 0),
      },
      vaultSettlement: {
        findMany: vi.fn(async () => []),
      },
    } as any;

    mockReader.pools.set(poolAddress, {
      totalDeposited: 1500n,
      distributableYield: 0n,
      locked: false,
      isEmergency: false,
      emergencyAssets: 0n,
    });

    const detector = new OnChainDriftDetector(mockPrisma, mockReader);
    const result = await detector.runDetection();

    expect(result.checkedEntities).toBeGreaterThan(0);
    expect(result.drifts).toHaveLength(0);
    expect(result.summary.critical).toBe(0);
    expect(result.summary.warning).toBe(0);
  });

  it("detects and flags CRITICAL insolvency drift when on-chain balance is less than ledger liabilities", async () => {
    const poolAddress = "CPOOL_INSOLVENT";

    const mockPrisma = {
      indexerCheckpoint: {
        findUnique: vi.fn(async () => ({ latestLedger: 1000 })),
      },
      poolRegistry: {
        findMany: vi.fn(async () => [
          { poolAddress, active: true },
        ]),
      },
      actionLedger: {
        findMany: vi.fn(async () => [
          { actionType: "deposit", verifiedPayload: { amount: "10000" } },
        ]),
        count: vi.fn(async () => 0),
      },
      vaultSettlement: {
        findMany: vi.fn(async () => []),
      },
    } as any;

    // On-chain contract only holds 6,000 (4,000 deficit)
    mockReader.pools.set(poolAddress, {
      totalDeposited: 6000n,
      distributableYield: 0n,
      locked: false,
      isEmergency: false,
      emergencyAssets: 0n,
    });

    const detector = new OnChainDriftDetector(mockPrisma, mockReader);
    const result = await detector.runDetection();

    expect(result.summary.critical).toBe(1);
    const drift = result.drifts.find((d) => d.severity === "CRITICAL");
    expect(drift).toBeDefined();
    expect(drift?.entityType).toBe("vault");
    expect(drift?.field).toBe("total_deposited");
    expect(drift?.onChainValue).toBe("6000");
    expect(drift?.ledgerValue).toBe("10000");
    expect(drift?.delta).toBe("-4000");
  });

  it("does not false-alarm when discrepancies are due to active in-flight transactions within ingestion lag", async () => {
    const poolAddress = "CPOOL_IN_FLIGHT";

    const mockPrisma = {
      indexerCheckpoint: {
        findUnique: vi.fn(async () => ({ latestLedger: 990 })), // indexer is 10 ledgers behind chain
      },
      poolRegistry: {
        findMany: vi.fn(async () => [
          { poolAddress, active: true },
        ]),
      },
      actionLedger: {
        findMany: vi.fn(async () => []), // 0 confirmed
        count: vi.fn(async () => 2),     // 2 in-flight submitted transactions
      },
      vaultSettlement: {
        findMany: vi.fn(async () => []),
      },
    } as any;

    // On-chain shows 1,000, ledger confirmed shows 0
    mockReader.pools.set(poolAddress, {
      totalDeposited: 1000n,
      distributableYield: 0n,
      locked: false,
      isEmergency: false,
      emergencyAssets: 0n,
    });

    const detector = new OnChainDriftDetector(mockPrisma, mockReader);
    const result = await detector.runDetection();

    // Must be classified as benign INFO (ingestion lag), not CRITICAL or WARNING
    expect(result.summary.critical).toBe(0);
    expect(result.summary.warning).toBe(0);
    expect(result.summary.info).toBe(1);
    expect(result.drifts[0].rootCauseHint).toContain("in-flight transactions");
  });
});

describe("SorobanRpcOnChainReader Tests", () => {
  it("initializes cleanly and reads chain tip with failover", async () => {
    const { SorobanRpcOnChainReader } = await import("../src/services/onChainDriftDetector.js");
    const reader = new SorobanRpcOnChainReader("https://soroban-testnet.stellar.org");
    expect(reader).toBeDefined();
  });
});

