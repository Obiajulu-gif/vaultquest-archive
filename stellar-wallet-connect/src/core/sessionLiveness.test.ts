import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sessionStatus } from "./store.js";

const getAddressMock = vi.fn();
const getNetworkMock = vi.fn();

vi.mock("./kit.js", () => ({
  kit: {
    getAddress: (...args: unknown[]) => getAddressMock(...args),
    getNetwork: (...args: unknown[]) => getNetworkMock(...args),
  },
}));

vi.mock("../vault/data/queryClient.js", () => ({
  vaultQueryClient: { clear: vi.fn() },
}));

// Import after mocks so `kit` resolves to the mock above.
const {
  assertSessionAliveBeforeSigning,
  startSessionLivenessWatcher,
  stopSessionLivenessWatcher,
  WalletSessionLostError,
} = await import("./sessionLiveness.js");
const { setConnection, disconnect } = await import("./walletService.js");

describe("assertSessionAliveBeforeSigning (#733)", () => {
  beforeEach(() => {
    getAddressMock.mockReset();
    getNetworkMock.mockReset();
    getNetworkMock.mockResolvedValue({ network: "TESTNET" });
    localStorage.clear();
    disconnect();
  });

  afterEach(() => {
    disconnect();
  });

  it("main path: resolves without throwing when the wallet still reports the connected address", async () => {
    getAddressMock.mockResolvedValue({ address: "GALIVE" });
    setConnection("GALIVE", "freighter");

    await expect(assertSessionAliveBeforeSigning()).resolves.toBeUndefined();
    expect(sessionStatus.get()).toBe("alive");
  });

  it("edge case: throws a typed WalletSessionLostError when the wallet is unreachable", async () => {
    getAddressMock.mockRejectedValue(new Error("wallet locked"));
    setConnection("GALIVE2", "freighter");

    await expect(assertSessionAliveBeforeSigning()).rejects.toBeInstanceOf(WalletSessionLostError);
    expect(sessionStatus.get()).toBe("lost");
  });

  it("edge case: throws when the wallet silently reports a different account", async () => {
    getAddressMock.mockResolvedValue({ address: "GSWITCHEDACCOUNT" });
    setConnection("GORIGINAL", "freighter");

    await expect(assertSessionAliveBeforeSigning()).rejects.toBeInstanceOf(WalletSessionLostError);
    expect(sessionStatus.get()).toBe("lost");
  });

  it("failure state: the thrown error carries kind 'wallet_disconnected' for mapTxError to classify", async () => {
    getAddressMock.mockRejectedValue(new Error("wallet locked"));
    setConnection("GALIVE3", "freighter");

    try {
      await assertSessionAliveBeforeSigning();
      expect.unreachable("expected assertSessionAliveBeforeSigning to throw");
    } catch (err) {
      expect((err as { kind?: string }).kind).toBe("wallet_disconnected");
    }
  });

  it("no-op when nothing is connected yet (nothing to check)", async () => {
    await expect(assertSessionAliveBeforeSigning()).resolves.toBeUndefined();
  });
});

describe("session liveness heartbeat + recovery (#733)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    getAddressMock.mockReset();
    getNetworkMock.mockReset();
    getNetworkMock.mockResolvedValue({ network: "TESTNET" });
    localStorage.clear();
    disconnect();
  });

  afterEach(() => {
    disconnect();
    vi.useRealTimers();
  });

  it("marks the session lost after a heartbeat probe fails, then recovers on the next successful probe", async () => {
    getAddressMock.mockRejectedValue(new Error("wallet locked"));
    setConnection("GHEARTBEAT", "freighter");
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(sessionStatus.get()).toBe("lost");

    // Backed off to 40s after the first failure — a probe at +20s more
    // (40s total) shouldn't have re-fired yet if resolved is still failing;
    // instead flip the mock to succeed and advance to the backed-off tick.
    getAddressMock.mockResolvedValue({ address: "GHEARTBEAT" });
    await vi.advanceTimersByTimeAsync(40_000);
    expect(sessionStatus.get()).toBe("alive");
  });

  it("re-checks immediately on window focus rather than waiting for the next scheduled tick", async () => {
    getAddressMock.mockResolvedValue({ address: "GFOCUSCHECK" });
    setConnection("GFOCUSCHECK", "freighter");
    await vi.advanceTimersByTimeAsync(0);
    getAddressMock.mockClear();

    getAddressMock.mockRejectedValue(new Error("locked"));
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);

    expect(getAddressMock).toHaveBeenCalled();
    expect(sessionStatus.get()).toBe("lost");
  });

  it("stops probing once the watcher is stopped (e.g. on disconnect)", async () => {
    getAddressMock.mockResolvedValue({ address: "GSTOPPED" });
    startSessionLivenessWatcher("freighter", "GSTOPPED");
    await vi.advanceTimersByTimeAsync(0);

    stopSessionLivenessWatcher();
    getAddressMock.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(getAddressMock).not.toHaveBeenCalled();
    expect(sessionStatus.get()).toBe("unknown");
  });
});
