/**
 * Test fixtures for deterministic trend aggregation
 *
 * Provides deterministic test data for:
 * - Multiple time windows
 * - Various metric types
 * - Edge cases (empty data, single record, etc.)
 */

import type { TrendMetric, AggregationWindow } from "../src/services/trendAggregationService";

/**
 * Fixed date windows for deterministic testing
 */
export const TEST_WINDOWS = {
  singleDay: {
    start: new Date("2024-01-01T00:00:00Z"),
    end: new Date("2024-01-01T23:59:59Z"),
  },
  threeDays: {
    start: new Date("2024-01-01T00:00:00Z"),
    end: new Date("2024-01-03T23:59:59Z"),
  },
  oneWeek: {
    start: new Date("2024-01-01T00:00:00:00Z"),
    end: new Date("2024-01-07T23:59:59Z"),
  },
};

/**
 * Mock action ledger data for testing
 */
export const MOCK_ACTION_LEDGER = {
  deposits: [
    {
      id: "1",
      actionType: "deposit",
      status: "confirmed",
      actionPayload: { amount: 100, poolId: "pool-1" },
      walletAddress: "wallet-abc123",
      createdAt: new Date("2024-01-01T10:00:00Z"),
      updatedAt: new Date("2024-01-01T10:05:00Z"),
      confirmedAt: new Date("2024-01-01T10:10:00Z"),
    },
    {
      id: "2",
      actionType: "deposit",
      status: "confirmed",
      actionPayload: { amount: 200, poolId: "pool-1" },
      walletAddress: "wallet-def456",
      createdAt: new Date("2024-01-01T14:00:00Z"),
      updatedAt: new Date("2024-01-01T14:05:00Z"),
      confirmedAt: new Date("2024-01-01T14:10:00Z"),
    },
    {
      id: "3",
      actionType: "deposit",
      status: "confirmed",
      actionPayload: { amount: 150, poolId: "pool-2" },
      walletAddress: "wallet-abc123",
      createdAt: new Date("2024-01-02T09:00:00Z"),
      updatedAt: new Date("2024-01-02T09:05:00Z"),
      confirmedAt: new Date("2024-01-02T09:10:00Z"),
    },
  ],
  withdrawals: [
    {
      id: "4",
      actionType: "withdraw",
      status: "confirmed",
      actionPayload: { amount: 50, poolId: "pool-1" },
      walletAddress: "wallet-abc123",
      createdAt: new Date("2024-01-01T16:00:00Z"),
      updatedAt: new Date("2024-01-01T16:05:00Z"),
      confirmedAt: new Date("2024-01-01T16:10:00Z"),
    },
  ],
  claims: [
    {
      id: "5",
      actionType: "claim",
      status: "confirmed",
      actionPayload: { amount: 75, poolId: "pool-1" },
      walletAddress: "wallet-abc123",
      createdAt: new Date("2024-01-01T18:00:00Z"),
      updatedAt: new Date("2024-01-01T18:05:00Z"),
      confirmedAt: new Date("2024-01-01T18:10:00Z"),
    },
  ],
  failed: [
    {
      id: "6",
      actionType: "deposit",
      status: "failed",
      errorCode: "NETWORK_ERROR",
      actionPayload: { amount: 100, poolId: "pool-1" },
      walletAddress: "wallet-xyz789",
      createdAt: new Date("2024-01-01T20:00:00Z"),
      updatedAt: new Date("2024-01-01T20:05:00Z"),
    },
    {
      id: "7",
      actionType: "withdraw",
      status: "reverted",
      errorCode: "CONTRACT_ERROR",
      actionPayload: { amount: 50, poolId: "pool-1" },
      walletAddress: "wallet-abc123",
      createdAt: new Date("2024-01-02T12:00:00Z"),
      updatedAt: new Date("2024-01-02T12:05:00Z"),
    },
  ],
  conflict: [
    {
      id: "8",
      actionType: "deposit",
      status: "failed",
      errorCode: "VAULT_CONCURRENT_MODIFICATION",
      actionPayload: { amount: 100, poolId: "pool-1" },
      walletAddress: "wallet-abc123",
      createdAt: new Date("2024-01-01T22:00:00Z"),
      updatedAt: new Date("2024-01-01T22:05:00Z"),
    },
  ],
  retried: [
    {
      id: "9",
      actionType: "deposit",
      status: "confirmed",
      retryCount: 2,
      actionPayload: { amount: 100, poolId: "pool-1" },
      walletAddress: "wallet-abc123",
      createdAt: new Date("2024-01-01T23:00:00Z"),
      updatedAt: new Date("2024-01-01T23:05:00Z"),
      confirmedAt: new Date("2024-01-01T23:10:00Z"),
    },
  ],
};

/**
 * Mock saved pool data for testing
 */
export const MOCK_SAVED_POOLS = {
  active: [
    {
      id: "pool-1",
      walletAddress: "wallet-abc123",
      poolId: "pool-1",
      poolName: "Pool 1",
      status: "active",
      tvl: "5000.00",
      asset: "USDC",
      participantCount: 10,
      expectedYield: "5.0%",
      prize: "100.00",
      opensAt: new Date("2024-01-01T00:00:00Z"),
      locksAt: new Date("2024-01-01T12:00:00Z"),
      drawsAt: new Date("2024-01-01T18:00:00Z"),
      createdAt: new Date("2024-01-01T00:00:00Z"),
      updatedAt: new Date("2024-01-01T00:00:00Z"),
    },
    {
      id: "pool-2",
      walletAddress: "wallet-def456",
      poolId: "pool-2",
      poolName: "Pool 2",
      status: "active",
      tvl: "3000.00",
      asset: "USDC",
      participantCount: 5,
      expectedYield: "4.5%",
      prize: "75.00",
      opensAt: new Date("2024-01-01T00:00:00Z"),
      locksAt: new Date("2024-01-01T12:00:00:00Z"),
      drawsAt: new Date("2024-01-01T18:00:00:00Z"),
      createdAt: new Date("2024-01-01T00:00:00Z"),
      updatedAt: new Date("2024-01-01T00:00:00Z"),
    },
  ],
  inactive: [
    {
      id: "pool-3",
      walletAddress: "wallet-ghi789",
      poolId: "pool-3",
      poolName: "Pool 3",
      status: "closed",
      tvl: "1000.00",
      asset: "USDC",
      participantCount: 3,
      expectedYield: "3.0%",
      prize: "25.00",
      opensAt: new Date("2024-01-01T00:00:00Z"),
      locksAt: new Date("2024-01-01T12:00:00:00Z"),
      drawsAt: new Date("2024-01-01T18:00:00:00Z"),
      createdAt: new Date("2024-01-01T00:00:00Z"),
      updatedAt: new Date("2024-01-01T00:00:00Z"),
    },
  ],
};

/**
 * Expected aggregation results for deterministic testing
 */
export const EXPECTED_AGGREGATIONS = {
  total_deposits: {
    singleDay: {
      value: 450, // 100 + 200 + 150
      count: 3,
    },
    threeDays: {
      value: 450,
      count: 3,
    },
  },
  total_withdrawals: {
    singleDay: {
      value: 50,
      count: 1,
    },
  },
  total_claims: {
    singleDay: {
      value: 75,
      count: 1,
    },
  },
  failed_transactions: {
    singleDay: {
      value: 2,
      count: 2,
    },
  },
  active_users: {
    singleDay: {
      value: 2, // wallet-abc123, wallet-def456
      count: 2,
    },
  },
  pool_count: {
    singleDay: {
      value: 2, // 2 active pools
      count: 3, // 3 total pools created
    },
  },
  total_tvl: {
    singleDay: {
      value: 8000, // 5000 + 3000
      count: 2,
    },
  },
  prize_distributed: {
    singleDay: {
      value: 75,
      count: 1,
    },
  },
  recovery_actions: {
    singleDay: {
      value: 1, // 1 retried action
      count: 1,
    },
  },
  conflict_resolutions: {
    singleDay: {
      value: 1, // 1 conflict
      count: 1,
    },
  },
};

/**
 * Empty dataset for edge case testing
 */
export const EMPTY_DATASET = {
  deposits: [],
  withdrawals: [],
  claims: [],
  failed: [],
  conflict: [],
  retried: [],
  savedPools: [],
};

/**
 * Single record dataset for edge case testing
 */
export const SINGLE_RECORD_DATASET = {
  deposits: [
    {
      id: "1",
      actionType: "deposit",
      status: "confirmed",
      actionPayload: { amount: 100, poolId: "pool-1" },
      walletAddress: "wallet-abc123",
      createdAt: new Date("2024-01-01T10:00:00Z"),
      updatedAt: new Date("2024-01-01T10:05:00Z"),
      confirmedAt: new Date("2024-01-01T10:10:00Z"),
    },
  ],
  withdrawals: [],
  claims: [],
  failed: [],
  conflict: [],
  retried: [],
  savedPools: MOCK_SAVED_POOLS.active,
};

/**
 * Large dataset for performance testing
 */
export function generateLargeDataset(count: number = 1000) {
  const deposits = [];
  for (let i = 0; i < count; i++) {
    deposits.push({
      id: `deposit-${i}`,
      actionType: "deposit",
      status: "confirmed",
      actionPayload: { amount: 10, poolId: `pool-${i % 10}` },
      walletAddress: `wallet-${i % 100}`,
      createdAt: new Date(`2024-01-01T${String(i).padStart(2, "0")}:00:00Z`),
      updatedAt: new Date(`2024-01-01T${String(i).padStart(2, "0")}:05:00Z`),
      confirmedAt: new Date(`2024-01-01T${String(i).padStart(2, "0")}:10:00Z`),
    });
  }
  return { deposits, withdrawals: [], claims: [], failed: [], conflict: [], retried: [], savedPools: [] };
}

/**
 * Privacy-sensitive data for redaction testing
 */
export const PRIVACY_SENSITIVE_DATA = {
  withPersonalInfo: {
    walletAddress: "GD5PQZ...XYZ123ABC",
    email: "user@example.com",
    privateKey: "SABC...XYZ",
    seedPhrase: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    amount: 100,
  },
  withPartialSensitive: {
    walletAddress: "GD5PQZ...XYZ123ABC",
    amount: 100,
  },
  withoutSensitive: {
    amount: 100,
    poolId: "pool-1",
  },
};

/**
 * Expected redacted data
 */
export const EXPECTED_REDACTED = {
  withPersonalInfo: {
    // walletAddress should be hashed
    // email should be redacted
    // privateKey should be redacted
    // seedPhrase should be redacted
    amount: 100,
  },
  withPartialSensitive: {
    // walletAddress should be hashed
    amount: 100,
  },
  withoutSensitive: {
    amount: 100,
    poolId: "pool-1",
  },
};
