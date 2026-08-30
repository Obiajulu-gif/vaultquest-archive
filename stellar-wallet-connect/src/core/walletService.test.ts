import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  setConnection,
  disconnect,
  getWalletHealth,
  setHorizonPool,
} from "./walletService.js";
import { vaultQueryClient } from "../vault/data/queryClient.js";
import { HorizonPool } from "./horizonPool.js";

// Mock dependencies
vi.mock("../vault/data/queryClient.js", () => {
  return {
    vaultQueryClient: {
      clear: vi.fn(),
    },
  };
});

vi.mock("./kit.js", () => ({
  kit: {
    getNetwork: vi.fn().mockResolvedValue({ network: "TESTNET" }),
  }
}));

describe("walletService - Account Switching (#409)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    disconnect();
  });

  it("should reset user-scoped state when switching accounts rapidly", () => {
    // Set some dummy data in localStorage for pending tx state
    localStorage.setItem("vaultquest_pending_tx_state", JSON.stringify({ pending: true }));

    // Connect wallet A
    setConnection("G_WALLET_A", "freighter");

    // Initially, clear shouldn't be called for a fresh connection
    expect(vaultQueryClient.clear).not.toHaveBeenCalled();
    expect(localStorage.getItem("vaultquest_pending_tx_state")).toBeTruthy();

    // Switch to wallet B
    setConnection("G_WALLET_B", "freighter");

    // Clear MUST be called to abort in-flight requests and drop stale caches
    expect(vaultQueryClient.clear).toHaveBeenCalledTimes(1);
    
    // Pending tx state for the old wallet MUST be removed
    expect(localStorage.getItem("vaultquest_pending_tx_state")).toBeNull();
    
    // Ensure the new connection is stored properly
    expect(localStorage.getItem("publicKey")).toBe("G_WALLET_B");
  });
});

// #626: the balance read that feeds funding/deposit decisions must be a
// critical read, not a best-effort UI refresh.
describe("walletService - getWalletHealth criticality (#626)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    disconnect();
    setHorizonPool(undefined);
    // getWalletHealth() reads getFrontendEnv() internally to resolve the
    // Horizon URL; stub the required vars so it doesn't throw before ever
    // reaching the pool call under test.
    vi.stubEnv("NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID", "test-project-id");
    vi.stubEnv("NEXT_PUBLIC_SOROBAN_NETWORK_PASSPHRASE", "Test SDF Network ; September 2015");
    vi.stubEnv("NEXT_PUBLIC_HORIZON_URL", "https://horizon-testnet.stellar.org");
    vi.stubEnv("NEXT_PUBLIC_SOROBAN_RPC_URL", "https://soroban-testnet.stellar.org");
    vi.stubEnv("NEXT_PUBLIC_DRIP_POOL_CONTRACT_ID", "CDRIPPOOLCONTRACTID");
    vi.stubEnv("NEXT_PUBLIC_VAULT_ASSET_CODE", "USDC");
    vi.stubEnv(
      "NEXT_PUBLIC_VAULT_ASSET_ISSUER",
      "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("requests the account balance as a critical read", async () => {
    setConnection("G_WALLET_A", "freighter");

    const requestSpy = vi.fn(async () =>
      new Response(JSON.stringify({ balances: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    setHorizonPool({ request: requestSpy } as unknown as HorizonPool);

    await getWalletHealth();

    expect(requestSpy).toHaveBeenCalledTimes(1);
    const [path, init] = requestSpy.mock.calls[0]!;
    expect(path).toBe("/accounts/G_WALLET_A");
    expect((init as { criticality?: string }).criticality).toBe("critical");
  });

  it("returns exists:false without throwing when the pool cannot satisfy the critical read", async () => {
    setConnection("G_WALLET_A", "freighter");
    setHorizonPool({
      request: vi.fn(async () => {
        throw new Error("HorizonPool: request to /accounts/G_WALLET_A failed after 3 attempts");
      }),
    } as unknown as HorizonPool);

    const health = await getWalletHealth();

    expect(health).toEqual({ exists: false, balances: { XLM: 0, USDC: 0 } });
  });
});
