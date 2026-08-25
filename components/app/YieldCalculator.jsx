"use client";

import { useState, useMemo } from "react";
import { Calculator, TrendingUp, Percent, Calendar } from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";

const TRADITIONAL_BANK_APY = 0.5; // 0.5% typical savings account
const VAULTQUEST_BASE_APY = 4.5; // 4.5% base yield

export default function YieldCalculator() {
  const [principal, setPrincipal] = useState(5000);
  const [customAPY, setCustomAPY] = useState(VAULTQUEST_BASE_APY);
  const [years, setYears] = useState(3);
  const [showCustomAPY, setShowCustomAPY] = useState(false);

  const calculateCompoundInterest = (p, r, t) => {
    // Compound interest formula: A = P(1 + r/n)^(nt)
    // Assuming monthly compounding (n = 12)
    const n = 12;
    return p * Math.pow(1 + r / 100 / n, n * t);
  };

  const comparisonData = useMemo(() => {
    const data = [];
    for (let year = 1; year <= years; year++) {
      const bankTotal = calculateCompoundInterest(
        principal,
        TRADITIONAL_BANK_APY,
        year,
      );
      const vaultTotal = calculateCompoundInterest(principal, customAPY, year);

      data.push({
        year: `Year ${year}`,
        "Traditional Bank": Math.round(bankTotal),
        VaultQuest: Math.round(vaultTotal),
        bankEarnings: Math.round(bankTotal - principal),
        vaultEarnings: Math.round(vaultTotal - principal),
      });
    }
    return data;
  }, [principal, customAPY, years]);

  const finalYear = comparisonData[comparisonData.length - 1];
  const difference = finalYear["VaultQuest"] - finalYear["Traditional Bank"];
  const percentageGain = (
    (difference / finalYear["Traditional Bank"]) *
    100
  ).toFixed(1);

  const CustomTooltip = ({ active, payload }) => {
    if (active && payload && payload.length) {
      return (
        <div className="vq-glass border border-vault-border/80 bg-vault-surface/95 px-4 py-3 shadow-glow backdrop-blur-md">
          <p className="text-xs font-bold text-vault-text">
            {payload[0].payload.year}
          </p>
          <div className="mt-2 space-y-1">
            <div className="flex items-center justify-between gap-4">
              <span className="flex items-center gap-1.5 text-xs text-vault-muted">
                <span className="h-2 w-2 rounded-full bg-slate-500" />
                Traditional Bank
              </span>
              <span className="text-xs font-semibold text-vault-text">
                ${payload[0].value.toLocaleString()}
              </span>
            </div>
            <div className="flex items-center justify-between gap-4">
              <span className="flex items-center gap-1.5 text-xs text-vault-muted">
                <span className="h-2 w-2 rounded-full bg-red-500" />
                VaultQuest
              </span>
              <span className="text-xs font-semibold text-vault-text">
                ${payload[1].value.toLocaleString()}
              </span>
            </div>
          </div>
          <div className="mt-2 border-t border-vault-border/50 pt-2">
            <p className="text-xs text-vault-muted">
              Earnings: ${payload[0].payload.vaultEarnings.toLocaleString()} vs
              ${payload[0].payload.bankEarnings.toLocaleString()}
            </p>
          </div>
        </div>
      );
    }
    return null;
  };

  return (
    <section className="vq-glass p-4 sm:p-6 lg:p-8">
      <div className="mb-6 flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-vault-border/30 pb-4">
        <div className="flex items-center gap-2">
          <Calculator className="h-6 w-6 text-red-500" aria-hidden="true" />
          <h2 className="text-lg sm:text-xl font-bold text-vault-text">
            Savings Calculator
          </h2>
        </div>
        <span className="self-start sm:self-auto rounded-full bg-red-500/15 px-2.5 py-1 text-xs font-medium text-red-600 dark:text-red-400">
          Interactive
        </span>
      </div>

      <p className="mb-6 text-sm text-vault-muted">
        Compare VaultQuest&apos;s prize-linked savings with traditional bank
        accounts. Adjust the parameters below to see how much more you could
        earn while having chances to win prizes.
      </p>

      {/* Input Controls */}
      <div className="mb-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {/* Principal Amount */}
        <div className="space-y-2">
          <label
            htmlFor="principal"
            className="flex items-center gap-2 text-sm font-medium text-vault-text"
          >
            <TrendingUp className="h-4 w-4 text-red-500" aria-hidden="true" />
            Initial Deposit
          </label>
          <input
            id="principal"
            type="range"
            min="100"
            max="50000"
            step="100"
            value={principal}
            onChange={(e) => setPrincipal(Number(e.target.value))}
            className="h-2 w-full cursor-pointer appearance-none rounded-lg bg-vault-border accent-red-500"
          />
          <div className="flex items-center justify-between">
            <input
              type="number"
              value={principal}
              onChange={(e) =>
                setPrincipal(
                  Math.max(100, Math.min(50000, Number(e.target.value))),
                )
              }
              className="w-28 rounded-lg border border-vault-border bg-vault-surface px-3 py-1.5 text-sm font-semibold text-vault-text focus:border-red-400 focus:outline-none focus:ring-2 focus:ring-red-400/30"
            />
            <span className="text-xs text-vault-muted">$100 - $50,000</span>
          </div>
        </div>

        {/* Time Period */}
        <div className="space-y-2">
          <label
            htmlFor="years"
            className="flex items-center gap-2 text-sm font-medium text-vault-text"
          >
            <Calendar className="h-4 w-4 text-red-500" aria-hidden="true" />
            Time Period
          </label>
          <input
            id="years"
            type="range"
            min="1"
            max="10"
            step="1"
            value={years}
            onChange={(e) => setYears(Number(e.target.value))}
            className="h-2 w-full cursor-pointer appearance-none rounded-lg bg-vault-border accent-red-500"
          />
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-vault-text">
              {years} {years === 1 ? "Year" : "Years"}
            </span>
            <span className="text-xs text-vault-muted">1 - 10 years</span>
          </div>
        </div>

        {/* Custom APY */}
        <div className="space-y-2">
          <label
            htmlFor="custom-apy"
            className="flex items-center gap-2 text-sm font-medium text-vault-text"
          >
            <Percent className="h-4 w-4 text-red-500" aria-hidden="true" />
            VaultQuest APY
            <button
              type="button"
              onClick={() => setShowCustomAPY(!showCustomAPY)}
              className="ml-auto text-xs text-red-500 hover:text-red-600"
            >
              {showCustomAPY ? "Reset" : "Customize"}
            </button>
          </label>
          {showCustomAPY ? (
            <>
              <input
                id="custom-apy"
                type="range"
                min="1"
                max="15"
                step="0.1"
                value={customAPY}
                onChange={(e) => setCustomAPY(Number(e.target.value))}
                className="h-2 w-full cursor-pointer appearance-none rounded-lg bg-vault-border accent-red-500"
              />
              <div className="flex items-center justify-between">
                <input
                  type="number"
                  value={customAPY}
                  onChange={(e) =>
                    setCustomAPY(
                      Math.max(1, Math.min(15, Number(e.target.value))),
                    )
                  }
                  step="0.1"
                  className="w-20 rounded-lg border border-vault-border bg-vault-surface px-3 py-1.5 text-sm font-semibold text-vault-text focus:border-red-400 focus:outline-none focus:ring-2 focus:ring-red-400/30"
                />
                <span className="text-xs text-vault-muted">1% - 15%</span>
              </div>
            </>
          ) : (
            <div className="flex h-10 items-center rounded-lg border border-vault-border bg-vault-surface/40 px-3">
              <span className="text-sm font-semibold text-vault-text">
                {customAPY}%
              </span>
              <span className="ml-2 text-xs text-vault-muted">Base rate</span>
            </div>
          )}
        </div>
      </div>

      {/* Comparison Chart */}
      <div className="mb-6 rounded-xl border border-vault-border bg-vault-surface/20 p-4">
        <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <h3 className="text-sm font-semibold text-vault-text">
            Growth Comparison
          </h3>
          <div className="flex flex-wrap gap-3 text-xs">
            <div className="flex items-center gap-1.5">
              <span className="h-3 w-3 rounded bg-slate-500" />
              <span className="text-vault-muted">
                Traditional Bank ({TRADITIONAL_BANK_APY}%)
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="h-3 w-3 rounded bg-red-500" />
              <span className="text-vault-muted">
                VaultQuest ({customAPY}%)
              </span>
            </div>
          </div>
        </div>

        <div className="h-64 w-full sm:h-80">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={comparisonData}
              margin={{ top: 10, right: 10, left: -10, bottom: 0 }}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="var(--vq-border)"
                opacity={0.2}
                vertical={false}
              />
              <XAxis
                dataKey="year"
                stroke="var(--vq-muted)"
                fontSize={11}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                stroke="var(--vq-muted)"
                fontSize={11}
                tickLine={false}
                axisLine={false}
                tickFormatter={(value) => value >= 1000 ? `$${(value / 1000).toFixed(0)}k` : `$${value}`}
              />
              <Tooltip
                content={<CustomTooltip />}
                cursor={{ fill: "var(--vq-border)", opacity: 0.1 }}
              />
              <Bar
                dataKey="Traditional Bank"
                fill="#64748b"
                radius={[8, 8, 0, 0]}
              />
              <Bar dataKey="VaultQuest" fill="#ef4444" radius={[8, 8, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Results Summary */}
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="vq-glass-hover p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-vault-muted">
            Traditional Bank
          </p>
          <p className="mt-2 text-2xl font-bold text-vault-text">
            ${finalYear["Traditional Bank"].toLocaleString()}
          </p>
          <p className="mt-1 text-xs text-vault-muted">
            Earnings: ${finalYear.bankEarnings.toLocaleString()}
          </p>
        </div>

        <div className="vq-glass-hover border-red-400/30 p-4 ring-2 ring-red-400/20">
          <p className="text-xs font-medium uppercase tracking-wide text-vault-muted">
            VaultQuest
          </p>
          <p className="mt-2 text-2xl font-bold text-vault-text">
            ${finalYear["VaultQuest"].toLocaleString()}
          </p>
          <p className="mt-1 text-xs text-vault-muted">
            Earnings: ${finalYear.vaultEarnings.toLocaleString()}
          </p>
        </div>

        <div className="vq-glass-hover bg-emerald-500/10 p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-emerald-600 dark:text-emerald-400">
            Your Advantage
          </p>
          <p className="mt-2 text-2xl font-bold text-emerald-600 dark:text-emerald-400">
            +${difference.toLocaleString()}
          </p>
          <p className="mt-1 text-xs text-vault-muted">
            {percentageGain}% more earnings
          </p>
        </div>
      </div>

      {/* Additional Benefits */}
      <div className="mt-6 rounded-lg border border-vault-border bg-vault-surface/40 p-4">
        <h3 className="mb-3 text-sm font-semibold text-vault-text">
          Plus, with VaultQuest you also get:
        </h3>
        <ul className="space-y-2 text-sm text-vault-muted">
          <li className="flex items-start gap-2">
            <span className="mt-0.5 text-red-500">✓</span>
            <span>Weekly chances to win prizes from pooled yield</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="mt-0.5 text-red-500">✓</span>
            <span>100% principal protection - withdraw anytime</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="mt-0.5 text-red-500">✓</span>
            <span>Transparent blockchain-based prize draws</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="mt-0.5 text-red-500">✓</span>
            <span>No fees, no lock-up periods</span>
          </li>
        </ul>
      </div>
    </section>
  );
}
