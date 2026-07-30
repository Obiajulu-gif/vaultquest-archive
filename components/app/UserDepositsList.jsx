"use client";

import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Filter } from "lucide-react";
import { formatDateTime, formatCurrency } from "@/lib/formatting";

const PAGE_SIZE = 5;

const TYPE_LABELS = {
  deposit: "Deposit",
  withdraw: "Withdraw",
  reward: "Prize won",
};

const getAssetForTx = (tx) => {
  if (tx.asset) return tx.asset;
  const pool = (tx.pool || "").toLowerCase();
  if (pool.includes("usdc") || pool.includes("community drip")) return "USDC";
  if (pool.includes("xlm") || pool.includes("high-yield")) return "XLM";
  if (pool.includes("avax") || pool.includes("starter")) return "AVAX";
  return "USDC";
};

/**
 * @param {{ transactions: Array<{ id: string, type: string, pool: string, asset?: string, amount: number, date: string, status: string }>, selectedAsset?: string, onClearAsset?: () => void }} props
 */
export default function UserDepositsList({ transactions = [], selectedAsset = "all", onClearAsset }) {
  const [filter, setFilter] = useState("all");
  const [page, setPage] = useState(0);
  const locale = typeof navigator !== "undefined" ? navigator.language : "en";

  const filtered = useMemo(() => {
    let result = transactions;
    if (filter !== "all") {
      result = result.filter((tx) => tx.type === filter);
    }
    if (selectedAsset !== "all") {
      result = result.filter((tx) => getAssetForTx(tx) === selectedAsset);
    }
    return result;
  }, [transactions, filter, selectedAsset]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const slice = filtered.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  return (
    <section className="vq-glass p-4 sm:p-6" aria-label="Transaction history">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-3">
          <div>
            <h2 className="text-lg font-semibold text-vault-text">Past transactions</h2>
            <p className="text-sm text-vault-muted">Filter and browse your pool activity</p>
          </div>
          {selectedAsset !== "all" && (
            <div className="inline-flex items-center gap-1.5 rounded-full bg-red-500/10 border border-red-500/20 px-2.5 py-1 text-xs font-semibold text-red-500 dark:text-red-400">
              <span>Asset: {selectedAsset}</span>
              <button
                type="button"
                onClick={onClearAsset}
                className="hover:text-red-700 dark:hover:text-red-300 font-bold ml-0.5 px-0.5 transition-colors focus:outline-none"
                aria-label={`Clear ${selectedAsset} filter`}
              >
                &times;
              </button>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Filter className="h-4 w-4 text-vault-muted" aria-hidden="true" />
          <label htmlFor="tx-filter" className="sr-only">
            Filter transactions
          </label>
          <select
            id="tx-filter"
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              setPage(0);
            }}
            className="rounded-xl border border-vault-border bg-vault-surface px-3 py-2 text-sm text-vault-text transition-all duration-300 focus:outline-none focus:ring-2 focus:ring-red-400"
          >
            <option value="all">All types</option>
            <option value="deposit">Deposits</option>
            <option value="withdraw">Withdrawals</option>
            <option value="reward">Prizes</option>
          </select>
        </div>
      </div>

      {filtered.length === 0 ? (
        <p className="mt-8 text-center text-sm text-vault-muted">No transactions match this filter.</p>
      ) : (
        <ul className="mt-4 divide-y divide-vault-border">
          {slice.map((tx) => (
            <li
              key={tx.id}
              className="flex flex-wrap items-center justify-between gap-2 py-3 transition-all duration-300"
            >
              <div className="min-w-0">
                <p className="font-medium text-vault-text">
                  {TYPE_LABELS[tx.type] ?? tx.type}
                  <span className="text-vault-muted"> · {tx.pool}</span>
                </p>
                <p className="text-xs text-vault-muted">
                  {formatDateTime(tx.date, { locale })}
                </p>
              </div>
              <div className="text-right">
                <p
                  className={`font-semibold ${
                    tx.type === "withdraw" ? "text-vault-muted" : "text-emerald-600 dark:text-emerald-400"
                  }`}
                >
                  {tx.type === "withdraw" ? "−" : "+"}
                  {formatCurrency(tx.amount, "USD", { locale, minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                </p>
                <p className="text-xs capitalize text-vault-muted">{tx.status}</p>
              </div>
            </li>
          ))}
        </ul>
      )}

      {filtered.length > PAGE_SIZE && (
        <div className="mt-4 flex items-center justify-between border-t border-vault-border pt-4">
          <button
            type="button"
            disabled={safePage === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            className="vq-btn-ghost disabled:opacity-40"
            aria-label="Previous page"
          >
            <ChevronLeft className="h-4 w-4" />
            Prev
          </button>
          <span className="text-sm text-vault-muted">
            Page {safePage + 1} of {pageCount}
          </span>
          <button
            type="button"
            disabled={safePage >= pageCount - 1}
            onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
            className="vq-btn-ghost disabled:opacity-40"
            aria-label="Next page"
          >
            Next
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      )}
    </section>
  );
}
