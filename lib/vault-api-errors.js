/**
 * Vault API Error Audit
 *
 * Centralised registry of key vault data API routes, their expected error
 * shapes, safe fallback values, and retry behaviour.  Components that call
 * these routes should import the helpers here so error handling stays
 * consistent across the app.
 *
 * Retry strategy: exponential back-off, max 3 attempts, only on transient
 * errors (network / 5xx).  Never retry on 4xx client errors.
 */

/** Key vault API routes with metadata for error handling. */
export const VAULT_API_ROUTES = {
  vaultConfig: {
    label: "Vault configuration",
    route: "contract:vaultConfig",
    retryable: true,
    maxRetries: 3,
  },
  vaultApy: {
    label: "Vault APY",
    route: "contract:getAPY",
    retryable: true,
    maxRetries: 3,
  },
  userBalance: {
    label: "User balance",
    route: "contract:balanceOf",
    retryable: true,
    maxRetries: 2,
  },
  stellarHorizon: {
    label: "Stellar Horizon",
    route: "https://horizon.stellar.org",
    retryable: true,
    maxRetries: 3,
  },
  backendHealth: {
    label: "VaultQuest backend",
    route: "/api/health",
    retryable: false,
    maxRetries: 0,
  },
};

/**
 * Safe fallback values used whenever a vault field cannot be loaded.
 * Components must display these instead of rendering null / undefined.
 */
export const VAULT_FIELD_FALLBACKS = {
  name: "—",
  apy: null,
  minDeposit: null,
  totalDeposits: null,
  status: "unknown",
  roundEndDate: null,
  prizePool: null,
};

/**
 * Standardised error messages keyed by HTTP status or error code.
 * Use `getApiErrorMessage` to resolve a message for display.
 */
const API_ERROR_MESSAGES = {
  400: "The request was invalid. Please refresh and try again.",
  401: "Your session has expired. Reconnect your wallet to continue.",
  403: "You don't have permission to access this resource.",
  404: "The requested vault data was not found.",
  429: "Too many requests. Please wait a moment before trying again.",
  500: "VaultQuest's backend encountered an error. Try again shortly.",
  502: "A network gateway error occurred. Try again in a few seconds.",
  503: "The service is temporarily unavailable. Check system status.",
  NETWORK_ERROR:
    "Unable to reach the server. Check your internet connection.",
  TIMEOUT: "The request timed out. The network may be slow — try again.",
  UNKNOWN: "An unexpected error occurred. Please try again.",
};

/**
 * Returns a user-facing error message for a given error.
 * @param {Error | { status?: number; code?: string } | null} error
 * @returns {string}
 */
export function getApiErrorMessage(error) {
  if (!error) return API_ERROR_MESSAGES.UNKNOWN;

  const status = error?.status ?? error?.response?.status;
  if (status && API_ERROR_MESSAGES[status]) return API_ERROR_MESSAGES[status];

  const code = error?.code ?? error?.name ?? "";
  if (code === "ECONNABORTED" || code === "AbortError")
    return API_ERROR_MESSAGES.TIMEOUT;
  if (
    code === "NetworkError" ||
    code === "TypeError" ||
    code.toLowerCase().includes("network")
  )
    return API_ERROR_MESSAGES.NETWORK_ERROR;

  return API_ERROR_MESSAGES.UNKNOWN;
}

/**
 * Determines whether a failed request should be retried.
 * @param {Error | { status?: number } | null} error
 * @param {string} routeKey - Key from VAULT_API_ROUTES
 * @param {number} attemptCount - Number of attempts already made (0-indexed)
 * @returns {boolean}
 */
export function shouldRetry(error, routeKey, attemptCount) {
  const route = VAULT_API_ROUTES[routeKey];
  if (!route?.retryable) return false;
  if (attemptCount >= route.maxRetries) return false;

  const status = error?.status ?? error?.response?.status;
  // Never retry on client errors
  if (status >= 400 && status < 500) return false;

  return true;
}

/**
 * Logs a vault API warning safely (no sensitive data in the message).
 * @param {string} routeKey - Key from VAULT_API_ROUTES
 * @param {string} message
 * @param {{ field?: string; fallback?: unknown }} [meta]
 */
export function logVaultApiWarning(routeKey, message, meta = {}) {
  const route = VAULT_API_ROUTES[routeKey];
  const label = route?.label ?? routeKey;
  // Safe log: no wallet addresses, keys, or raw error stacks
  console.warn(`[VaultAPI:${label}] ${message}`, {
    route: route?.route ?? "unknown",
    field: meta.field ?? null,
    fallback: meta.fallback ?? null,
  });
}
