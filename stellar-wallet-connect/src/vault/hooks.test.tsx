import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockVaultClient, SAMPLE_ADDRESS } from "./contract/mockClient";
import type { PoolSummary } from "./contract/types";
import { usePoolDetail, usePoolDiscovery, useSavedPools, useTransactionStatus } from "./hooks";
import { vaultQueryClient } from "./data/queryClient";

const pool: PoolSummary = {
  id: "pool-1",
  name: "Weekly USDC",
  status: "open",
  tvl: "10000",
  asset: "USDC",
  participantCount: 12,
  expectedYield: "5.2% APY",
  prize: "120 USDC",
  opensAt: "2026-05-01T00:00:00Z",
  locksAt: "2026-05-08T00:00:00Z",
  drawsAt: "2026-05-09T00:00:00Z",
};

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("vault data hooks", () => {
  beforeEach(() => {
    vaultQueryClient.clear();
    vi.restoreAllMocks();
  });

  it("normalizes pool detail reads behind the contract adapter", async () => {
    const client = createMockVaultClient({ pools: { [pool.id]: pool } });

    const { result } = renderHook(() => usePoolDetail(client, pool.id, SAMPLE_ADDRESS));

    await waitFor(() => expect(result.current.pool?.id).toBe(pool.id));
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("uses backend pool discovery first and falls back to contract reads", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ error: { message: "missing" } }, { status: 404 }));
    const client = createMockVaultClient({ pools: { [pool.id]: pool } });

    const { result } = renderHook(() => usePoolDiscovery(client, { apiBaseUrl: "https://api.test" }));

    await waitFor(() => expect(result.current.data).toEqual([pool]));
    expect(fetch).toHaveBeenCalledWith("https://api.test/pools");
  });

  it("invalidates saved-pool query state after mutations", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ data: [] }))
      .mockResolvedValueOnce(jsonResponse({ data: { saved: {
        id: "saved-1",
        wallet_address: SAMPLE_ADDRESS,
        pool_id: pool.id,
        pool_name: pool.name,
        status: pool.status,
        tvl: pool.tvl,
        asset: pool.asset,
        participant_count: pool.participantCount,
        expected_yield: pool.expectedYield,
        prize: pool.prize,
        opens_at: pool.opensAt,
        locks_at: pool.locksAt,
        draws_at: pool.drawsAt,
        created_at: "2026-05-30T00:00:00Z",
        updated_at: "2026-05-30T00:00:00Z",
      } } }))
      .mockResolvedValueOnce(jsonResponse({ data: [] }));

    const { result } = renderHook(() => useSavedPools(SAMPLE_ADDRESS, "https://api.test"));

    await waitFor(() => expect(result.current.data).toEqual([]));
    const saved = await result.current.savePool(pool);

    expect(saved.id).toBe(pool.id);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "https://api.test/saved-pools", expect.objectContaining({ method: "POST" }));
  });

  it("normalizes transaction status payloads for polling views", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ data: {
      id: "act-1",
      wallet_address: SAMPLE_ADDRESS,
      action_type: "join",
      action_payload: { vault_id: pool.id, amount: "25" },
      status: "confirmed",
      tx_hash: "tx-1",
      error_code: null,
      error_detail: null,
      created_at: "2026-05-30T00:00:00Z",
      updated_at: "2026-05-30T00:01:00Z",
      submitted_at: "2026-05-30T00:00:30Z",
      confirmed_at: "2026-05-30T00:01:00Z",
    } }));

    const { result } = renderHook(() => useTransactionStatus("act-1", { apiBaseUrl: "https://api.test" }));

    await waitFor(() => expect(result.current.data?.status).toBe("confirmed"));
    expect(result.current.data?.poolId).toBe(pool.id);
    expect(result.current.polling).toBe(false);
  });
});
