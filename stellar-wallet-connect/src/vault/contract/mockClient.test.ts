import { describe, it, expect } from "vitest";
import { createMockVaultClient, SAMPLE_ADDRESS } from "./mockClient";
import { ContractInterfaceError, type PoolActionType, type PoolSummary } from "./types";

const pool: PoolSummary = {
  id: "pool-1",
  name: "Weekly USDC",
  status: "open",
  tvl: "10000",
  asset: "USDC",
  participantCount: 12,
  expectedYield: "5.2% APY",
  opensAt: "2026-05-01T00:00:00Z",
  locksAt: "2026-05-08T00:00:00Z",
  drawsAt: "2026-05-09T00:00:00Z",
};

const ALL_ACTIONS: PoolActionType[] = ["create", "join", "drip", "claim", "withdraw"];

describe("mock VaultContractClient — wallet connection", () => {
  it("reports a connected wallet and address", () => {
    const client = createMockVaultClient({ connected: true, address: SAMPLE_ADDRESS });
    expect(client.isWalletConnected()).toBe(true);
    expect(client.getConnectedAddress()).toBe(SAMPLE_ADDRESS);
  });

  it("reports a disconnected wallet", () => {
    const client = createMockVaultClient({ connected: false });
    expect(client.isWalletConnected()).toBe(false);
    expect(client.getConnectedAddress()).toBeNull();
  });
});

describe("mock VaultContractClient — write flows", () => {
  it("submits each action when connected and returns a tx hash", async () => {
    const client = createMockVaultClient({ connected: true });
    for (const type of ALL_ACTIONS) {
      const result = await client.submitAction(type, { poolId: "pool-1", walletAddress: SAMPLE_ADDRESS, amount: "100" });
      expect(result.status).toBe("submitted");
      expect(result.txHash).toContain(type);
    }
  });

  it("rejects writes when the wallet is disconnected", async () => {
    const client = createMockVaultClient({ connected: false });
    await expect(client.submitAction("join", { poolId: "pool-1", walletAddress: SAMPLE_ADDRESS }))
      .rejects.toMatchObject({ kind: "wallet_disconnected" });
  });

  it("surfaces a rejected signature", async () => {
    const client = createMockVaultClient({ failActions: { join: "signature_rejected" } });
    await expect(client.submitAction("join", { poolId: "pool-1", walletAddress: SAMPLE_ADDRESS }))
      .rejects.toMatchObject({ kind: "signature_rejected" });
  });

  it("surfaces an RPC failure on submission", async () => {
    const client = createMockVaultClient({ failActions: { withdraw: "rpc_failure" } });
    await expect(client.submitAction("withdraw", { poolId: "pool-1", walletAddress: SAMPLE_ADDRESS }))
      .rejects.toMatchObject({ kind: "rpc_failure" });
  });

  it("surfaces a contract error on submission", async () => {
    const client = createMockVaultClient({ failActions: { claim: "contract_error" } });
    await expect(client.submitAction("claim", { poolId: "pool-1", walletAddress: SAMPLE_ADDRESS }))
      .rejects.toBeInstanceOf(ContractInterfaceError);
  });
});

describe("mock VaultContractClient — read flows", () => {
  it("returns pool data and user position", async () => {
    const client = createMockVaultClient({
      pools: { "pool-1": pool },
      positions: { "pool-1": { walletAddress: SAMPLE_ADDRESS, deposited: "500", shares: "500", joined: true } },
    });
    expect(await client.getPool("pool-1")).toEqual(pool);
    expect(await client.listPools!()).toEqual([pool]);
    const position = await client.getUserPosition("pool-1");
    expect(position?.joined).toBe(true);
  });

  it("throws a contract error for an unknown pool", async () => {
    const client = createMockVaultClient({ pools: {} });
    await expect(client.getPool("missing")).rejects.toMatchObject({ kind: "contract_error" });
  });

  it("propagates an injected RPC failure on reads", async () => {
    const client = createMockVaultClient({ failReads: "rpc_failure", pools: { "pool-1": pool } });
    await expect(client.getPool("pool-1")).rejects.toMatchObject({ kind: "rpc_failure" });
  });

  it("propagates a stale-data signal on reads", async () => {
    const client = createMockVaultClient({ failReads: "stale_data" });
    await expect(client.listRewardHistory(SAMPLE_ADDRESS)).rejects.toMatchObject({ kind: "stale_data" });
  });

  it("returns reward history rows", async () => {
    const client = createMockVaultClient({
      rewardHistory: [
        {
          id: "r1",
          poolId: "pool-1",
          poolName: "Weekly USDC",
          cycleEndedAt: "2026-05-09T00:00:00Z",
          rewardAmount: "42",
          asset: "USDC",
          status: "won",
          winnerAddress: SAMPLE_ADDRESS,
          txHash: "abc123",
        },
      ],
    });
    const rows = await client.listRewardHistory(SAMPLE_ADDRESS);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("won");
  });
});
