"use client";

import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Activity,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Clock,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  Server,
  Database,
  Shield,
} from "lucide-react";

const VAULT_SERVICES = [
  {
    id: "vault-contracts",
    name: "Vault Smart Contracts",
    icon: Shield,
    check: async () => {
      const ok = Math.random() > 0.15;
      if (ok) return { status: "operational" };
      return { status: "degraded", message: "Contract response latency elevated" };
    },
  },
  {
    id: "prize-oracle",
    name: "Prize Oracle",
    icon: Database,
    check: async () => {
      const ok = Math.random() > 0.1;
      if (ok) return { status: "operational" };
      return { status: "operational", message: "Oracle sync delayed by 2s" };
    },
  },
  {
    id: "data-indexer",
    name: "Data Indexer",
    icon: Server,
    check: async () => {
      const ok = Math.random() > 0.2;
      if (ok) return { status: "operational" };
      return { status: "degraded", message: "Indexer 3 blocks behind" };
    },
  },
];

const STATUS_CONFIG = {
  operational: {
    icon: CheckCircle,
    color: "emerald",
    label: "Healthy",
  },
  degraded: {
    icon: AlertTriangle,
    color: "amber",
    label: "Degraded",
  },
  outage: {
    icon: XCircle,
    color: "red",
    label: "Outage",
  },
};

function ServiceRow({ service, status }) {
  const config = STATUS_CONFIG[status] || STATUS_CONFIG.operational;
  const Icon = service.icon;
  const StatusIcon = config.icon;

  return (
    <div className="flex items-center justify-between rounded-lg border border-vault-border/50 bg-vault-surface/30 p-3">
      <div className="flex items-center gap-3">
        <Icon className="h-4 w-4 text-vault-muted" aria-hidden="true" />
        <span className="text-sm font-medium text-vault-text">{service.name}</span>
      </div>
      <span
        className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium bg-${config.color}-500/15 text-${config.color}-600 dark:text-${config.color}-400`}
      >
        <StatusIcon className="h-3.5 w-3.5" aria-hidden="true" />
        {config.label}
      </span>
    </div>
  );
}

export default function VaultHealthStatusPanel() {
  const [services, setServices] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);

  const checkHealth = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const results = await Promise.all(
        VAULT_SERVICES.map(async (svc) => {
          const result = await svc.check();
          return { id: svc.id, ...result };
        })
      );
      setServices(results);
      setLastUpdated(new Date());
    } catch (err) {
      setError("Unable to check vault service health.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    checkHealth();
    const interval = setInterval(checkHealth, 30000);
    return () => clearInterval(interval);
  }, [checkHealth]);

  const overallStatus = (() => {
    if (!services) return "loading";
    if (services.some((s) => s.status === "outage")) return "outage";
    if (services.some((s) => s.status === "degraded")) return "degraded";
    return "operational";
  })();

  const statusConfig = STATUS_CONFIG[overallStatus] || STATUS_CONFIG.operational;
  const StatusIcon = statusConfig.icon;
  const statusColor = statusConfig.color;

  const formatTime = (date) => {
    const now = new Date();
    const diff = Math.floor((now - date) / 1000);
    if (diff < 60) return "Just now";
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    return date.toLocaleTimeString();
  };

  return (
    <section aria-label="Vault health status" className="vq-glass-hover overflow-hidden">
      <div className="p-5 sm:p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <span
              className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-${statusColor}-500/20 text-${statusColor}-400 ring-2 ring-${statusColor}-400/30`}
            >
              {loading ? (
                <RefreshCw className="h-5 w-5 animate-spin" aria-hidden="true" />
              ) : (
                <StatusIcon className="h-5 w-5" aria-hidden="true" />
              )}
            </span>
            <div>
              <h3 className="text-sm font-semibold text-vault-text">
                Vault Network Status
              </h3>
              <p className="text-xs text-vault-muted">
                {loading
                  ? "Checking service health..."
                  : overallStatus === "operational"
                    ? "All vault services operational"
                    : overallStatus === "degraded"
                      ? "Some services are experiencing issues"
                      : "Service outage detected"}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={checkHealth}
              disabled={loading}
              className="vq-btn-ghost h-8 px-2.5 disabled:opacity-60"
              aria-label="Refresh status"
            >
              <RefreshCw
                className={`h-4 w-4 ${loading ? "animate-spin" : ""}`}
                aria-hidden="true"
              />
            </button>
            <button
              type="button"
              onClick={() => setExpanded(!expanded)}
              className="vq-btn-ghost h-8 px-2.5"
              aria-expanded={expanded}
              aria-label={expanded ? "Collapse details" : "Expand details"}
            >
              {expanded ? (
                <ChevronUp className="h-4 w-4" aria-hidden="true" />
              ) : (
                <ChevronDown className="h-4 w-4" aria-hidden="true" />
              )}
            </button>
          </div>
        </div>

        {lastUpdated && (
          <div className="mt-3 flex items-center gap-1.5 text-xs text-vault-muted">
            <Clock className="h-3.5 w-3.5" aria-hidden="true" />
            Last updated: {formatTime(lastUpdated)}
          </div>
        )}

        {error && (
          <div
            role="alert"
            className="mt-3 flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-500"
          >
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true" />
            <span>{error}</span>
          </div>
        )}
      </div>

      <AnimatePresence>
        {expanded && services && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
            className="overflow-hidden border-t border-vault-border/30"
          >
            <div className="space-y-2 p-5 sm:p-6 pt-0">
              {services.length === 0 && (
                <p className="text-sm text-vault-muted text-center py-4">
                  No services to display.
                </p>
              )}
              {services.map((svc) => {
                const serviceDef = VAULT_SERVICES.find((s) => s.id === svc.id);
                return (
                  <ServiceRow
                    key={svc.id}
                    service={serviceDef}
                    status={svc.status}
                  />
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}
