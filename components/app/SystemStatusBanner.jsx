"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle,
  XCircle,
  ChevronDown,
  ChevronUp,
  RefreshCw,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

const ENDPOINTS = [
  {
    id: "stellar-horizon",
    name: "Stellar Horizon API",
    url: "https://horizon.stellar.org",
  },
  {
    id: "stellar-rpc",
    name: "Stellar RPC",
    url: "https://soroban-testnet.stellar.org",
  },
  {
    id: "avalanche-rpc",
    name: "Avalanche RPC",
    url: "https://api.avax.network",
  },
  { id: "backend-api", name: "VaultQuest Backend", url: "/api/health" },
];

const STATUS_SEVERITY = {
  operational: { color: "emerald", icon: CheckCircle, label: "Operational" },
  degraded: { color: "amber", icon: AlertTriangle, label: "Degraded" },
  outage: { color: "red", icon: XCircle, label: "Outage" },
};

export default function SystemStatusBanner() {
  const [services, setServices] = useState([]);
  const [expanded, setExpanded] = useState(false);
  const [lastCheck, setLastCheck] = useState(null);
  const [checking, setChecking] = useState(false);

  const checkServiceHealth = async (endpoint) => {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(endpoint.url, {
        method: "HEAD",
        signal: controller.signal,
        mode: "no-cors",
      });

      clearTimeout(timeoutId);
      return { ...endpoint, status: "operational", latency: Date.now() };
    } catch (error) {
      if (error.name === "AbortError") {
        return { ...endpoint, status: "degraded", error: "Timeout" };
      }
      return { ...endpoint, status: "outage", error: error.message };
    }
  };

  const checkAllServices = useCallback(async () => {
    setChecking(true);
    const results = await Promise.all(ENDPOINTS.map(checkServiceHealth));
    setServices(results);
    setLastCheck(new Date());
    setChecking(false);
  }, []);

  useEffect(() => {
    checkAllServices();
    const interval = setInterval(checkAllServices, 60000); // Check every minute
    return () => clearInterval(interval);
  }, [checkAllServices]);

  const hasIssues = services.some((s) => s.status !== "operational");
  const criticalIssues = services.filter((s) => s.status === "outage").length;
  const degradedIssues = services.filter((s) => s.status === "degraded").length;

  if (!hasIssues) return null;

  const severity = criticalIssues > 0 ? "outage" : "degraded";
  const severityConfig = STATUS_SEVERITY[severity];

  return (
    <div
      role="alert"
      aria-live="assertive"
      className={`vq-glass mb-6 border-${severityConfig.color}-500/40 bg-${severityConfig.color}-500/10`}
    >
      <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <span
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-${severityConfig.color}-500/20 text-${severityConfig.color}-400 ring-2 ring-${severityConfig.color}-400/30`}
          >
            <severityConfig.icon className="h-5 w-5" aria-hidden="true" />
          </span>
          <div className="flex-1">
            <h2 className="text-sm font-semibold text-vault-text">
              {criticalIssues > 0
                ? `${criticalIssues} Service${criticalIssues > 1 ? "s" : ""} Down`
                : `${degradedIssues} Service${degradedIssues > 1 ? "s" : ""} Degraded`}
            </h2>
            <p className="mt-0.5 text-sm text-vault-muted">
              {criticalIssues > 0
                ? "Some blockchain nodes or APIs are experiencing outages. Transactions may fail."
                : "Network performance is degraded. You may experience slower response times."}
            </p>
            {lastCheck && (
              <p className="mt-1 text-xs text-vault-muted">
                Last checked: {lastCheck.toLocaleTimeString()}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={checkAllServices}
            disabled={checking}
            className="vq-btn-ghost h-9 px-3 disabled:opacity-60"
            aria-label="Refresh status"
          >
            <RefreshCw
              className={`h-4 w-4 ${checking ? "animate-spin" : ""}`}
              aria-hidden="true"
            />
          </button>
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="vq-btn-ghost h-9 px-3"
            aria-expanded={expanded}
            aria-label={expanded ? "Collapse details" : "Expand details"}
          >
            {expanded ? (
              <ChevronUp className="h-4 w-4" aria-hidden="true" />
            ) : (
              <ChevronDown className="h-4 w-4" aria-hidden="true" />
            )}
            <span className="ml-1 text-xs">Details</span>
          </button>
        </div>
      </div>

      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
            className="overflow-hidden border-t border-vault-border"
          >
            <div className="space-y-2 p-4">
              {services.map((service) => {
                const statusConfig = STATUS_SEVERITY[service.status];
                return (
                  <div
                    key={service.id}
                    className="flex items-center justify-between rounded-lg border border-vault-border bg-vault-surface/40 p-3"
                  >
                    <div className="flex items-center gap-3">
                      <statusConfig.icon
                        className={`h-4 w-4 text-${statusConfig.color}-500`}
                        aria-hidden="true"
                      />
                      <div>
                        <p className="text-sm font-medium text-vault-text">
                          {service.name}
                        </p>
                        <p className="text-xs text-vault-muted">
                          {service.url}
                        </p>
                      </div>
                    </div>
                    <div className="text-right">
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-1 text-xs font-medium bg-${statusConfig.color}-500/15 text-${statusConfig.color}-600 dark:text-${statusConfig.color}-400`}
                      >
                        {statusConfig.label}
                      </span>
                      {service.error && (
                        <p className="mt-1 text-xs text-vault-muted">
                          {service.error}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
