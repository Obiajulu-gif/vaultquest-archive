"use client";

import { useState } from "react";
import { Download, FileText, CheckCircle2 } from "lucide-react";

export default function PositionSnapshotExport({
  positions = [],
  walletAddress,
}) {
  const [isExporting, setIsExporting] = useState(false);
  const [exported, setExported] = useState(false);

  const formatCsv = (data) => {
    const headers = [
      "Snapshot Timestamp",
      "Wallet Address",
      "Pool",
      "Asset",
      "Principal",
      "Projected Reward",
      "Claimable Reward",
      "Maturity Date",
      "Status",
    ];

    const timestamp = new Date().toISOString();
    const rows = data.map((pos) => [
      timestamp,
      walletAddress,
      pos.pool,
      pos.asset,
      pos.principal.toFixed(2),
      pos.projectedReward.toFixed(2),
      pos.claimableReward.toFixed(2),
      pos.maturityDate || "N/A",
      pos.status,
    ]);

    const csvContent = [
      headers.join(","),
      ...rows.map((row) => row.map((cell) => `"${cell}"`).join(",")),
    ].join("\n");

    return csvContent;
  };

  const handleExport = () => {
    setIsExporting(true);

    setTimeout(() => {
      const csvData = formatCsv(positions);
      const blob = new Blob([csvData], { type: "text/csv;charset=utf-8;" });
      const link = document.createElement("a");
      const url = URL.createObjectURL(blob);

      link.setAttribute("href", url);
      link.setAttribute("download", `vaultquest-positions-${Date.now()}.csv`);
      link.style.visibility = "hidden";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      setIsExporting(false);
      setExported(true);
      setTimeout(() => setExported(false), 3000);
    }, 800);
  };

  const isEmpty = !positions || positions.length === 0;

  return (
    <section className="vq-glass-hover p-6 space-y-4">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-vault-accent/10 text-vault-accent border border-vault-accent/20">
          <FileText size={20} />
        </div>
        <div>
          <h3 className="font-semibold text-vault-text">Position Snapshot</h3>
          <p className="text-sm text-vault-muted">
            Export your current positions
          </p>
        </div>
      </div>

      {isEmpty ? (
        <div className="border border-vault-border rounded-lg p-6 text-center">
          <p className="text-sm text-vault-muted">No positions to export</p>
        </div>
      ) : (
        <>
          <div className="border-t border-vault-border pt-4">
            <p className="text-sm text-vault-muted mb-2">
              Export includes: pool, asset, principal, projected reward,
              claimable reward, maturity date, and status
            </p>
            <p className="text-xs text-vault-muted">
              Snapshot for: {walletAddress}
            </p>
          </div>

          <button
            onClick={handleExport}
            disabled={isExporting || isEmpty}
            className="vq-btn-primary w-full flex items-center justify-center gap-2 disabled:opacity-50"
          >
            {isExporting ? (
              <>
                <Download size={16} className="animate-bounce" />
                Exporting...
              </>
            ) : (
              <>
                <Download size={16} />
                Export CSV
              </>
            )}
          </button>

          {exported && (
            <div className="flex items-center gap-2 text-sm text-emerald-500 bg-emerald-500/10 border border-emerald-500/20 rounded-lg p-3">
              <CheckCircle2 size={16} />
              <span>Snapshot exported successfully</span>
            </div>
          )}
        </>
      )}
    </section>
  );
}
