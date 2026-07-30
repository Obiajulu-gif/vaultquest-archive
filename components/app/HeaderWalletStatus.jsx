"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, Loader2, Unplug, Wallet, WifiOff } from "lucide-react";
import {
  connectedNetwork,
  connectedPublicKey,
  isNetworkMismatch,
} from "@vaultquest/stellar-wallet-connect/src/core/store";
import { EXPECTED_NETWORK } from "@vaultquest/stellar-wallet-connect/src/lib/wallets";

function loadWalletService() {
  return import("@vaultquest/stellar-wallet-connect/src/core/walletService");
}

function useNanostoreValue(store, fallback) {
  const [value, setValue] = useState(fallback);

  useEffect(() => {
    setValue(store.get());
    return store.subscribe(setValue);
  }, [store]);

  return value;
}

function truncatePublicKey(publicKey) {
  if (!publicKey) return "";
  return `${publicKey.slice(0, 4)}...${publicKey.slice(-3)}`;
}

function formatBalance(balances) {
  if (!balances) return "Balance unavailable";
  const xlm = Number(balances.XLM || 0);
  const usdc = Number(balances.USDC || 0);

  if (usdc > 0) {
    return `${xlm.toLocaleString("en-US", { maximumFractionDigits: 2 })} XLM · ${usdc.toLocaleString("en-US", { maximumFractionDigits: 2 })} USDC`;
  }

  return `${xlm.toLocaleString("en-US", { maximumFractionDigits: 2 })} XLM`;
}

function normalizeWalletResult(result) {
  if (!result) return null;
  if (typeof result === "string") return result;
  return result.address || result.publicKey || null;
}

async function readExternalFreighterAddress() {
  if (typeof window === "undefined") return null;

  const api = window.freighterApi || window.freighter;
  if (!api) return null;

  try {
    if (typeof api.isAllowed === "function") {
      const allowed = await api.isAllowed();
      const isAllowed = typeof allowed === "boolean" ? allowed : allowed?.isAllowed;
      if (isAllowed === false) return "";
    }

    if (typeof api.isConnected === "function") {
      const connected = await api.isConnected();
      const isConnected = typeof connected === "boolean" ? connected : connected?.isConnected;
      if (isConnected === false) return "";
    }

    if (typeof api.getPublicKey === "function") {
      return normalizeWalletResult(await api.getPublicKey());
    }

    if (typeof api.getAddress === "function") {
      return normalizeWalletResult(await api.getAddress({ skipRequestAccess: true }));
    }
  } catch {
    return null;
  }

  return null;
}

export default function HeaderWalletStatus({ variant = "desktop" }) {
  const publicKey = useNanostoreValue(connectedPublicKey, "");
  const network = useNanostoreValue(connectedNetwork, null);
  const mismatch = useNanostoreValue(isNetworkMismatch, false);
  const [provider, setProvider] = useState(null);
  const [balances, setBalances] = useState(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState("");

  const isConnected = Boolean(publicKey);
  const compact = variant === "desktop";

  const refreshWalletState = useCallback(async () => {
    setIsRefreshing(true);
    try {
      const externalAddress = await readExternalFreighterAddress();
      const walletService = await loadWalletService();

      if (externalAddress === "" && publicKey) {
        walletService.disconnect();
        setProvider(null);
        setBalances(null);
        return;
      }

      if (externalAddress && externalAddress !== publicKey) {
        walletService.setConnection(externalAddress, "freighter");
        setProvider("freighter");
      }

      const activePublicKey = connectedPublicKey.get();
      if (!activePublicKey) {
        setBalances(null);
        return;
      }

      const activeNetwork = await walletService.getConnectedNetwork();
      connectedNetwork.set(activeNetwork);
      isNetworkMismatch.set(activeNetwork !== EXPECTED_NETWORK);
      const health = await walletService.getWalletHealth();
      setBalances(health.balances);
      setError("");
    } catch {
      setError("Balance unavailable");
    } finally {
      setIsRefreshing(false);
    }
  }, [publicKey]);

  useEffect(() => {
    let active = true;

    loadWalletService().then((walletService) => {
      if (!active) return;
      const stored = walletService.initializeConnection();
      setProvider(stored?.provider || walletService.loadedProvider() || null);
    });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    refreshWalletState();

    const onStorage = (event) => {
      if (event.key === "publicKey" || event.key === "walletProvider") {
        loadWalletService().then((walletService) => {
          walletService.initializeConnection();
          setProvider(walletService.loadedProvider() || null);
          refreshWalletState();
        });
      }
    };

    const onFocus = () => refreshWalletState();
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refreshWalletState();
    };

    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    const intervalId = window.setInterval(refreshWalletState, 10000);

    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.clearInterval(intervalId);
    };
  }, [refreshWalletState]);

  const handleConnect = async () => {
    setIsConnecting(true);
    setError("");
    try {
      const walletService = await loadWalletService();
      const result = await walletService.connectWallet("freighter");
      setProvider(result.provider);
      await refreshWalletState();
    } catch (err) {
      setError(err?.message || "Unable to connect wallet");
    } finally {
      setIsConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    setIsConnecting(true);
    try {
      const walletService = await loadWalletService();
      await walletService.disconnectWallet(provider || walletService.loadedProvider() || "freighter");
      setProvider(null);
      setBalances(null);
      setError("");
    } catch (err) {
      setError(err?.message || "Unable to disconnect wallet");
    } finally {
      setIsConnecting(false);
    }
  };

  const statusLabel = useMemo(() => {
    if (!isConnected) return "Disconnected";
    if (mismatch) return "Wrong network";
    return network ? `${network} connected` : "Connected";
  }, [isConnected, mismatch, network]);

  if (!isConnected) {
    return (
      <div className={compact ? "flex items-center" : "space-y-2"}>
        <button
          type="button"
          onClick={handleConnect}
          disabled={isConnecting}
          className="vq-btn-primary h-10 px-3 sm:px-4"
        >
          {isConnecting ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Wallet className="h-4 w-4" aria-hidden="true" />
          )}
          Connect Wallet
        </button>
        {error && !compact && <p className="text-xs text-red-500">{error}</p>}
      </div>
    );
  }

  return (
    <div
      className={`flex items-center gap-2 rounded-xl border border-vault-border bg-vault-surface px-3 py-2 text-vault-text backdrop-blur-md ${
        compact ? "max-w-[260px]" : "w-full justify-between"
      }`}
      aria-label="Wallet connection status"
    >
      <span className={`h-2.5 w-2.5 rounded-full ${mismatch ? "bg-amber-400" : "bg-emerald-400"}`} />
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          {mismatch ? (
            <WifiOff className="h-3.5 w-3.5 shrink-0 text-amber-400" aria-hidden="true" />
          ) : (
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-400" aria-hidden="true" />
          )}
          <p className="truncate font-mono text-xs font-semibold text-vault-text">
            {truncatePublicKey(publicKey)}
          </p>
        </div>
        <p className="truncate text-[11px] text-vault-muted">
          {isRefreshing ? "Refreshing balance..." : error || formatBalance(balances)}
        </p>
      </div>
      <button
        type="button"
        onClick={handleDisconnect}
        disabled={isConnecting}
        className="ml-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-vault-muted transition-colors hover:bg-red-500/10 hover:text-red-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 disabled:opacity-50"
        aria-label={`Disconnect wallet. ${statusLabel}`}
        title="Disconnect wallet"
      >
        {isConnecting ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        ) : (
          <Unplug className="h-4 w-4" aria-hidden="true" />
        )}
      </button>
    </div>
  );
}
