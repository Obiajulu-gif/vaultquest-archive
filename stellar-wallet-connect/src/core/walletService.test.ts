import { describe, it, expect, vi, beforeEach } from "vitest";
import { setConnection, disconnect } from "./walletService.js";
import { vaultQueryClient } from "../vault/data/queryClient.js";

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
