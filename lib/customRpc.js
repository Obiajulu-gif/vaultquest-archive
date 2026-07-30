import { avalanche, avalancheFuji } from "wagmi/chains";

export const RPC_STORAGE_KEY = "vaultquest-custom-rpc";
export const RPC_UPDATED_EVENT = "vaultquest-rpc-updated";

export const DEFAULT_RPC = {
  horizon: "https://horizon-testnet.stellar.org",
  avalanche: avalanche.rpcUrls.default.http[0],
  avalancheFuji: avalancheFuji.rpcUrls.default.http[0],
};

/** @returns {{ horizon: string, avalanche: string, avalancheFuji: string } | null} */
export function readStoredRpc() {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(RPC_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return {
      horizon: typeof parsed.horizon === "string" ? parsed.horizon : DEFAULT_RPC.horizon,
      avalanche: typeof parsed.avalanche === "string" ? parsed.avalanche : DEFAULT_RPC.avalanche,
      avalancheFuji:
        typeof parsed.avalancheFuji === "string" ? parsed.avalancheFuji : DEFAULT_RPC.avalancheFuji,
    };
  } catch {
    return null;
  }
}

/** @param {{ horizon?: string, avalanche?: string, avalancheFuji?: string }} urls */
export function writeStoredRpc(urls) {
  const current = readStoredRpc() ?? { ...DEFAULT_RPC };
  const next = {
    horizon: urls.horizon?.trim() || current.horizon,
    avalanche: urls.avalanche?.trim() || current.avalanche,
    avalancheFuji: urls.avalancheFuji?.trim() || current.avalancheFuji,
  };
  localStorage.setItem(RPC_STORAGE_KEY, JSON.stringify(next));
  return next;
}

/** Active Horizon URL (custom localStorage override or default). */
export function getHorizonUrl() {
  const stored = readStoredRpc()?.horizon;
  return stored ? normalizeBaseUrl(stored) : DEFAULT_RPC.horizon;
}

function normalizeBaseUrl(url) {
  return url.trim().replace(/\/+$/, "");
}

/** Validates a Stellar Horizon instance via its root endpoint (horizon_version / _links). */
export async function pingHorizon(horizonUrl) {
  const base = normalizeBaseUrl(horizonUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(base, { signal: controller.signal, headers: { Accept: "application/json" } });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = await res.json();
    if (data?.horizon_version || data?._links?.account) {
      return { ok: true };
    }
    return { ok: false, error: "Not a valid Horizon root response" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Connection failed" };
  } finally {
    clearTimeout(timeout);
  }
}

/** Validates an EVM JSON-RPC endpoint (eth_blockNumber). */
export async function pingEvmRpc(rpcUrl) {
  const url = normalizeBaseUrl(rpcUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = await res.json();
    if (typeof data?.result === "string" && data.result.startsWith("0x")) {
      return { ok: true };
    }
    return { ok: false, error: data?.error?.message ?? "Invalid JSON-RPC response" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Connection failed" };
  } finally {
    clearTimeout(timeout);
  }
}
