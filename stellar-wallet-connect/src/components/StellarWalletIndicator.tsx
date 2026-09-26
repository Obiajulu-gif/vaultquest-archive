"use client";

import { useCallback, useEffect, useRef, useState, type FC } from "react";
import { useStore } from "@nanostores/react";
import {
  Wallet,
  Loader2,
  Copy,
  Check,
  ChevronDown,
  LogOut,
  AlertCircle,
} from "lucide-react";
import {
  connectedPublicKey,
  connectedNetwork,
  isNetworkMismatch,
} from "../core/store.js";
import {
  connectWallet,
  disconnectWallet,
  getConnectedNetwork,
  initializeConnection,
  getWalletHealth,
  setConnection,
} from "../core/walletService.js";
import { truncateAddress } from "../vault/lib/format.js";
import { EXPECTED_NETWORK } from "../lib/wallets.js";

const BALANCE_REFRESH_MS = 30_000;
const EXTERNAL_POLL_MS = 10_000;

function normalizeWalletResult(
  result: unknown,
): string | null {
  if (result === null || result === undefined) return null;
  if (typeof result === "string") return result;
  const r = result as Record<string, unknown>;
  return (r.address as string) || (r.publicKey as string) || null;
}

async function readExternalFreighterAddress(): Promise<string | null | ""> {
  if (typeof window === "undefined") return null;

  const api =
    (window as unknown as Record<string, unknown>).freighterApi ??
    (window as unknown as Record<string, unknown>).freighter;
  if (!api) return null;

  const a = api as Record<string, unknown>;

  try {
    if (typeof a.isAllowed === "function") {
      const allowed = await a.isAllowed();
      const isAllowed =
        typeof allowed === "boolean"
          ? allowed
          : (allowed as Record<string, unknown>)?.isAllowed;
      if (isAllowed === false) return "";
    }

    if (typeof a.isConnected === "function") {
      const connected = await a.isConnected();
      const isConnected =
        typeof connected === "boolean"
          ? connected
          : (connected as Record<string, unknown>)?.isConnected;
      if (isConnected === false) return "";
    }

    if (typeof a.getPublicKey === "function") {
      return normalizeWalletResult(await a.getPublicKey());
    }

    if (typeof a.getAddress === "function") {
      return normalizeWalletResult(
        await a.getAddress({ skipRequestAccess: true }),
      );
    }
  } catch {
    return null;
  }

  return null;
}

export const StellarWalletIndicator: FC = () => {
  const publicKey = useStore(connectedPublicKey);
  const network = useStore(connectedNetwork);
  const mismatch = useStore(isNetworkMismatch);

  const [balance, setBalance] = useState<number | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [copiedStatus, setCopiedStatus] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const suppressedAddressRef = useRef<string | null>(null);

  const isConnected = Boolean(publicKey);

  useEffect(() => {
    initializeConnection();
  }, []);

  const fetchBalance = useCallback(async () => {
    if (!publicKey) {
      setBalance(null);
      return;
    }
    try {
      const health = await getWalletHealth();
      setBalance(health.balances.XLM);
    } catch {
      // silent
    }
  }, [publicKey]);

  useEffect(() => {
    fetchBalance();
    if (!publicKey) return;
    const interval = setInterval(fetchBalance, BALANCE_REFRESH_MS);
    return () => clearInterval(interval);
  }, [publicKey, fetchBalance]);

  const checkExternalConnection = useCallback(async () => {
    try {
      const externalAddress = await readExternalFreighterAddress();

      if (externalAddress === "" && connectedPublicKey.get()) {
        await disconnectWallet();
        return;
      }

      // Suppress re-adopting an address the user explicitly disconnected
      if (externalAddress && suppressedAddressRef.current) {
        if (externalAddress === suppressedAddressRef.current) {
          return;
        }
        suppressedAddressRef.current = null;
      }

      if (externalAddress && externalAddress !== connectedPublicKey.get()) {
        setConnection(externalAddress, "freighter");
        fetchBalance();
        return;
      }

      if (connectedPublicKey.get()) {
        const activeNetwork = await getConnectedNetwork();
        connectedNetwork.set(activeNetwork);
        isNetworkMismatch.set(activeNetwork !== EXPECTED_NETWORK);
      }
    } catch {
      // silent
    }
  }, [fetchBalance]);

  useEffect(() => {
    checkExternalConnection();

    const onStorage = (event: StorageEvent) => {
      if (event.key === "publicKey" || event.key === "walletProvider") {
        initializeConnection();
        checkExternalConnection();
      }
    };

    const onFocus = () => checkExternalConnection();
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        const storedKey = localStorage.getItem("publicKey");
        if (!storedKey && connectedPublicKey.get()) {
          disconnectWallet();
          return;
        }
        checkExternalConnection();
      }
    };

    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    const pollInterval = window.setInterval(
      checkExternalConnection,
      EXTERNAL_POLL_MS,
    );

    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.clearInterval(pollInterval);
    };
  }, [checkExternalConnection]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        setIsDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleConnect = useCallback(async () => {
    setIsConnecting(true);
    setError(null);
    suppressedAddressRef.current = null;
    try {
      await connectWallet("freighter");
    } catch (err: any) {
      setError(err?.message || "Failed to connect wallet");
    } finally {
      setIsConnecting(false);
    }
  }, []);

  const handleDisconnect = useCallback(async () => {
    setIsDropdownOpen(false);
    suppressedAddressRef.current = connectedPublicKey.get();
    try {
      await disconnectWallet();
    } catch {
      // best-effort
    }
  }, []);

  const handleCopy = useCallback(async () => {
    if (!publicKey) return;
    try {
      await navigator.clipboard.writeText(publicKey);
      setCopiedStatus(true);
      setTimeout(() => setCopiedStatus(false), 2000);
    } catch {
      // clipboard unavailable
    }
  }, [publicKey]);

  // ── Disconnected ──────────────────────────────────────────

  if (!isConnected) {
    return (
      <div className="relative">
        <button
          type="button"
          onClick={handleConnect}
          disabled={isConnecting}
          className="vq-btn-primary h-10"
          aria-label="Connect Stellar wallet"
        >
          {isConnecting ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Wallet className="h-4 w-4" aria-hidden="true" />
          )}
          {isConnecting ? "Connecting…" : "Connect Wallet"}
        </button>
        {error && (
          <div
            role="alert"
            className="absolute right-0 mt-2 w-64 rounded-xl border border-red-500/30 bg-red-950/90 p-3 text-xs text-red-200 shadow-xl backdrop-blur-md z-50"
          >
            <div className="flex items-start gap-2">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>{error}</span>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ── Connected ─────────────────────────────────────────────

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        type="button"
        onClick={() => setIsDropdownOpen((o) => !o)}
        className="flex h-10 items-center gap-2 rounded-xl border border-vault-border bg-vault-surface px-3 text-sm font-medium text-vault-text backdrop-blur-md transition-all duration-300 hover:border-red-400/40 hover:shadow-glow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
        aria-label="Stellar wallet settings"
        aria-expanded={isDropdownOpen}
      >
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-emerald-900/30">
          <Wallet className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
        </span>
        <span className="font-mono text-xs">{truncateAddress(publicKey)}</span>
        {balance !== null && (
          <span className="hidden text-xs text-vault-muted sm:inline">
            {balance.toLocaleString("en-US", {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}{" "}
            XLM
          </span>
        )}
        <ChevronDown
          className={`h-3.5 w-3.5 text-vault-muted transition-transform duration-200 ${
            isDropdownOpen ? "rotate-180" : ""
          }`}
        />
      </button>

      {isDropdownOpen && (
        <div className="absolute right-0 mt-2 z-50 w-56 overflow-hidden rounded-2xl border border-vault-border bg-vault-surface p-1 shadow-glass backdrop-blur-xl">
          <div className="px-3 py-2 text-xs font-medium text-vault-muted">
            {mismatch ? (
              <span className="flex items-center gap-1.5 text-amber-400">
                <AlertCircle className="h-3 w-3" />
                Wrong network
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-emerald-400">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                Connected
              </span>
            )}
          </div>

          <div className="px-3 py-1.5">
            <div className="font-mono text-xs text-vault-text">
              {truncateAddress(publicKey, 8, 6)}
            </div>
            <div className="flex items-center gap-1 text-[10px] text-vault-muted">
              {network && <span>{network}</span>}
              {balance !== null && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>
                    {balance.toLocaleString("en-US", {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}{" "}
                    XLM
                  </span>
                </>
              )}
            </div>
          </div>

          <hr className="mx-2 border-vault-border/50" />

          <button
            type="button"
            onClick={() => {
              handleCopy();
              setIsDropdownOpen(false);
            }}
            className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm text-vault-text transition-colors hover:bg-vault-surface/50"
          >
            {copiedStatus ? (
              <Check className="h-4 w-4 text-emerald-400" />
            ) : (
              <Copy className="h-4 w-4" />
            )}
            {copiedStatus ? "Copied!" : "Copy Address"}
          </button>

          <button
            type="button"
            onClick={handleDisconnect}
            className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm text-red-400 transition-colors hover:bg-red-500/10"
          >
            <LogOut className="h-4 w-4" />
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
};

export default StellarWalletIndicator;
