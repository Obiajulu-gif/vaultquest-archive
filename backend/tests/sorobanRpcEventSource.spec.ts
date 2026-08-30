import { beforeEach, describe, expect, it, vi } from "vitest";

const stellarMock = vi.hoisted(() => ({
  getEventsMocks: [] as Array<ReturnType<typeof vi.fn>>,
}));

vi.mock("@stellar/stellar-sdk", () => ({
  rpc: {
    Server: vi.fn(() => {
      const getEvents = stellarMock.getEventsMocks.shift();
      if (!getEvents) throw new Error("missing mocked getEvents handler");
      return { getEvents };
    }),
  },
  xdr: {
    ScVal: class {
      static fromXDR() {
        return {};
      }
    },
  },
  scValToNative: vi.fn(),
}));

const { SorobanRpcEventSource } = await import("../src/services/stellarIndexer.js");

function rpcEvent(id: string, ledger: number, pagingToken = id) {
  return {
    id,
    ledger,
    txHash: `tx-${id}`,
    contractId: "CPOOL",
    topic: [],
    value: "value-xdr",
    pagingToken,
    inSuccessfulContractCall: true,
  };
}

function sourceWith(...getEventsMocks: Array<ReturnType<typeof vi.fn>>) {
  stellarMock.getEventsMocks = [...getEventsMocks];
  return new SorobanRpcEventSource({
    rpcUrl: getEventsMocks.map((_, index) => `http://rpc-${index + 1}.test`),
    contractIds: ["CPOOL"],
    maxPageFetch: 10,
  });
}

describe("SorobanRpcEventSource failover", () => {
  beforeEach(() => {
    stellarMock.getEventsMocks = [];
    vi.clearAllMocks();
  });

  it("returns data from the second server when the first server fails", async () => {
    const first = vi.fn().mockRejectedValue(new Error("primary unavailable"));
    const second = vi.fn().mockResolvedValue({ events: [rpcEvent("e1", 10)] });
    const source = sourceWith(first, second);

    const events = await source.fetchEvents({ startLedger: 10, limit: 1 });

    expect(events.map((event) => event.id)).toEqual(["e1"]);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("throws the last error when every server fails", async () => {
    const first = vi.fn().mockRejectedValue(new Error("first failure"));
    const second = vi.fn().mockRejectedValue(new Error("last failure"));
    const source = sourceWith(first, second);

    await expect(source.fetchEvents({ startLedger: 10, limit: 1 })).rejects.toThrow("last failure");
  });

  it("fails over mid-pagination without duplicating or dropping events", async () => {
    const first = vi
      .fn()
      .mockResolvedValueOnce({ events: [rpcEvent("e1", 10, "cursor-e1"), rpcEvent("e2", 11, "cursor-e2")] })
      .mockRejectedValueOnce(new Error("primary failed on page 2"));
    const second = vi.fn().mockResolvedValueOnce({ events: [rpcEvent("e3", 12, "cursor-e3")] });
    const source = sourceWith(first, second);

    const events = await source.fetchEvents({ startLedger: 10, limit: 3 });

    expect(events.map((event) => event.id)).toEqual(["e1", "e2", "e3"]);
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(1);
    expect(second.mock.calls[0][0]).toEqual(
      expect.objectContaining({ cursor: "cursor-e2", limit: 1 })
    );
  });

  it("never combines cursor and startLedger across a multi-page failover", async () => {
    const first = vi
      .fn()
      .mockResolvedValueOnce({ events: [rpcEvent("e1", 10, "cursor-e1"), rpcEvent("e2", 11, "cursor-e2")] })
      .mockRejectedValueOnce(new Error("primary failed on cursor page"));
    const second = vi.fn().mockResolvedValueOnce({ events: [rpcEvent("e3", 12, "cursor-e3")] });
    const source = sourceWith(first, second);

    await source.fetchEvents({ startLedger: 10, endLedger: 20, limit: 3 });

    const requests = [...first.mock.calls, ...second.mock.calls].map(([request]) => request);
    expect(requests).toHaveLength(3);
    for (const request of requests) {
      expect(request.cursor && request.startLedger).toBeFalsy();
    }
    expect(requests[0]).toEqual(expect.objectContaining({ startLedger: 10 }));
    expect(requests[1]).toEqual(expect.objectContaining({ cursor: "cursor-e2" }));
    expect(requests[2]).toEqual(expect.objectContaining({ cursor: "cursor-e2" }));
  });
});