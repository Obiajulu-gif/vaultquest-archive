"use client";

import { useMemo, useState } from "react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from "recharts";
import { BarChart3 } from "lucide-react";
import { DEMO_TRANSACTIONS } from "@/lib/demo-portfolio";

const SERIES_CONTROLS = [
  { key: "principal", label: "Principal", color: "#0f172a" },
  { key: "yield", label: "Yield", color: "#f59e0b" },
];

function monthKey(date) {
  return new Intl.DateTimeFormat("en-US", { month: "short", year: "2-digit" }).format(new Date(date));
}

function formatCurrency(value) {
  return `$${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function buildSeries() {
  const sorted = [...DEMO_TRANSACTIONS].sort((left, right) => new Date(left.date) - new Date(right.date));
  const months = [];
  const seen = new Set();

  sorted.forEach((tx) => {
    const key = monthKey(tx.date);
    if (!seen.has(key)) {
      seen.add(key);
      months.push(key);
    }
  });

  let principal = 1100;
  let yieldValue = 42;

  return months.map((month) => {
    sorted
      .filter((tx) => monthKey(tx.date) === month)
      .forEach((tx) => {
        if (tx.type === "deposit") {
          principal += tx.amount;
        }

        if (tx.type === "withdraw") {
          principal = Math.max(0, principal - tx.amount);
        }

        if (tx.type === "reward") {
          yieldValue += tx.amount;
        }
      });

    return {
      month,
      principal: Number(principal.toFixed(2)),
      yield: Number(yieldValue.toFixed(2)),
      total: Number((principal + yieldValue).toFixed(2)),
    };
  });
}

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) {
    return null;
  }

  const principal = payload.find((entry) => entry.dataKey === "principal")?.value ?? 0;
  const yieldValue = payload.find((entry) => entry.dataKey === "yield")?.value ?? 0;

  return (
    <div className="vq-glass border border-vault-border/80 bg-vault-surface/95 px-4 py-3 shadow-glow backdrop-blur-md">
      <p className="text-xs font-bold text-vault-text">{label}</p>
      <div className="mt-2 space-y-1 text-xs">
        <div className="flex items-center justify-between gap-6">
          <span className="text-vault-muted">Principal</span>
          <span className="font-semibold text-vault-text">{formatCurrency(principal)}</span>
        </div>
        <div className="flex items-center justify-between gap-6">
          <span className="text-vault-muted">Yield</span>
          <span className="font-semibold text-vault-text">{formatCurrency(yieldValue)}</span>
        </div>
        <div className="flex items-center justify-between gap-6 border-t border-vault-border/50 pt-2">
          <span className="text-vault-muted">Total</span>
          <span className="font-semibold text-vault-text">{formatCurrency(principal + yieldValue)}</span>
        </div>
      </div>
    </div>
  );
}

export default function PrizeChart() {
  const [visible, setVisible] = useState({ principal: true, yield: true });

  const data = useMemo(() => buildSeries(), []);
  const latest = data[data.length - 1] ?? { principal: 0, yield: 0, total: 0 };

  return (
    <section className="vq-glass-hover p-5 sm:p-6">
      <div className="flex flex-col gap-3 border-b border-vault-border/40 pb-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.24em] text-vault-muted">
            <BarChart3 className="h-4 w-4 text-red-500" aria-hidden="true" />
            Deposit history
          </div>
          <h2 className="mt-1 text-xl font-semibold text-vault-text">
            Principal and yield overlay
          </h2>
        </div>

        <div className="flex flex-wrap gap-2">
          {SERIES_CONTROLS.map((series) => {
            const active = visible[series.key];
            return (
              <button
                key={series.key}
                type="button"
                onClick={() => setVisible((current) => ({ ...current, [series.key]: !current[series.key] }))}
                className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition-all duration-300 ${active ? "border-red-400/30 bg-red-500/10 text-red-500" : "border-vault-border/50 bg-vault-surface/30 text-vault-muted"}`}
              >
                {series.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="mt-5 aspect-[16/9] min-h-[360px] rounded-3xl border border-vault-border/40 bg-vault-surface/25 p-3 sm:p-4">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 10, right: 18, left: 0, bottom: 8 }}>
            <CartesianGrid stroke="var(--vq-border)" strokeDasharray="3 3" opacity={0.22} vertical={false} />
            <XAxis dataKey="month" tickLine={false} axisLine={false} stroke="var(--vq-muted)" fontSize={11} />
            <YAxis
              yAxisId="left"
              tickLine={false}
              axisLine={false}
              stroke="var(--vq-muted)"
              fontSize={11}
              tickFormatter={(value) => `$${Math.round(value / 1000)}k`}
            />
            <YAxis
              yAxisId="right"
              orientation="right"
              tickLine={false}
              axisLine={false}
              stroke="var(--vq-muted)"
              fontSize={11}
              tickFormatter={(value) => `$${Math.round(value)}`}
            />
            <Legend
              verticalAlign="top"
              align="right"
              wrapperStyle={{ paddingBottom: 8, fontSize: 12 }}
              formatter={(value) => <span style={{ color: "var(--vq-muted)" }}>{value}</span>}
            />
            <Tooltip content={<ChartTooltip />} />
            {visible.principal && (
              <Line
                yAxisId="left"
                type="monotone"
                dataKey="principal"
                name="Principal"
                stroke="var(--vq-text)"
                strokeWidth={3}
                dot={{ r: 4, stroke: "var(--vq-bg)", strokeWidth: 2, fill: "var(--vq-text)" }}
                activeDot={{ r: 6, stroke: "var(--vq-text)", strokeWidth: 4, fill: "var(--vq-text)" }}
              />
            )}
            {visible.yield && (
              <Line
                yAxisId="right"
                type="monotone"
                dataKey="yield"
                name="Yield"
                stroke="#f59e0b"
                strokeWidth={3}
                dot={{ r: 4, stroke: "var(--vq-bg)", strokeWidth: 2, fill: "#f59e0b" }}
                activeDot={{ r: 6, stroke: "rgba(245, 158, 11, 0.45)", strokeWidth: 4, fill: "#f59e0b" }}
              />
            )}
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        <div className="vq-glass p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-vault-muted">Latest principal</p>
          <p className="mt-1 text-2xl font-bold text-vault-text">{formatCurrency(latest.principal)}</p>
        </div>
        <div className="vq-glass p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-vault-muted">Latest yield</p>
          <p className="mt-1 text-2xl font-bold text-amber-500 dark:text-amber-400">{formatCurrency(latest.yield)}</p>
        </div>
        <div className="vq-glass p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-vault-muted">Combined balance</p>
          <p className="mt-1 text-2xl font-bold text-emerald-500 dark:text-emerald-400">{formatCurrency(latest.total)}</p>
        </div>
      </div>
    </section>
  );
}