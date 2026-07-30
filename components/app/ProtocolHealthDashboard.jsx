"use client";

import React, { useState, useMemo } from "react";
import { Activity, Server, Database, ShieldCheck, AlertCircle, RefreshCw, CheckCircle2, XCircle, Clock } from "lucide-react";

function sanitizeSecret(str) {
  if (typeof str !== "string") return str;
  return str.replace(/(api[-_]?key|secret|password|token)=([^&]+)/gi, "$1=***REDACTED***");
}

export default function ProtocolHealthDashboard({ healthData, onRefresh }) {
  const [isRefreshing, setIsRefreshing] = useState(false);

  const data = useMemo(() => {
    return {
      rpc: healthData?.rpc || { status: "healthy", endpoint: "https://horizon-testnet.stellar.org", latencyMs: 45, lastCheck: new Date().toISOString(), error: null },
      backend: healthData?.backend || { status: "healthy", uptime: "99.98%", environment: "production", lastCheck: new Date().toISOString(), error: null },
      indexer: healthData?.indexer || { status: "healthy", latestLedger: 1894052, syncLagLedgers: 0, lastCheck: new Date().toISOString(), error: null },
      contracts: healthData?.contracts || { status: "healthy", dripPool: "CBBD...3LLF", escrow: "GA47...9KLL", availability: "100%", lastCheck: new Date().toISOString(), error: null },
    };
  }, [healthData]);

  const handleRefresh = async () => {
    if (!onRefresh) return;
    setIsRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setIsRefreshing(false);
    }
  };

  const renderStatusBadge = (status) => {
    switch (status) {
      case "healthy":
        return (
          <span className="flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-0.5 text-xs font-bold text-emerald-400" data-testid="status-healthy">
            <CheckCircle2 className="h-3.5 w-3.5" /> Healthy
          </span>
        );
      case "degraded":
        return (
          <span className="flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-0.5 text-xs font-bold text-amber-400" data-testid="status-degraded">
            <AlertCircle className="h-3.5 w-3.5" /> Degraded
          </span>
        );
      case "unavailable":
      default:
        return (
          <span className="flex items-center gap-1 rounded-full border border-red-500/30 bg-red-500/10 px-2.5 py-0.5 text-xs font-bold text-red-400" data-testid="status-unavailable">
            <XCircle className="h-3.5 w-3.5" /> Unavailable
          </span>
        );
    }
  };

  return (
    <div className="vq-glass space-y-6 p-6" data-testid="protocol-health-dashboard">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between border-b border-vault-border/40 pb-4">
        <div>
          <div className="flex items-center gap-2">
            <Activity className="h-5 w-5 text-vault-accent" />
            <h2 className="text-lg font-bold text-vault-text">Protocol Service Health Dashboard</h2>
          </div>
          <p className="mt-1 text-xs text-vault-muted">Maintainer health signals for Stellar RPC, Backend API, Indexer, and Smart Contracts.</p>
        </div>

        <button
          type="button"
          onClick={handleRefresh}
          disabled={isRefreshing}
          className="vq-btn-ghost flex items-center gap-1.5 py-1.5 px-3 text-xs text-vault-muted hover:text-vault-text self-start sm:self-auto"
          data-testid="refresh-health-btn"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${isRefreshing ? "animate-spin" : ""}`} />
          <span>Refresh Signals</span>
        </button>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {/* Stellar RPC */}
        <div className="rounded-xl border border-vault-border bg-vault-surface/40 p-4 space-y-3" data-testid="card-rpc">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Server className="h-4 w-4 text-vault-accent" />
              <h3 className="text-sm font-bold text-vault-text">Stellar RPC Endpoint</h3>
            </div>
            {renderStatusBadge(data.rpc.status)}
          </div>
          <div className="text-xs text-vault-muted space-y-1">
            <div className="flex justify-between">
              <span>Endpoint:</span>
              <span className="font-mono text-vault-text">{sanitizeSecret(data.rpc.endpoint)}</span>
            </div>
            <div className="flex justify-between">
              <span>Latency:</span>
              <span className="font-semibold text-vault-text">{data.rpc.latencyMs} ms</span>
            </div>
          </div>
          {data.rpc.error && (
            <p className="rounded bg-red-500/10 p-2 text-[11px] font-mono text-red-400" data-testid="rpc-error">
              {sanitizeSecret(data.rpc.error)}
            </p>
          )}
        </div>

        {/* Backend API */}
        <div className="rounded-xl border border-vault-border bg-vault-surface/40 p-4 space-y-3" data-testid="card-backend">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-vault-accent" />
              <h3 className="text-sm font-bold text-vault-text">Backend Service API</h3>
            </div>
            {renderStatusBadge(data.backend.status)}
          </div>
          <div className="text-xs text-vault-muted space-y-1">
            <div className="flex justify-between">
              <span>Uptime:</span>
              <span className="font-semibold text-vault-text">{data.backend.uptime}</span>
            </div>
            <div className="flex justify-between">
              <span>Environment:</span>
              <span className="font-semibold text-vault-text">{data.backend.environment}</span>
            </div>
          </div>
          {data.backend.error && (
            <p className="rounded bg-red-500/10 p-2 text-[11px] font-mono text-red-400" data-testid="backend-error">
              {sanitizeSecret(data.backend.error)}
            </p>
          )}
        </div>

        {/* Indexer Daemon */}
        <div className="rounded-xl border border-vault-border bg-vault-surface/40 p-4 space-y-3" data-testid="card-indexer">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Database className="h-4 w-4 text-vault-accent" />
              <h3 className="text-sm font-bold text-vault-text">Stellar Event Indexer</h3>
            </div>
            {renderStatusBadge(data.indexer.status)}
          </div>
          <div className="text-xs text-vault-muted space-y-1">
            <div className="flex justify-between">
              <span>Latest Processed Ledger:</span>
              <span className="font-mono font-bold text-vault-text" data-testid="latest-ledger">{data.indexer.latestLedger}</span>
            </div>
            <div className="flex justify-between">
              <span>Indexer Lag:</span>
              <span className="font-semibold text-vault-text" data-testid="indexer-lag">{data.indexer.syncLagLedgers} ledgers</span>
            </div>
          </div>
          {data.indexer.error && (
            <p className="rounded bg-red-500/10 p-2 text-[11px] font-mono text-red-400" data-testid="indexer-error">
              {sanitizeSecret(data.indexer.error)}
            </p>
          )}
        </div>

        {/* Contract Availability */}
        <div className="rounded-xl border border-vault-border bg-vault-surface/40 p-4 space-y-3" data-testid="card-contracts">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-vault-accent" />
              <h3 className="text-sm font-bold text-vault-text">Contract Availability</h3>
            </div>
            {renderStatusBadge(data.contracts.status)}
          </div>
          <div className="text-xs text-vault-muted space-y-1">
            <div className="flex justify-between">
              <span>Drip Pool Contract:</span>
              <span className="font-mono text-vault-text">{sanitizeSecret(data.contracts.dripPool)}</span>
            </div>
            <div className="flex justify-between">
              <span>Availability:</span>
              <span className="font-semibold text-vault-text">{data.contracts.availability}</span>
            </div>
          </div>
          {data.contracts.error && (
            <p className="rounded bg-red-500/10 p-2 text-[11px] font-mono text-red-400" data-testid="contracts-error">
              {sanitizeSecret(data.contracts.error)}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
