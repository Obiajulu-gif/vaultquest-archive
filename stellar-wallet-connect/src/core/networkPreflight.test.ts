import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EXPECTED_NETWORK } from "../lib/wallets.js";
import { connectedNetwork, isNetworkMismatch } from "./store.js";

const getNetworkMock = vi.fn();

vi.mock("./kit.js", () => ({
  kit: {
    getNetwork: (...args: unknown[]) => getNetworkMock(...args),
  },
}));

vi.mock("../vault/data/queryClient.js", () => ({
  vaultQueryClient: { clear: vi.fn() },
}));

// Import after mocks so `kit` resolves to the mock above.
const { assertNetworkMatchesBeforeSigning, NetworkMismatchError, setConnection, disconnect } =
  await import("./walletService.js");

describe("assertNetworkMatchesBeforeSigning (#735)", () => {
  beforeEach(() => {
    getNetworkMock.mockReset();
    localStorage.clear();
    disconnect();
  });

  it("main path: resolves without throwing when the wallet network matches", async () => {
    getNetworkMock.mockResolvedValue({ network: EXPECTED_NETWORK });

    await expect(assertNetworkMatchesBeforeSigning()).resolves.toBeUndefined();
    expect(isNetworkMismatch.get()).toBe(false);
    expect(connectedNetwork.get()).toBe(EXPECTED_NETWORK);
  });

  it("edge case: throws a typed NetworkMismatchError when the wallet is on a different network", async () => {
    const other = EXPECTED_NETWORK === "TESTNET" ? "PUBLIC" : "TESTNET";
    getNetworkMock.mockResolvedValue({ network: other });

    await expect(assertNetworkMatchesBeforeSigning()).rejects.toBeInstanceOf(NetworkMismatchError);
    expect(isNetworkMismatch.get()).toBe(true);
  });

  it("edge case: fails closed (throws) when the network can't be determined at all", async () => {
    getNetworkMock.mockRejectedValue(new Error("provider does not expose getNetwork"));

    await expect(assertNetworkMatchesBeforeSigning()).rejects.toBeInstanceOf(NetworkMismatchError);
    expect(connectedNetwork.get()).toBeNull();
  });

  it("failure state: the thrown error carries a clear, non-technical message", async () => {
    const other = EXPECTED_NETWORK === "TESTNET" ? "PUBLIC" : "TESTNET";
    getNetworkMock.mockResolvedValue({ network: other });

    try {
      await assertNetworkMatchesBeforeSigning();
      expect.unreachable("expected assertNetworkMatchesBeforeSigning to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkMismatchError);
      expect((err as Error).message).toMatch(/network/i);
      expect((err as Error).message).not.toMatch(/undefined|\[object/i);
    }
  });
});

describe("network watcher lifecycle (#735)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    getNetworkMock.mockReset();
    localStorage.clear();
    disconnect();
  });

  afterEach(() => {
    disconnect();
    vi.useRealTimers();
  });

  it("polls for a mid-session network change while connected, without a transaction attempt", async () => {
    getNetworkMock.mockResolvedValue({ network: EXPECTED_NETWORK });
    setConnection("GTESTWATCHERADDR", "freighter");
    await vi.advanceTimersByTimeAsync(0);
    expect(isNetworkMismatch.get()).toBe(false);

    const other = EXPECTED_NETWORK === "TESTNET" ? "PUBLIC" : "TESTNET";
    getNetworkMock.mockResolvedValue({ network: other });

    await vi.advanceTimersByTimeAsync(15_000);

    expect(isNetworkMismatch.get()).toBe(true);
  });

  it("stops polling after disconnect", async () => {
    getNetworkMock.mockResolvedValue({ network: EXPECTED_NETWORK });
    setConnection("GTESTWATCHERADDR2", "freighter");
    await vi.advanceTimersByTimeAsync(0);

    disconnect();
    getNetworkMock.mockClear();

    await vi.advanceTimersByTimeAsync(30_000);

    expect(getNetworkMock).not.toHaveBeenCalled();
  });
});
