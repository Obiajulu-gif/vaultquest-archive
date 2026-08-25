"use client";

import { useEffect, useMemo, useState } from "react";
import { Activity, ArrowUpRight, RefreshCw, ShieldAlert } from "lucide-react";

const PRIORITY_TIERS = [
  {
    key: "low",
    label: "Low",
    description: "Best effort routing with the lowest estimated fee.",
    multiplier: 0.85,
    eta: "6-8s",
  },
  {
    key: "medium",
    label: "Medium",
    description: "Balanced speed for standard deposit flows.",
    multiplier: 1,
    eta: "3-5s",
  },
  {
    key: "high",
    label: "High",
    description: "Higher inclusion priority for busy network windows.",
    multiplier: 1.25,
    eta: "1-2s",
  },
];

const NETWORKS = {
  avalanche: {
    key: "avalanche",
    label: "Avalanche C-Chain",
    nativeToken: "AVAX",
    usdRate: 36,
    gasLimit: 180000n,
    fallbackGasPrice: 25_000_000_000n,
    fetcher: async () => {
      const response = await fetch("https://api.avax.network/ext/bc/C/rpc", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_gasPrice",
          params: [],
        }),
      });

      if (!response.ok) {
        throw new Error("Unable to fetch Avalanche gas price");
      }

      const data = await response.json();
      const gasPrice = typeof data?.result === "string" ? BigInt(data.result) : null;

      return {
        gasPrice: gasPrice ?? NETWORKS.avalanche.fallbackGasPrice,
      };
    },
  },
  stellar: {
    key: "stellar",
    label: "Stellar Horizon",
    nativeToken: "XLM",
    usdRate: 0.13,
    gasLimit: 1n,
    fallbackGasPrice: 100n,
    fetcher: async () => {
      const response = await fetch("https://horizon.stellar.org/fee_stats", {
        headers: {
          accept: "application/json",
        },
      });

      if (!response.ok) {
        throw new Error("Unable to fetch Stellar fee stats");
      }

      const data = await response.json();
      const gasPrice = Number(data?.last_ledger_base_fee ?? 100);

      return {
        gasPrice: BigInt(gasPrice),
      };
    },
  },
};

function formatUsd(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value < 1 ? 4 : 2,
  }).format(value);
}

function formatToken(value, token) {
  const precision = token === "XLM" ? 6 : value < 1 ? 5 : 4;
  return `${value.toFixed(precision)} ${token}`;
}

function weiToToken(wei, token) {
  const divisor = token === "AVAX" ? 1e18 : 1e7;
  return Number(wei) / divisor;
}

function createPayload(network, tier, gasPrice) {
  if (network.key === "avalanche") {
    const tierGasPrice = BigInt(Math.max(1, Math.round(Number(gasPrice) * tier.multiplier)));
    const maxPriorityFeePerGas = BigInt(Math.max(1, Math.round(Number(gasPrice) * 0.12 * tier.multiplier)));

    return {
      type: "evm",
      chain: network.label,
      priority: tier.key,
      gasLimit: network.gasLimit.toString(),
      maxFeePerGas: tierGasPrice.toString(),
      maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
    };
  }

  const feeStroops = Math.max(1, Math.round(Number(gasPrice) * tier.multiplier));
  return {
    type: "stellar",
    chain: network.label,
    priority: tier.key,
    feeStroops,
    feeBid: `${(feeStroops / 1e7).toFixed(6)} ${network.nativeToken}`,
  };
}

export default function GasPrioritySelector({ nativeBalance = 0, onChange }) {
  const [networkKey, setNetworkKey] = useState("avalanche");
  const [priorityKey, setPriorityKey] = useState("medium");
  const [gasPrice, setGasPrice] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [refreshTick, setRefreshTick] = useState(0);

  const network = NETWORKS[networkKey];
  const tier = PRIORITY_TIERS.find((item) => item.key === priorityKey) ?? PRIORITY_TIERS[1];

  useEffect(() => {
    let cancelled = false;

    async function loadFees() {
      setIsLoading(true);
      setError(null);

      try {
        const result = await network.fetcher();
        if (cancelled) {
          return;
        }

        setGasPrice(result.gasPrice ?? network.fallbackGasPrice);
        setUpdatedAt(new Date());
      } catch (fetchError) {
        if (cancelled) {
          return;
        }

        setGasPrice(network.fallbackGasPrice);
        setError(fetchError instanceof Error ? fetchError.message : "Fee lookup failed");
        setUpdatedAt(new Date());
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    loadFees();

    return () => {
      cancelled = true;
    };
  }, [network, refreshTick]);

  const feeSummary = useMemo(() => {
    const currentGasPrice = gasPrice ?? network.fallbackGasPrice;
    const adjustedGasPrice = BigInt(Math.max(1, Math.round(Number(currentGasPrice) * tier.multiplier)));
    const estimatedNative = weiToToken(adjustedGasPrice * network.gasLimit, network.nativeToken);
    const estimatedUsd = estimatedNative * network.usdRate;

    return {
      estimatedNative,
      estimatedUsd,
      payload: createPayload(network, tier, currentGasPrice),
    };
  }, [gasPrice, network, tier]);

  useEffect(() => {
    onChange?.({
      network,
      tier,
      estimatedNative: feeSummary.estimatedNative,
      estimatedUsd: feeSummary.estimatedUsd,
      payload: feeSummary.payload,
    });
  }, [feeSummary, network, onChange, tier]);

  const nativeBalanceValue = Number(nativeBalance) || 0;
  const hasEnoughBalance = nativeBalanceValue >= feeSummary.estimatedNative;

  return (
    <section className="vq-glass-hover p-5 sm:p-6">
      <div className="flex flex-col gap-3 border-b border-vault-border/40 pb-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.24em] text-vault-muted">
            Gas priority
          </p>
          <h2 className="mt-1 text-xl font-semibold text-vault-text">
            Real-time fee selector
          </h2>
        </div>
        <button
          type="button"
          onClick={() => setRefreshTick((value) => value + 1)}
          className="vq-btn-ghost self-start sm:self-auto"
        >
          <RefreshCw className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
          Refresh rates
        </button>
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        {Object.values(NETWORKS).map((item) => {
          const selected = item.key === networkKey;

          return (
            <button
              key={item.key}
              type="button"
              onClick={() => setNetworkKey(item.key)}
              className={`rounded-2xl border p-4 text-left transition-all duration-300 ${
                selected
                  ? "border-red-400/40 bg-red-500/10 ring-2 ring-red-400/15"
                  : "border-vault-border/50 bg-vault-surface/25 hover:border-red-400/25 hover:bg-vault-surface/40"
              }`}
            >
              <p className="text-sm font-semibold text-vault-text">{item.label}</p>
              <p className="mt-1 text-xs text-vault-muted">
                Native token: {item.nativeToken}
              </p>
            </button>
          );
        })}
      </div>

      <div className="mt-5 grid gap-3 md:grid-cols-3">
        {PRIORITY_TIERS.map((item) => {
          const selected = item.key === priorityKey;
          const adjustedGasPrice = gasPrice ?? network.fallbackGasPrice;
          const estimatedNative = weiToToken(
            BigInt(Math.max(1, Math.round(Number(adjustedGasPrice) * item.multiplier))) * network.gasLimit,
            network.nativeToken,
          );

          return (
            <button
              key={item.key}
              type="button"
              onClick={() => setPriorityKey(item.key)}
              className={`rounded-2xl border p-4 text-left transition-all duration-300 ${
                selected
                  ? "border-red-400/40 bg-red-500/10 shadow-glow"
                  : "border-vault-border/50 bg-vault-surface/25 hover:border-red-400/25 hover:bg-vault-surface/40"
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-base font-semibold text-vault-text">{item.label}</p>
                  <p className="mt-1 text-xs text-vault-muted">{item.description}</p>
                </div>
                <span
                  className={`rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.24em] ${
                    selected ? "bg-red-500/15 text-red-500" : "bg-vault-border/30 text-vault-muted"
                  }`}
                >
                  {item.eta}
                </span>
              </div>
              <div className="mt-4 flex items-center justify-between text-sm">
                <span className="text-vault-muted">Estimated fee</span>
                <span className="font-semibold text-vault-text">
                  {formatToken(estimatedNative, network.nativeToken)}
                </span>
              </div>
            </button>
          );
        })}
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        <div className="vq-glass p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-vault-muted">
            Live rate
          </p>
          <p className="mt-1 text-lg font-semibold text-vault-text">
            {isLoading ? "Updating…" : gasPrice ? `${network.nativeToken} fee data` : "Waiting…"}
          </p>
          <p className="mt-1 text-xs text-vault-muted">
            {network.key === "avalanche"
              ? `${Number(gasPrice ?? network.fallbackGasPrice).toLocaleString()} wei`
              : `${Number(gasPrice ?? network.fallbackGasPrice).toLocaleString()} stroops`}
          </p>
        </div>

        <div className="vq-glass p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-vault-muted">
            Estimated cost
          </p>
          <p className="mt-1 text-lg font-semibold text-vault-text">
            {formatToken(feeSummary.estimatedNative, network.nativeToken)}
          </p>
          <p className="mt-1 text-xs text-vault-muted">
            {formatUsd(feeSummary.estimatedUsd)}
          </p>
        </div>

        <div className={`vq-glass p-4 ${hasEnoughBalance ? "" : "border-amber-400/30 bg-amber-500/10"}`}>
          <p className="text-xs font-medium uppercase tracking-wide text-vault-muted">
            Balance check
          </p>
          <p
            className={`mt-1 text-lg font-semibold ${
              hasEnoughBalance ? "text-emerald-500 dark:text-emerald-400" : "text-amber-500 dark:text-amber-400"
            }`}
          >
            {hasEnoughBalance ? "Ready to send" : "Gas balance low"}
          </p>
          <p className="mt-1 text-xs text-vault-muted">
            Wallet: {formatToken(nativeBalanceValue, network.nativeToken)}
          </p>
        </div>
      </div>

      {(error || !hasEnoughBalance) && (
        <div
          role="alert"
          aria-live="assertive"
          className={`mt-5 flex items-start gap-3 rounded-2xl border p-4 text-sm ${
            error
              ? "border-amber-500/40 bg-amber-500/10 text-amber-200"
              : "border-amber-400/35 bg-amber-500/10 text-amber-100"
          }`}
        >
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-300" aria-hidden="true" />
          <div>
            <p className="font-semibold text-vault-text">Network warning</p>
            <p className="mt-1 text-vault-muted">
              {error
                ? `${error}. Showing fallback fee data while the RPC request is unavailable.`
                : `Your wallet balance is below the estimated ${network.nativeToken} gas cost for the ${tier.label.toLowerCase()} priority tier.`}
            </p>
          </div>
        </div>
      )}

      <div className="mt-5 grid gap-3 lg:grid-cols-[1.2fr_0.8fr]">
        <div className="rounded-2xl border border-vault-border/50 bg-vault-surface/25 p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-vault-text">
            <Activity className="h-4 w-4 text-red-500" aria-hidden="true" />
            Execution payload
          </div>
          <pre className="mt-3 overflow-auto rounded-xl bg-slate-950/80 p-4 text-xs leading-relaxed text-slate-200">
            {JSON.stringify(
              {
                network: network.label,
                priority: tier.label,
                estimatedNative: formatToken(feeSummary.estimatedNative, network.nativeToken),
                estimatedUsd: formatUsd(feeSummary.estimatedUsd),
                payload: feeSummary.payload,
              },
              null,
              2,
            )}
          </pre>
        </div>

        <div className="rounded-2xl border border-vault-border/50 bg-vault-surface/25 p-4">
          <p className="text-sm font-semibold text-vault-text">Live status</p>
          <p className="mt-2 text-sm text-vault-muted">
            {updatedAt
              ? `Updated ${updatedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
              : "Fetching fresh fee data from the network"}
          </p>
          <div className="mt-4 rounded-2xl border border-vault-border/40 bg-vault-surface/40 p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-vault-muted">
              Selected tier
            </p>
            <p className="mt-1 text-lg font-semibold text-vault-text">{tier.label}</p>
            <p className="mt-1 text-xs text-vault-muted">{tier.description}</p>
            <div className="mt-4 flex items-center gap-2 text-sm font-semibold text-red-500 dark:text-red-400">
              <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
              {tier.eta} target inclusion
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}