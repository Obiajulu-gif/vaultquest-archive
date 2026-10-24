import {
  ContractInterfaceError,
  type PoolSummary,
  type PoolActionType,
  type VaultContractClient
} from "./types";
import { createMockVaultClient, SAMPLE_ADDRESS } from "./mockClient";

export const SANDBOX_VAULT_SCENARIOS = [
  "success",
  "wallet_disconnected",
  "signature_rejected",
  "rpc_failure",
  "contract_error",
  "stale_data"
] as const;

export type SandboxVaultScenario = (typeof SANDBOX_VAULT_SCENARIOS)[number];

export const SANDBOX_POOL: PoolSummary = {
  id: "sandbox-prize-vault",
  name: "Local Prize Vault",
  status: "open",
  tvl: "1000.00",
  asset: "USDC",
  participantCount: 12,
  expectedYield: "5.0% APY",
  prize: "25.00 USDC",
  opensAt: "2026-01-01T00:00:00.000Z",
  locksAt: "2026-12-01T00:00:00.000Z",
  drawsAt: "2026-12-02T00:00:00.000Z",
  lockupDays: 30,
  feeBps: 0
};

const ACTION_FAILURES: Partial<Record<SandboxVaultScenario, ContractInterfaceError["kind"]>> = {
  signature_rejected: "signature_rejected",
  rpc_failure: "rpc_failure",
  contract_error: "contract_error"
};

export function createSandboxVaultClient(scenario: SandboxVaultScenario = "success"): VaultContractClient {
  return createMockVaultClient({
    connected: scenario !== "wallet_disconnected",
    address: SAMPLE_ADDRESS,
    pools: { [SANDBOX_POOL.id]: SANDBOX_POOL },
    positions: {
      [SANDBOX_POOL.id]: {
        walletAddress: SAMPLE_ADDRESS,
        deposited: "100.00",
        shares: "100.00",
        joined: true
      }
    },
    failReads: scenario === "stale_data" ? "stale_data" : undefined,
    failActions: ACTION_FAILURES[scenario]
      ? Object.fromEntries(
          (["create", "join", "drip", "claim", "withdraw"] as PoolActionType[])
            .map((action) => [action, ACTION_FAILURES[scenario]])
        )
      : undefined,
    currentLedger: 10_000,
    lockupWindows: {},
    txHashFactory: (type, input) => {
      const amount = input.amount ?? "none";
      const key = `${type}_${input.poolId}_${amount}`.replace(/[^a-zA-Z0-9_-]/g, "_");
      return `sandbox_tx_${key}`;
    }
  });
}