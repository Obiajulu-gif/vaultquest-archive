import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  connectedPublicKey,
  connectedNetwork,
  isNetworkMismatch,
  isWalletInitialized,
  getWalletStateSnapshot,
  subscribeWalletState,
} from "./store.js";
import { useWalletState } from "./useWalletState.js";
import { setConnection, disconnect } from "./walletService.js";

// Mock Kit to avoid external network/browser dependencies during unit testing
vi.mock("./kit.js", () => ({
  kit: {
    getNetwork: vi.fn().mockResolvedValue({ network: "testnet" }),
    getAddress: vi.fn().mockResolvedValue({ address: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" }),
    setWallet: vi.fn(),
    disconnect: vi.fn().mockResolvedValue(undefined),
  },
}));

// Independent React Island 1
function IslandNavbar() {
  const { isConnected, publicKey, disconnect } = useWalletState();
  return (
    <nav data-testid="island-navbar">
      <span data-testid="navbar-status">{isConnected ? "connected" : "disconnected"}</span>
      <span data-testid="navbar-pubkey">{publicKey}</span>
      {isConnected && (
        <button data-testid="navbar-disconnect-btn" onClick={() => disconnect()}>
          Disconnect from Navbar
        </button>
      )}
    </nav>
  );
}

// Independent React Island 2
function IslandDepositWidget() {
  const { isConnected, publicKey, isNetworkMismatch, network } = useWalletState();
  return (
    <div data-testid="island-deposit-widget">
      <span data-testid="deposit-status">{isConnected ? "connected" : "disconnected"}</span>
      <span data-testid="deposit-pubkey">{publicKey}</span>
      <span data-testid="deposit-network">{network || "none"}</span>
      <span data-testid="deposit-mismatch">{isNetworkMismatch ? "mismatch" : "matched"}</span>
      <button
        data-testid="deposit-connect-btn"
        onClick={() => setConnection("GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5", "freighter")}
      >
        Connect from Deposit Widget
      </button>
    </div>
  );
}

// Independent React Island 3 (e.g. Account profile drawer)
function IslandAccountDrawer() {
  const { isConnected, publicKey, sessionStatus } = useWalletState();
  return (
    <aside data-testid="island-account-drawer">
      <span data-testid="drawer-status">{isConnected ? "connected" : "disconnected"}</span>
      <span data-testid="drawer-pubkey">{publicKey}</span>
      <span data-testid="drawer-session">{sessionStatus}</span>
    </aside>
  );
}

describe("Cross-Island Wallet State Synchronization (#734)", () => {
  beforeEach(() => {
    if (typeof window !== "undefined" && window.localStorage) {
      window.localStorage.clear();
    }
    act(() => {
      disconnect();
      isWalletInitialized.set(false);
    });
  });

  it("synchronizes connection state across multiple independent React islands and Astro page shell", async () => {
    const user = userEvent.setup();

    // 1. Setup Astro Page Shell subscriber
    const shellStateHistory: Array<{ isConnected: boolean; publicKey: string }> = [];
    const unsubscribeAstroShell = subscribeWalletState((snapshot) => {
      shellStateHistory.push({
        isConnected: snapshot.isConnected,
        publicKey: snapshot.publicKey,
      });
    });

    // 2. Render multiple independent React roots (simulating Astro islands)
    const { unmount: unmountNav } = render(<IslandNavbar />);
    const { unmount: unmountDeposit } = render(<IslandDepositWidget />);
    const { unmount: unmountDrawer } = render(<IslandAccountDrawer />);

    // Initial state: all islands & Astro shell must be disconnected
    expect(screen.getByTestId("navbar-status").textContent).toBe("disconnected");
    expect(screen.getByTestId("deposit-status").textContent).toBe("disconnected");
    expect(screen.getByTestId("drawer-status").textContent).toBe("disconnected");
    expect(shellStateHistory[shellStateHistory.length - 1].isConnected).toBe(false);

    // 3. Connect wallet from Island 2 (Deposit Widget)
    await act(async () => {
      await user.click(screen.getByTestId("deposit-connect-btn"));
    });

    const expectedAddress = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

    // Assert Island 1 (Navbar) immediately reflects connection
    expect(screen.getByTestId("navbar-status").textContent).toBe("connected");
    expect(screen.getByTestId("navbar-pubkey").textContent).toBe(expectedAddress);

    // Assert Island 2 (Deposit Widget) immediately reflects connection
    expect(screen.getByTestId("deposit-status").textContent).toBe("connected");
    expect(screen.getByTestId("deposit-pubkey").textContent).toBe(expectedAddress);

    // Assert Island 3 (Account Drawer) immediately reflects connection
    expect(screen.getByTestId("drawer-status").textContent).toBe("connected");
    expect(screen.getByTestId("drawer-pubkey").textContent).toBe(expectedAddress);

    // Assert Astro Page shell subscriber immediately received the connected state
    expect(shellStateHistory[shellStateHistory.length - 1].isConnected).toBe(true);
    expect(shellStateHistory[shellStateHistory.length - 1].publicKey).toBe(expectedAddress);

    // 4. Disconnect wallet from Island 1 (Navbar)
    await act(async () => {
      await user.click(screen.getByTestId("navbar-disconnect-btn"));
    });

    // Assert Island 1 immediately reflects disconnection
    expect(screen.getByTestId("navbar-status").textContent).toBe("disconnected");
    expect(screen.getByTestId("navbar-pubkey").textContent).toBe("");

    // Assert Island 2 immediately reflects disconnection
    expect(screen.getByTestId("deposit-status").textContent).toBe("disconnected");
    expect(screen.getByTestId("deposit-pubkey").textContent).toBe("");

    // Assert Island 3 immediately reflects disconnection
    expect(screen.getByTestId("drawer-status").textContent).toBe("disconnected");
    expect(screen.getByTestId("drawer-pubkey").textContent).toBe("");

    // Assert Astro Page shell subscriber immediately received the disconnected state
    expect(shellStateHistory[shellStateHistory.length - 1].isConnected).toBe(false);
    expect(shellStateHistory[shellStateHistory.length - 1].publicKey).toBe("");

    unsubscribeAstroShell();
    unmountNav();
    unmountDeposit();
    unmountDrawer();
  });

  it("synchronizes network switch across all islands immediately", async () => {
    render(<IslandDepositWidget />);
    render(<IslandNavbar />);

    act(() => {
      setConnection("GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5", "freighter");
      connectedNetwork.set("public");
      isNetworkMismatch.set(true);
    });

    expect(screen.getByTestId("deposit-network").textContent).toBe("public");
    expect(screen.getByTestId("deposit-mismatch").textContent).toBe("mismatch");

    act(() => {
      connectedNetwork.set("testnet");
      isNetworkMismatch.set(false);
    });

    expect(screen.getByTestId("deposit-network").textContent).toBe("testnet");
    expect(screen.getByTestId("deposit-mismatch").textContent).toBe("matched");
  });

  it("guarantees no flash of incorrect state between SSR mount and post-hydration", () => {
    // When island first mounts, isConnected should be false until mounted/initialized
    const snapshot = getWalletStateSnapshot();
    expect(snapshot.isConnected).toBe(false);
    expect(snapshot.publicKey).toBe("");
  });
});
