"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "next-i18next";
import { X } from "lucide-react";
import { formatDateTime } from "@/lib/formatting";

const PAGE_SIZE = 10;

export default function TransactionHistoryModal({ open, onClose, walletAddress }) {
  const { t } = useTranslation("common");
  const locale = typeof navigator !== "undefined" ? navigator.language : "en";
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [items, setItems] = useState([]);
  const [totalCount, setTotalCount] = useState(0);

  const totalPages = useMemo(
    () => Math.max(1, Math.ceil(totalCount / PAGE_SIZE)),
    [totalCount]
  );

  useEffect(() => {
    if (!open || !walletAddress) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetch(`/api/actions/${encodeURIComponent(walletAddress)}?page=${page}&limit=${PAGE_SIZE}`)
      .then(async (res) => {
        if (!res.ok) throw new Error("Failed to load");
        return res.json();
      })
      .then((data) => {
        if (!cancelled) {
          setItems(data.data || []);
          setTotalCount(data.totalCount || 0);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || "Error");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, walletAddress, page]);

  useEffect(() => {
    if (open) setPage(1);
  }, [open, walletAddress]);

  if (!open) return null;

  const statusLabels = {
    pending: t("activity.status.pending"),
    submitted: t("activity.status.submitted"),
    confirmed: t("activity.status.confirmed"),
    failed: t("activity.status.failed"),
    canceled: t("activity.status.canceled"),
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full max-w-3xl overflow-hidden rounded-xl border border-vault-border bg-vault-bg shadow-xl">
        <div className="flex items-center justify-between border-b border-vault-border/70 px-5 py-4">
          <h3 className="text-lg font-semibold text-vault-text">
            {t("modals.history.title")}
          </h3>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-vault-muted hover:bg-vault-surface"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="px-5 py-4">
          {loading && <p className="text-sm text-vault-muted">{t("common.loading")}</p>}
          {error && (
            <p className="text-sm text-red-400">
              {t("common.error")}: {error}{" "}
              <button
                onClick={() => setPage(1)}
                className="ml-2 underline"
              >
                {t("common.retry")}
              </button>
            </p>
          )}
          {!loading && !error && items.length === 0 && (
            <p className="text-sm text-vault-muted">{t("modals.history.empty")}</p>
          )}

          {!loading && !error && items.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-vault-border/60 text-vault-muted">
                    <th className="pb-2 pr-4 font-medium">
                      {t("modals.history.columns.date")}
                    </th>
                    <th className="pb-2 pr-4 font-medium">
                      {t("modals.history.columns.type")}
                    </th>
                    <th className="pb-2 pr-4 font-medium">
                      {t("modals.history.columns.status")}
                    </th>
                    <th className="pb-2 pr-4 font-medium text-right">
                      {t("modals.history.columns.amount")}
                    </th>
                    <th className="pb-2 pr-4 font-medium">
                      {t("modals.history.columns.txHash")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((row) => {
                    const payload = row.action_payload || {};
                    const amount = Number(payload.amount ?? 0);
                    const created = formatDateTime(row.created_at, { locale });
                    return (
                      <tr
                        key={row.id}
                        className="border-b border-vault-border/40"
                      >
                        <td className="py-3 pr-4 text-vault-text">{created}</td>
                        <td className="py-3 pr-4 text-vault-text capitalize">
                          {row.action_type}
                        </td>
                        <td className="py-3 pr-4">
                          <span className="rounded-full bg-vault-surface px-2 py-0.5 text-xs capitalize text-vault-muted">
                            {statusLabels[row.status] || row.status}
                          </span>
                        </td>
                        <td className="py-3 pr-4 text-right text-vault-text">
                          {Number.isFinite(amount) ? amount.toLocaleString(locale) : ""}
                        </td>
                        <td className="py-3 pr-4 font-mono text-xs text-vault-muted">
                          {row.tx_hash ? (
                            <span title={row.tx_hash}>
                              {row.tx_hash.slice(0, 8)}…{row.tx_hash.slice(-6)}
                            </span>
                          ) : (
                            "—"
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-vault-border/70 px-5 py-4">
          <p className="text-xs text-vault-muted">
            {t("modals.history.empty", { count: totalCount })}
          </p>
          <div className="flex items-center gap-2">
            <button
              disabled={page <= 1 || loading}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="rounded-md border border-vault-border px-3 py-1 text-sm disabled:opacity-50"
            >
              ←
            </button>
            <span className="text-sm text-vault-muted">
              {page} / {totalPages}
            </span>
            <button
              disabled={page >= totalPages || loading}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              className="rounded-md border border-vault-border px-3 py-1 text-sm disabled:opacity-50"
            >
              →
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
