/** Must match `RPC_STORAGE_KEY` in the root app `lib/customRpc.js`. */
export const RPC_STORAGE_KEY = "vaultquest-custom-rpc";

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/** Custom Horizon URL from localStorage (set via Custom RPC modal). */
export function readCustomHorizonUrl(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(RPC_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { horizon?: unknown };
    if (typeof parsed?.horizon === "string" && parsed.horizon.trim()) {
      return normalizeBaseUrl(parsed.horizon);
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** Priority: custom RPC storage → env → network default. */
export function resolveHorizonUrl(envUrl: string, networkFallback: string): string {
  return readCustomHorizonUrl() || (envUrl ? normalizeBaseUrl(envUrl) : "") || networkFallback;
}
