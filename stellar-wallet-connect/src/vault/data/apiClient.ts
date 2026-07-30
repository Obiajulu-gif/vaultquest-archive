import type { PoolActionType, PoolSummary, RewardHistoryEntry, SavedPoolEntry } from "../contract/types";

export type TransactionStatus = "pending" | "submitted" | "confirmed" | "reverted" | "failed" | "orphaned";

export interface TransactionStatusView {
  id: string;
  walletAddress: string;
  actionType: PoolActionType;
  poolId: string | null;
  amount: string | null;
  status: TransactionStatus;
  txHash: string | null;
  errorCode: string | null;
  errorDetail: string | null;
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
  confirmedAt: string | null;
}

type ApiEnvelope<T> = { data: T };

type SavedPoolApiRecord = {
  id: string;
  wallet_address: string;
  pool_id: string;
  pool_name: string;
  status: SavedPoolEntry["status"];
  tvl: string;
  asset: string;
  participant_count: number;
  expected_yield: string;
  prize: string | null;
  opens_at: string | null;
  locks_at: string | null;
  draws_at: string | null;
  created_at: string;
  updated_at: string;
};

type ActionApiRecord = {
  id: string;
  wallet_address: string;
  action_type: PoolActionType;
  action_payload: Record<string, unknown> | null;
  status: TransactionStatus;
  tx_hash: string | null;
  error_code: string | null;
  error_detail: string | null;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
  confirmed_at: string | null;
};

export function toSavedPoolEntry(row: SavedPoolApiRecord): SavedPoolEntry {
  return {
    id: row.pool_id,
    name: row.pool_name,
    status: row.status,
    tvl: row.tvl,
    asset: row.asset,
    participantCount: row.participant_count,
    expectedYield: row.expected_yield,
    prize: row.prize ?? undefined,
    opensAt: row.opens_at,
    locksAt: row.locks_at,
    drawsAt: row.draws_at,
    walletAddress: row.wallet_address,
    savedAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function poolToPayload(pool: PoolSummary) {
  return {
    pool_id: pool.id,
    pool_name: pool.name,
    status: pool.status,
    tvl: pool.tvl,
    asset: pool.asset,
    participant_count: pool.participantCount,
    expected_yield: pool.expectedYield,
    prize: pool.prize ?? null,
    opens_at: pool.opensAt,
    locks_at: pool.locksAt,
    draws_at: pool.drawsAt,
  };
}

function toTransactionStatus(row: ActionApiRecord): TransactionStatusView {
  const payload = row.action_payload ?? {};
  const poolId = typeof payload.poolId === "string"
    ? payload.poolId
    : typeof payload.vault_id === "string"
      ? payload.vault_id
      : null;
  const amount = typeof payload.amount === "string" ? payload.amount : null;

  return {
    id: row.id,
    walletAddress: row.wallet_address,
    actionType: row.action_type,
    poolId,
    amount,
    status: row.status,
    txHash: row.tx_hash,
    errorCode: row.error_code,
    errorDetail: row.error_detail,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    submittedAt: row.submitted_at,
    confirmedAt: row.confirmed_at,
  };
}

async function parseJsonResponse<T>(res: Response, fallback: string): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(body.error?.message ?? `${fallback} (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export class VaultApiClient {
  readonly baseUrl: string;

  constructor(baseUrl = "/api") {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  private url(path: string, params?: URLSearchParams): string {
    const query = params ? `?${params.toString()}` : "";
    return `${this.baseUrl}${path}${query}`;
  }

  async listPools(options?: { signal?: AbortSignal }): Promise<PoolSummary[]> {
    const body = await parseJsonResponse<ApiEnvelope<PoolSummary[]>>(
      await fetch(this.url("/pools"), { signal: options?.signal }),
      "Pool discovery request failed",
    );
    return body.data;
  }

  async listPrizeViews(walletAddress?: string | null, options?: { signal?: AbortSignal }): Promise<RewardHistoryEntry[]> {
    const params = walletAddress ? new URLSearchParams({ wallet: walletAddress }) : undefined;
    const body = await parseJsonResponse<ApiEnvelope<RewardHistoryEntry[]>>(
      await fetch(this.url("/prizes", params), { signal: options?.signal }),
      "Prize views request failed",
    );
    return body.data;
  }

  async getTransactionStatus(actionId: string, options?: { signal?: AbortSignal }): Promise<TransactionStatusView> {
    const body = await parseJsonResponse<ApiEnvelope<ActionApiRecord>>(
      await fetch(this.url(`/actions/${encodeURIComponent(actionId)}`), { signal: options?.signal }),
      "Transaction status request failed",
    );
    return toTransactionStatus(body.data);
  }

  async listSavedPools(walletAddress: string, options?: { signal?: AbortSignal }): Promise<SavedPoolEntry[]> {
    const params = new URLSearchParams({ wallet: walletAddress });
    const body = await parseJsonResponse<ApiEnvelope<SavedPoolApiRecord[]>>(
      await fetch(this.url("/saved-pools", params), { signal: options?.signal }),
      "Saved pools request failed",
    );
    return body.data.map(toSavedPoolEntry);
  }

  async savePool(walletAddress: string, pool: PoolSummary, options?: { signal?: AbortSignal }): Promise<SavedPoolEntry> {
    const body = await parseJsonResponse<ApiEnvelope<{ saved: SavedPoolApiRecord }>>(
      await fetch(this.url("/saved-pools"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallet_address: walletAddress, pool: poolToPayload(pool) }),
        signal: options?.signal,
      }),
      "Saving pool failed",
    );
    return toSavedPoolEntry(body.data.saved);
  }

  async unsavePool(walletAddress: string, poolId: string, options?: { signal?: AbortSignal }): Promise<number> {
    const params = new URLSearchParams({ wallet: walletAddress });
    const body = await parseJsonResponse<ApiEnvelope<{ deleted: number }>>(
      await fetch(this.url(`/saved-pools/${encodeURIComponent(poolId)}`, params), { method: "DELETE", signal: options?.signal }),
      "Removing saved pool failed",
    );
    return body.data.deleted;
  }

  async exportActivity(options: { wallet: string; format: "json" | "csv"; from?: string; to?: string; signal?: AbortSignal }): Promise<Blob> {
    const params = new URLSearchParams({ wallet: options.wallet, format: options.format });
    if (options.from) params.set("from", options.from);
    if (options.to) params.set("to", options.to);

    const res = await fetch(this.url("/actions/export", params), { signal: options.signal });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      throw new Error(body.error?.message ?? `Export failed (${res.status})`);
    }
    return res.blob();
  }
}

export function isTerminalTransaction(status: TransactionStatus): boolean {
  return ["confirmed", "reverted", "failed", "orphaned"].includes(status);
}
