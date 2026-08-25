"use client";

import { useState, useEffect, useMemo } from "react";
import dynamic from "next/dynamic";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, LineChart, Line, XAxis, YAxis, CartesianGrid } from "recharts";
import { Coins, TrendingUp } from "lucide-react";

// Asset mapping and color configuration
const ASSET_COLORS = {
  USDC: "#10b981", // Emerald 500
  XLM: "#3b82f6",  // Blue 500
  AVAX: "#ef4444", // Red 500
};

// Map transaction pools to assets
const getAssetForTx = (tx) => {
  if (tx.asset) return tx.asset;
  const pool = (tx.pool || "").toLowerCase();
  if (pool.includes("usdc") || pool.includes("community drip")) return "USDC";
  if (pool.includes("xlm") || pool.includes("high-yield")) return "XLM";
  if (pool.includes("avax") || pool.includes("starter")) return "AVAX";
  return "USDC";
};

// Skeleton component to ensure zero layout shift during loading / SSR
function ChartSkeleton() {
  return (
    <div className="vq-glass p-6 min-h-[400px] flex flex-col justify-between animate-pulse">
      <div className="flex items-center justify-between border-b border-vault-border/50 pb-4">
        <div className="h-6 w-48 bg-vault-border/40 rounded"></div>
        <div className="h-4 w-24 bg-vault-border/30 rounded"></div>
      </div>
      <div className="flex flex-col lg:flex-row gap-6 items-center justify-center py-6 h-64">
        <div className="w-48 h-48 rounded-full border-8 border-vault-border/20 flex items-center justify-center">
          <div className="w-32 h-32 rounded-full border-8 border-vault-border/30"></div>
        </div>
        <div className="w-full max-w-xs space-y-3">
          <div className="h-4 bg-vault-border/40 rounded w-3/4"></div>
          <div className="h-4 bg-vault-border/30 rounded w-1/2"></div>
          <div className="h-4 bg-vault-border/30 rounded w-5/6"></div>
        </div>
      </div>
    </div>
  );
}

function DepositAnalytics({ transactions = [], selectedAsset, onSelectAsset }) {
  // 1. Calculate Pie Chart Data dynamically from Transactions + Baselines
  const pieData = useMemo(() => {
    // Baselines matching the cumulative deposit progression
    const baselines = { USDC: 800, XLM: 237.5, AVAX: 200 };
    const totals = { ...baselines };

    transactions.forEach((tx) => {
      const asset = getAssetForTx(tx);
      if (tx.type === "deposit" || tx.type === "reward") {
        totals[asset] += tx.amount;
      } else if (tx.type === "withdraw") {
        totals[asset] = Math.max(0, totals[asset] - tx.amount);
      }
    });

    const totalSum = Object.values(totals).reduce((sum, val) => sum + val, 0);

    return Object.keys(totals).map((asset) => ({
      name: asset,
      value: totals[asset],
      percentage: totalSum > 0 ? ((totals[asset] / totalSum) * 100).toFixed(1) : 0,
      color: ASSET_COLORS[asset],
    }));
  }, [transactions]);

  // Total balance computed dynamically
  const totalBalance = useMemo(() => {
    return pieData.reduce((sum, item) => sum + item.value, 0);
  }, [pieData]);

  // 2. Calculate Monthly Line Chart progression dynamically
  const lineData = useMemo(() => {
    // Initial baselines for past months
    const history = [
      { name: "Dec", balance: 400, month: 11, year: 2025 },
      { name: "Jan", balance: 800, month: 0, year: 2026 },
      { name: "Feb", balance: 1100, month: 1, year: 2026 },
      { name: "Mar", balance: 1237.5, month: 2, year: 2026 },
    ];

    // April net calculation
    const aprilTx = transactions.filter((tx) => {
      const d = new Date(tx.date);
      return d.getMonth() === 3 && d.getFullYear() === 2026;
    });
    let aprilChange = 0;
    aprilTx.forEach((tx) => {
      if (tx.type === "deposit" || tx.type === "reward") aprilChange += tx.amount;
      else if (tx.type === "withdraw") aprilChange -= tx.amount;
    });
    const aprilBalance = history[3].balance + aprilChange;
    history.push({ name: "Apr", balance: aprilBalance, month: 3, year: 2026 });

    // May net calculation
    const mayTx = transactions.filter((tx) => {
      const d = new Date(tx.date);
      return d.getMonth() === 4 && d.getFullYear() === 2026;
    });
    let mayChange = 0;
    mayTx.forEach((tx) => {
      if (tx.type === "deposit" || tx.type === "reward") mayChange += tx.amount;
      else if (tx.type === "withdraw") mayChange -= tx.amount;
    });
    const mayBalance = aprilBalance + mayChange;
    history.push({ name: "May", balance: mayBalance, month: 4, year: 2026 });

    return history;
  }, [transactions]);

  // Custom tooltips
  const CustomPieTooltip = ({ active, payload }) => {
    if (active && payload && payload.length) {
      const data = payload[0].payload;
      return (
        <div className="vq-glass border border-vault-border/80 bg-vault-surface/95 px-3 py-2 text-xs shadow-glow backdrop-blur-md">
          <p className="font-bold text-vault-text flex items-center gap-1.5">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: data.color }}
            />
            {data.name} Allocation
          </p>
          <p className="mt-1 font-semibold text-vault-text">
            ${data.value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </p>
          <p className="text-[10px] text-vault-muted mt-0.5">{data.percentage}% of total</p>
        </div>
      );
    }
    return null;
  };

  const CustomLineTooltip = ({ active, payload }) => {
    if (active && payload && payload.length) {
      const data = payload[0].payload;
      return (
        <div className="vq-glass border border-vault-border/80 bg-vault-surface/95 px-3 py-2 text-xs shadow-glow backdrop-blur-md">
          <p className="font-bold text-vault-text">{data.name} 2026</p>
          <p className="mt-1 font-semibold text-vault-text">
            Balance: ${data.balance.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </p>
        </div>
      );
    }
    return null;
  };

  return (
    <section className="grid grid-cols-1 lg:grid-cols-2 gap-6" aria-label="Deposit Analytics">
      {/* Distribution Card */}
      <article className="vq-glass p-5 flex flex-col justify-between min-h-[400px]">
        <div className="flex items-center justify-between border-b border-vault-border/30 pb-3">
          <div className="flex items-center gap-2">
            <Coins className="h-5 w-5 text-red-500" aria-hidden="true" />
            <h2 className="text-base font-semibold text-vault-text">Deposit Allocation</h2>
          </div>
          <span className="text-xs text-vault-muted font-medium">Click slices to filter list</span>
        </div>

        <div className="flex flex-col sm:flex-row items-center justify-center gap-4 py-4 flex-grow">
          {/* Pie Chart container */}
          <div className="w-52 h-52 shrink-0 relative">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={pieData}
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={80}
                  paddingAngle={4}
                  dataKey="value"
                  onClick={(data) => {
                    if (onSelectAsset) {
                      // Toggle filter on click
                      onSelectAsset(selectedAsset === data.name ? "all" : data.name);
                    }
                  }}
                  cursor="pointer"
                >
                  {pieData.map((entry, index) => {
                    const isSelected = selectedAsset === entry.name;
                    const isAnySelected = selectedAsset !== "all";
                    return (
                      <Cell
                        key={`cell-${index}`}
                        fill={entry.color}
                        opacity={isAnySelected && !isSelected ? 0.35 : 1}
                        stroke={isSelected ? "var(--vq-text)" : "var(--vq-border)"}
                        strokeWidth={isSelected ? 2 : 1}
                        className="transition-all duration-300 focus:outline-none"
                      />
                    );
                  })}
                </Pie>
                <Tooltip content={<CustomPieTooltip />} />
              </PieChart>
            </ResponsiveContainer>
            {/* Center label */}
            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
              <span className="text-[10px] uppercase font-bold tracking-wider text-vault-muted">Total Balance</span>
              <span className="text-lg font-extrabold text-vault-text mt-0.5">
                ${totalBalance.toLocaleString("en-US", { maximumFractionDigits: 0 })}
              </span>
            </div>
          </div>

          {/* Legend and stats */}
          <div className="flex-grow space-y-3 w-full sm:max-w-xs">
            {pieData.map((item) => {
              const isSelected = selectedAsset === item.name;
              return (
                <button
                  key={item.name}
                  type="button"
                  onClick={() => onSelectAsset(selectedAsset === item.name ? "all" : item.name)}
                  className={`w-full flex items-center justify-between p-2 rounded-xl border text-left transition-all duration-300 ${
                    isSelected
                      ? "border-red-400 bg-red-500/10 ring-1 ring-red-400/20"
                      : "border-vault-border/40 hover:border-vault-border bg-vault-surface/20"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className="h-3 w-3 rounded-full shrink-0"
                      style={{ backgroundColor: item.color }}
                    />
                    <span className="text-xs font-semibold text-vault-text">{item.name}</span>
                  </div>
                  <div className="text-right">
                    <span className="text-xs font-bold text-vault-text block">
                      ${item.value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                    <span className="text-[10px] text-vault-muted block">{item.percentage}%</span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </article>

      {/* Progression Card */}
      <article className="vq-glass p-5 flex flex-col justify-between min-h-[400px]">
        <div className="flex items-center justify-between border-b border-vault-border/30 pb-3">
          <div className="flex items-center gap-2">
            <TrendingUp className="h-5 w-5 text-red-500" aria-hidden="true" />
            <h2 className="text-base font-semibold text-vault-text">Savings Progression</h2>
          </div>
          <span className="text-xs text-vault-muted font-medium">Cumulative growth</span>
        </div>

        <div className="w-full h-64 py-4 flex-grow">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={lineData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--vq-border)" opacity={0.2} vertical={false} />
              <XAxis
                dataKey="name"
                stroke="var(--vq-muted)"
                fontSize={11}
                tickLine={false}
                axisLine={false}
                dy={10}
              />
              <YAxis
                stroke="var(--vq-muted)"
                fontSize={11}
                tickLine={false}
                axisLine={false}
                dx={-5}
                tickFormatter={(value) => `$${value}`}
              />
              <Tooltip content={<CustomLineTooltip />} />
              <Line
                type="monotone"
                dataKey="balance"
                stroke="var(--vq-accent)"
                strokeWidth={3}
                dot={{ r: 4, stroke: "var(--vq-bg)", strokeWidth: 2, fill: "var(--vq-accent)" }}
                activeDot={{ r: 6, stroke: "var(--vq-accent-glow)", strokeWidth: 4, fill: "var(--vq-accent)" }}
                animationDuration={1000}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </article>
    </section>
  );
}

// Ensure component only runs on client and doesn't mismatch server HTML or cause layout shift
export default function DepositAnalyticsCard(props) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return <ChartSkeleton />;
  }

  return <DepositAnalytics {...props} />;
}
