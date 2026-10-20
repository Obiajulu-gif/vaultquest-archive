import { describe, expect, it } from "vitest";
import { createSandboxVaultClient, SANDBOX_POOL } from "./sandboxClient";
import { ContractInterfaceError } from "./types";
import { SAMPLE_ADDRESS } from "./mockClient";

describe("createSandboxVaultClient", () => {
  it("runs successful wallet actions without a connected real wallet", async () => {
    const first = createSandboxVaultClient();
    const second = createSandboxVaultClient();
    expect(first.getConnectedAddress()).toBe(SAMPLE_ADDRESS);
    expect(await first.getPool(SANDBOX_POOL.id)).toEqual(SANDBOX_POOL);

    const input = { poolId: SANDBOX_POOL.id, walletAddress: SAMPLE_ADDRESS, amount: "10.00" };
    const resultA = await first.submitAction("drip", input);
    const resultB = await second.submitAction("drip", input);
    expect(resultA).toEqual(resultB);
    expect(resultA.txHash).toBe("sandbox_tx_drip_sandbox-prize-vault_10_00");
  });

  it("scripts disconnected, signature, RPC, contract, and stale-read failures", async () => {
    const disconnected = createSandboxVaultClient("wallet_disconnected");
    expect(disconnected.isWalletConnected()).toBe(false);
    await expect(disconnected.submitAction("join", { poolId: SANDBOX_POOL.id, walletAddress: SAMPLE_ADDRESS }))
      .rejects.toMatchObject({ kind: "wallet_disconnected" });

    for (const [scenario, kind] of [
      ["signature_rejected", "signature_rejected"],
      ["rpc_failure", "rpc_failure"],
      ["contract_error", "contract_error"]
    ] as const) {
      await expect(createSandboxVaultClient(scenario).submitAction("claim", {
        poolId: SANDBOX_POOL.id,
        walletAddress: SAMPLE_ADDRESS
      })).rejects.toMatchObject({ kind });
    }

    await expect(createSandboxVaultClient("stale_data").getPool(SANDBOX_POOL.id))
      .rejects.toBeInstanceOf(ContractInterfaceError);
  });
});