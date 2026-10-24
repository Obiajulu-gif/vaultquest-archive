import { describe, it, expect, vi, afterEach } from "vitest";
import { VaultApiClient } from "./apiClient";

const SAMPLE_ADDRESS = "GABCDEF1234567890123456789012345678901234567890123456789";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("VaultApiClient.getPortfolioSummary (#628)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requests GET /portfolio/summary with the wallet as a query param, and returns the raw summary", async () => {
    const summary = {
      wallet_address: SAMPLE_ADDRESS,
      total_deposits: 500,
      active_positions: [{ vault_id: "vault-1", balance: 500, token: "USDC" }],
      pending_rewards: 0,
      claimable_amount: 0,
      invalid_action_count: 0,
      recent_activity: [],
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: summary }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new VaultApiClient("/api");
    const result = await client.getPortfolioSummary(SAMPLE_ADDRESS);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe(`/api/portfolio/summary?wallet=${SAMPLE_ADDRESS}`);
    expect(result).toEqual(summary);
  });

  it("returns the real zero-state shape for a wallet with no activity", async () => {
    const zeroState = {
      wallet_address: SAMPLE_ADDRESS,
      total_deposits: 0,
      active_positions: [],
      pending_rewards: 0,
      claimable_amount: 0,
      invalid_action_count: 0,
      recent_activity: [],
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ data: zeroState })));

    const client = new VaultApiClient("/api");
    const result = await client.getPortfolioSummary(SAMPLE_ADDRESS);

    expect(result.active_positions).toEqual([]);
    expect(result.total_deposits).toBe(0);
  });

  it("throws with the backend's error message on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({ error: { code: "INVALID_PAYLOAD", message: "invalid wallet address" } }, 400),
      ),
    );

    const client = new VaultApiClient("/api");

    await expect(client.getPortfolioSummary("not-a-real-address")).rejects.toThrow(
      "invalid wallet address",
    );
  });

  it("falls back to a generic message when the error response has no parseable body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("not json", { status: 500 })),
    );

    const client = new VaultApiClient("/api");

    await expect(client.getPortfolioSummary(SAMPLE_ADDRESS)).rejects.toThrow(
      "Portfolio summary request failed (500)",
    );
  });
});
