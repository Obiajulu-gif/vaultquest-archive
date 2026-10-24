"use client";

import React, { useState, useEffect, useMemo } from "react";
import Link from "next/link";
import { useTranslation } from "next-i18next";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock3,
  FlaskConical,
  Gauge,
  GitCompareArrows,
  Server,
  Shield,
  ShieldAlert,
  Settings,
  SquareStack,
  Plus,
  AlertCircle,
  Download,
} from "lucide-react";
import { motion } from "framer-motion";
import { getFrontendEnv, getManifestAttestation, attestManifest } from "@vaultquest/stellar-wallet-connect";
import {
  PROTOCOL_PARAMETER_CATALOG,
  createParameterDiffPreview,
  formatSimulatedValue,
  serializeDiffPreview,
} from "@/lib/admin-parameter-simulation";

const PROTOCOL_PARAMETERS = [
  {
    label: "Round duration",
    value: "7 days",
    note: "New rounds auto-open on a weekly cadence.",
  },
  {
    label: "Minimum deposit",
    value: "100 XLM",
    note: "Keeps operational churn low for small deposits.",
  },
  {
    label: "Maximum deposit per wallet",
    value: "250,000 XLM",
    note: "Enforced on-chain by drip-pool's max_wallet_deposit (#643) — a deposit that would push a wallet's cumulative principal past this value is rejected by the contract itself, not only validated here.",
  },
  {
    label: "Maximum deposit per vault (protocol-wide)",
    value: "10,000,000 XLM",
    note: "Enforced on-chain by drip-pool's max_pool_deposit (#643), independently of the per-wallet limit above — a vault can reject a deposit for being over the protocol-wide cap even when the depositing wallet is well under its own limit.",
  },
  {
    label: "Treasury fee",
    value: "0.75%",
    note: "Applied to routed yield before prize allocation.",
  },
  {
    label: "Settlement quorum",
    value: "3 of 5",
    note: "Requires multisig approval for admin writes.",
  },
  {
    label: "Emergency pause threshold",
    value: "2 failed attempts",
    note: "Triggers manual review before retrying settlement.",
  },
  {
    label: "Sybil anti-abuse clustering check",
    value: "Configurable / Auditable",
    note: "Monitors deposit splitting without blocking legitimate users by default.",
  },
];

const ACTIVE_ROUNDS = [
  {
    name: "XLM Community Drip",
    status: "drawing",
    pool: "18.4M XLM",
    participants: "8,412 savers",
    deadline: "Draw closes in 31 minutes",
    progress: 92,
    nextAction: "Finalize winner selection and publish receipt.",
  },
  {
    name: "USDC Growth Vault",
    status: "open",
    pool: "4.2M USDC",
    participants: "2,108 savers",
    deadline: "Opens for lock-in tomorrow at 09:00 UTC",
    progress: 58,
    nextAction: "Monitor deposit velocity before the next lock window.",
  },
  {
    name: "BTC Reserve Round",
    status: "locking",
    pool: "980 BTC",
    participants: "1,240 savers",
    deadline: "Locks in 2 days and 4 hours",
    progress: 84,
    nextAction: "Confirm settlement checks before freeze.",
  },
];

const SERVICE_STATUS = [
  {
    name: "Smart contract",
    status: "operational",
    detail: "Latest contract hash matches the published release.",
  },
  {
    name: "Backend API",
    status: "operational",
    detail: "All critical routes responding under target latency.",
  },
  {
    name: "Indexer",
    status: "degraded",
    detail: "Lagging by 2 ledgers. Background catch-up is running.",
  },
  {
    name: "Notification relay",
    status: "watch",
    detail: "Healthy but queue depth is above the normal threshold.",
  },
];

const OPERATIONAL_NOTES = [
  {
    title: "Settlement window",
    body: "Avoid manual writes between 14:00 and 15:00 UTC while the payout job is active.",
  },
  {
    title: "Escalation rule",
    body: "Page the protocol owner if the indexer stays more than 5 ledgers behind for 10 minutes.",
  },
  {
    title: "Change hygiene",
    body: "Attach screenshots or transaction receipts for every admin parameter update.",
  },
  {
    title: "Release check",
    body: "Clear any draft governance actions after execution so the dashboard stays current.",
  },
];

const STATUS_STYLE = {
  operational: {
    label: "Operational",
    className: "bg-emerald-500/15 text-emerald-300 ring-emerald-400/30",
    dot: "bg-emerald-400",
    icon: CheckCircle2,
  },
  degraded: {
    label: "Degraded",
    className: "bg-amber-500/15 text-amber-300 ring-amber-400/30",
    dot: "bg-amber-400",
    icon: AlertTriangle,
  },
  watch: {
    label: "Watch",
    className: "bg-sky-500/15 text-sky-300 ring-sky-400/30",
    dot: "bg-sky-400",
    icon: Clock3,
  },
  drawing: {
    label: "Drawing",
    className: "bg-fuchsia-500/15 text-fuchsia-300 ring-fuchsia-400/30",
    dot: "bg-fuchsia-400",
    icon: Gauge,
  },
  open: {
    label: "Open",
    className: "bg-emerald-500/15 text-emerald-300 ring-emerald-400/30",
    dot: "bg-emerald-400",
    icon: CheckCircle2,
  },
  locking: {
    label: "Locking",
    className: "bg-amber-500/15 text-amber-300 ring-amber-400/30",
    dot: "bg-amber-400",
    icon: Clock3,
  },
  loading: {
    label: "Checking...",
    className: "bg-gray-500/15 text-gray-300 ring-gray-400/30",
    dot: "bg-gray-400",
    icon: Clock3,
  },
  unavailable: {
    label: "Unavailable",
    className: "bg-red-500/15 text-red-300 ring-red-400/30",
    dot: "bg-red-500",
    icon: AlertTriangle,
  },
};

function StatusBadge({ status }) {
  const style = STATUS_STYLE[status] ?? STATUS_STYLE.watch;
  const Icon = style.icon;

  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ${style.className}`}>
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {style.label}
    </span>
  );
}

function MetricCard({ label, value, detail, icon: Icon }) {
  return (
    <div className="vq-glass p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.24em] text-vault-muted">
            {label}
          </p>
          <p className="mt-2 text-2xl font-bold text-vault-text">{value}</p>
          <p className="mt-1 text-sm text-vault-muted">{detail}</p>
        </div>
        <span className="flex h-11 w-11 items-center justify-center rounded-2xl border border-red-500/20 bg-red-500/10 text-red-400">
          <Icon className="h-5 w-5" aria-hidden="true" />
        </span>
      </div>
    </div>
  );
}

export default function AdminSettingsPage() {
  const { t } = useTranslation("common");

  const [health, setHealth] = useState({
    smartContract: { status: "loading", detail: "Checking contract deployment..." },
    backendApi: { status: "loading", detail: "Checking backend health..." },
    indexer: { status: "loading", detail: "Checking indexer sync..." },
    rpcLayer: { status: "loading", detail: "Checking Horizon RPC..." },
  });
  const [attestation, setAttestation] = useState(null);

  // #649 — parameter simulation & diff preview.
  const [selectedParamId, setSelectedParamId] = useState(PROTOCOL_PARAMETER_CATALOG[0].id);
  const [proposedValueInput, setProposedValueInput] = useState(String(PROTOCOL_PARAMETER_CATALOG[0].current));
  const [rationaleInput, setRationaleInput] = useState("");
  const [proposals, setProposals] = useState([]);
  const [overrideBlocked, setOverrideBlocked] = useState(false);
  const [createdAt, setCreatedAt] = useState(null);

  const diffPreview = useMemo(
    () => createParameterDiffPreview(proposals, { createdAt, author: "maintainer", overrideBlocked }),
    [proposals, createdAt, overrideBlocked],
  );

  const selectedSpec = PROTOCOL_PARAMETER_CATALOG.find((spec) => spec.id === selectedParamId);

  const addProposal = () => {
    const value = Number(proposedValueInput);
    setProposals((current) => [
      ...current.filter((proposal) => proposal.paramId !== selectedParamId),
      { paramId: selectedParamId, proposedValue: value, rationale: rationaleInput.trim() || undefined },
    ]);
    setCreatedAt(new Date().toISOString());
  };

  const downloadPreview = () => {
    if (proposals.length === 0) return;
    const blob = new Blob([serializeDiffPreview(diffPreview)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `param-simulation-${diffPreview.id}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const riskStyle = {
    none: "border-vault-border bg-vault-surface text-vault-muted",
    low: "border-sky-400/30 bg-sky-500/10 text-sky-300",
    medium: "border-amber-400/30 bg-amber-500/10 text-amber-300",
    high: "border-red-400/40 bg-red-500/15 text-red-300",
  };

  useEffect(() => {
    let active = true;

    async function verifyHealth() {
      let envData;
      let env = {
        NEXT_PUBLIC_HORIZON_URL: "https://horizon-testnet.stellar.org",
        NEXT_PUBLIC_DRIP_POOL_CONTRACT_ID: "",
      };
      try {
        envData = getFrontendEnv();
        env = { ...env, ...envData };
      } catch (e) {
        console.warn("Failed to load frontend env", e);
      }

      const API_BASE = process.env.NEXT_PUBLIC_VAULTQUEST_API_BASE_URL || "/api";
      const horizonUrl = env.NEXT_PUBLIC_HORIZON_URL;
      const contractId = env.NEXT_PUBLIC_DRIP_POOL_CONTRACT_ID;

      // Check attestation
      try {
        const att = attestManifest(envData);
        if (active) setAttestation(att);
      } catch (e) {
        console.error("Attestation check failed", e);
      }

      // Check Backend API
      let backendApi = { status: "unavailable", detail: "Backend API is unreachable." };
      try {
        const start = performance.now();
        const res = await fetch(`${API_BASE}/health`, { signal: AbortSignal.timeout(5000) });
        const latency = performance.now() - start;
        if (res.ok) {
          const body = await res.json();
          const uptime = body.data?.uptime ?? 0;
          if (latency > 1000) {
            backendApi = {
              status: "degraded",
              detail: `Healthy but latency is high (${Math.round(latency)}ms). Uptime: ${uptime}s.`,
            };
          } else {
            backendApi = {
              status: "operational",
              detail: `Responding healthy. Latency: ${Math.round(latency)}ms. Uptime: ${uptime}s.`,
            };
          }
        } else {
          backendApi = {
            status: "unavailable",
            detail: `Returned HTTP ${res.status}.`,
          };
        }
      } catch {
        backendApi = { status: "unavailable", detail: "Endpoint timed out or is offline." };
      }

      // Check Indexer
      let indexer = { status: "unavailable", detail: "Indexer endpoint is offline." };
      try {
        const res = await fetch(`${API_BASE}/health/indexer`, { signal: AbortSignal.timeout(5000) });
        if (res.ok) {
          const body = await res.json();
          const data = body.data;
          let status = "operational";
          let detail = `Healthy. Latest ledger: ${data.latest_ledger}. Lag: ${data.sync_lag} ledgers.`;
          if (data.status === "degraded" || data.last_error) {
            status = "degraded";
            detail = `Degraded: ${data.last_error || "Lagging"}. Lag: ${data.sync_lag} ledgers.`;
          } else if (data.sync_lag > 20) {
            status = "unavailable";
            detail = `Critical lag: ${data.sync_lag} ledgers.`;
          } else if (data.sync_lag >= 5) {
            status = "degraded";
            detail = `Lagging behind. Lag: ${data.sync_lag} ledgers.`;
          }
          indexer = { status, detail };
        } else {
          indexer = { status: "unavailable", detail: `Returned HTTP ${res.status}.` };
        }
      } catch {
        // use default
      }

      // Check Horizon RPC
      let rpcLayer = { status: "unavailable", detail: "Horizon node is unresponsive." };
      try {
        const start = performance.now();
        const res = await fetch(`${horizonUrl}/`, { signal: AbortSignal.timeout(5000) });
        const latency = performance.now() - start;
        if (res.ok) {
          if (latency < 500) {
            rpcLayer = { status: "operational", detail: `Responsive. Latency: ${Math.round(latency)}ms.` };
          } else if (latency <= 2000) {
            rpcLayer = { status: "degraded", detail: `Slow response. Latency: ${Math.round(latency)}ms.` };
          } else {
            rpcLayer = { status: "unavailable", detail: `High latency: ${Math.round(latency)}ms.` };
          }
        } else {
          rpcLayer = { status: "degraded", detail: `Returned HTTP ${res.status}.` };
        }
      } catch {
        // use default
      }

      // Check Smart Contract
      let smartContract = { status: "unavailable", detail: "Contract ID not configured." };
      if (contractId) {
        try {
          const res = await fetch(`${horizonUrl}/accounts/${contractId}`, { signal: AbortSignal.timeout(5000) });
          if (res.status === 200) {
            smartContract = {
              status: "operational",
              detail: `Contract verified on-chain. Address: ${contractId}.`,
            };
          } else if (res.status === 404) {
            smartContract = {
              status: "unavailable",
              detail: `Contract address ${contractId} is not deployed on this network.`,
            };
          } else {
            smartContract = {
              status: "degraded",
              detail: `Verification query returned status ${res.status}.`,
            };
          }
        } catch {
          smartContract = { status: "unavailable", detail: "Verification query timed out or failed." };
        }
      }

      if (active) {
        setHealth({ smartContract, backendApi, indexer, rpcLayer });
      }
    }

    verifyHealth();
    return () => { active = false; };
  }, []);

  const serviceItems = [
    {
      name: "Smart contract",
      status: health.smartContract.status,
      detail: health.smartContract.detail,
    },
    {
      name: "Backend API",
      status: health.backendApi.status,
      detail: health.backendApi.detail,
    },
    {
      name: "Indexer",
      status: health.indexer.status,
      detail: health.indexer.detail,
    },
    {
      name: "Stellar Horizon RPC",
      status: health.rpcLayer.status,
      detail: health.rpcLayer.detail,
    },
  ];

  const totals = {
    parameters: PROTOCOL_PARAMETERS.length,
    rounds: ACTIVE_ROUNDS.length,
    services: serviceItems.length,
    notes: OPERATIONAL_NOTES.length,
  };

  return (
    <div className="space-y-6">
      <motion.header
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35 }}
        className="flex flex-col gap-4 rounded-3xl border border-vault-border bg-gradient-to-br from-[#2B0B0B] via-vault-surface to-vault-bg p-6 shadow-glass sm:flex-row sm:items-end sm:justify-between"
      >
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-[0.32em] text-red-300">
            {t("routes.admin.settings.kicker")}
          </p>
          <h1 className="text-3xl font-bold text-vault-text">{t("routes.admin.settings.title")}</h1>
          <p className="max-w-2xl text-sm text-vault-muted">
            {t("routes.admin.settings.subtitle")}
          </p>
          <div className="flex flex-wrap gap-2 pt-1 text-xs text-vault-muted">
            <span className="rounded-full border border-vault-border bg-vault-surface px-3 py-1.5">
              Read-only overview
            </span>
            <span className="rounded-full border border-vault-border bg-vault-surface px-3 py-1.5">
              Changes flow through governance proposals
            </span>
          </div>
        </div>
        <div className="flex flex-wrap gap-3">
          <Link href="/app/admin/proposals" className="vq-btn-ghost inline-flex items-center gap-2">
            <Shield className="h-4 w-4" aria-hidden="true" />
            {t("routes.admin.settings.viewProposals")}
          </Link>
          <Link href="/app/admin/pools/create" className="vq-btn-primary inline-flex items-center gap-2">
            <Plus className="h-4 w-4" aria-hidden="true" />
            Create pool
          </Link>
          <Link href="/app/prizes" className="vq-btn-ghost inline-flex items-center gap-2">
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
            {t("routes.admin.settings.reviewRounds")}
          </Link>
        </div>
      </motion.header>

      {/* Attestation Mismatch Warnings */}
      {attestation && !attestation.verified && (
        <div className="rounded-3xl border border-red-500/30 bg-red-950/40 p-5 text-red-200">
          <div className="flex items-start gap-3">
            <AlertTriangle className="h-6 w-6 text-red-400 shrink-0 mt-0.5" aria-hidden="true" />
            <div>
              <h3 className="text-base font-bold text-white">Deployment Mismatch Detected</h3>
              <p className="text-sm text-red-300 mt-1">
                The active network configuration does not match the compiled deployment manifest:
              </p>
              <ul className="mt-3 list-disc list-inside text-sm space-y-1.5 text-red-300">
                {attestation.mismatches.map((m) => (
                  <li key={m.field}>
                    <strong>{m.field}</strong>: Expected &quot;{m.manifestValue}&quot;, Active &quot;{m.envValue}&quot;
                  </li>
                ))}
              </ul>
              <div className="mt-4 text-sm">
                <a
                  href="/docs/DEPLOYMENT_PROVENANCE.md"
                  className="underline font-semibold text-white hover:text-red-200"
                >
                  Read Deployment Provenance Documentation
                </a>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Protocol parameters"
          value={String(totals.parameters)}
          detail="Core settings currently enforced on chain and in the backend."
          icon={Settings}
        />
        <MetricCard
          label="Active rounds"
          value={String(totals.rounds)}
          detail="Open, locking, and drawing rounds currently under management."
          icon={SquareStack}
        />
        <MetricCard
          label="Service status"
          value={`${serviceItems.filter((s) => s.status === "operational").length}/${totals.services}`}
          detail="Services currently in an operational state."
          icon={Server}
        />
        <MetricCard
          label="Operational notes"
          value={String(totals.notes)}
          detail="Current reminders, escalation rules, and release hygiene."
          icon={Shield}
        />
      </div>

      <section className="vq-glass p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-vault-text">Protocol parameters</h2>
            <p className="mt-1 text-sm text-vault-muted">
              The most important configuration knobs that define how the protocol behaves.
            </p>
          </div>
          <span className="inline-flex items-center gap-2 rounded-full border border-vault-border bg-vault-surface px-3 py-1.5 text-xs font-medium text-vault-muted">
            <Gauge className="h-3.5 w-3.5" aria-hidden="true" />
            Governance-controlled
          </span>
        </div>

        <div className="mt-5 overflow-hidden rounded-2xl border border-vault-border">
          <table className="min-w-full divide-y divide-vault-border text-left text-sm">
            <thead className="bg-vault-surface/60 text-xs uppercase tracking-wide text-vault-muted">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">Parameter</th>
                <th scope="col" className="px-4 py-3 font-medium">Current value</th>
                <th scope="col" className="px-4 py-3 font-medium">Notes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-vault-border bg-vault-bg/40">
              {PROTOCOL_PARAMETERS.map((item) => (
                <tr key={item.label} className="align-top">
                  <th scope="row" className="px-4 py-4 font-medium text-vault-text">
                    {item.label}
                  </th>
                  <td className="px-4 py-4 text-vault-text">{item.value}</td>
                  <td className="px-4 py-4 text-vault-muted">{item.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="vq-glass p-5 sm:p-6" aria-labelledby="simulation-title">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 id="simulation-title" className="flex items-center gap-2 text-lg font-semibold text-vault-text">
              <FlaskConical className="h-5 w-5 text-red-400" aria-hidden="true" />
              Parameter simulation &amp; diff preview
            </h2>
            <p className="mt-1 text-sm text-vault-muted">
              Draft a parameter change and preview the before→after diff, risk level, and affected services before it is routed to a governance proposal.
            </p>
          </div>
          <span className="inline-flex items-center gap-2 rounded-full border border-vault-border bg-vault-surface px-3 py-1.5 text-xs font-medium text-vault-muted">
            <GitCompareArrows className="h-3.5 w-3.5" aria-hidden="true" />
            No on-chain writes
          </span>
        </div>

        <form
          className="mt-5 grid gap-3 lg:grid-cols-[minmax(0,1fr)_repeat(3,minmax(0,1fr))_auto] lg:items-end"
          onSubmit={(e) => { e.preventDefault(); addProposal(); }}
        >
          <div className="flex flex-col gap-1">
            <label htmlFor="sim-param" className="text-xs font-medium text-vault-muted">Parameter</label>
            <select
              id="sim-param"
              value={selectedParamId}
              onChange={(e) => {
                const spec = PROTOCOL_PARAMETER_CATALOG.find((item) => item.id === e.target.value);
                setSelectedParamId(e.target.value);
                setProposedValueInput(String(spec ? spec.current : ""));
              }}
              className="rounded-lg border border-vault-border bg-vault-surface px-3 py-2 text-sm text-vault-text focus:outline-none focus:ring-2 focus:ring-red-500"
            >
              {PROTOCOL_PARAMETER_CATALOG.map((spec) => (
                <option key={spec.id} value={spec.id}>{spec.label}</option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="sim-value" className="text-xs font-medium text-vault-muted">
              Proposed value {selectedSpec ? `(${selectedSpec.unit}, current ${selectedSpec.current})` : ""}
            </label>
            <input
              id="sim-value"
              type="number"
              inputMode="decimal"
              step="any"
              value={proposedValueInput}
              onChange={(e) => setProposedValueInput(e.target.value)}
              className="rounded-lg border border-vault-border bg-vault-surface px-3 py-2 text-sm text-vault-text focus:outline-none focus:ring-2 focus:ring-red-500"
            />
          </div>
          <div className="flex flex-col gap-1 lg:col-span-2">
            <label htmlFor="sim-rationale" className="text-xs font-medium text-vault-muted">Rationale (optional)</label>
            <input
              id="sim-rationale"
              type="text"
              value={rationaleInput}
              onChange={(e) => setRationaleInput(e.target.value)}
              placeholder="Why this change is needed…"
              className="rounded-lg border border-vault-border bg-vault-surface px-3 py-2 text-sm text-vault-text focus:outline-none focus:ring-2 focus:ring-red-500"
            />
          </div>
          {selectedSpec && (
            <p className="text-xs text-vault-muted lg:col-span-4">{selectedSpec.description} {selectedSpec.boundaryNote}</p>
          )}
          <button type="submit" className="vq-btn-primary lg:col-span-4">
            <GitCompareArrows className="h-4 w-4" aria-hidden="true" />
            Add to simulation
          </button>
        </form>

        {proposals.length === 0 ? (
          <div className="mt-5 rounded-2xl border border-dashed border-vault-border bg-vault-bg/40 px-4 py-10 text-center">
            <FlaskConical className="mx-auto h-8 w-8 text-vault-muted" aria-hidden="true" />
            <p className="mt-3 text-sm text-vault-muted">
              Propose a change above to generate a live diff preview with risk scoring and a downloadable JSON payload.
            </p>
          </div>
        ) : (
          <>
            <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Simulation summary">
              <div className="rounded-xl border border-vault-border bg-vault-surface/40 p-4">
                <p className="text-xs font-bold uppercase tracking-wide text-vault-muted">Proposals</p>
                <p className="mt-1 text-xl font-black text-vault-text">{diffPreview.summary.total}</p>
              </div>
              <div className="rounded-xl border border-vault-border bg-vault-surface/40 p-4">
                <p className="text-xs font-bold uppercase tracking-wide text-vault-muted">Valid</p>
                <p className="mt-1 text-xl font-black text-emerald-400">{diffPreview.summary.valid}</p>
              </div>
              <div className="rounded-xl border border-vault-border bg-vault-surface/40 p-4">
                <p className="text-xs font-bold uppercase tracking-wide text-vault-muted">Blocked</p>
                <p className="mt-1 text-xl font-black text-red-400">{diffPreview.summary.blocked}</p>
              </div>
              <div className="rounded-xl border border-vault-border bg-vault-surface/40 p-4">
                <p className="text-xs font-bold uppercase tracking-wide text-vault-muted">High risk</p>
                <p className="mt-1 text-xl font-black text-amber-400">{diffPreview.summary.highRisk}</p>
              </div>
            </div>

            {diffPreview.conflicts.length > 0 && (
              <div role="alert" className="mt-4 space-y-1 rounded-xl border border-amber-400/30 bg-amber-500/10 p-3 text-sm text-amber-200">
                {diffPreview.conflicts.map((conflict) => (
                  <p key={conflict} className="flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
                    {conflict}
                  </p>
                ))}
              </div>
            )}

            <ul className="mt-5 space-y-3" role="list">
              {diffPreview.results.map((result) => (
                <li key={result.paramId} className="rounded-2xl border border-vault-border bg-vault-surface/40 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="font-semibold text-vault-text">{result.label}</h3>
                        <span className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold capitalize ${riskStyle[result.riskLevel] ?? riskStyle.none}`}>
                          {result.riskLevel} risk
                        </span>
                        {result.blocked && (
                          <span className="rounded-full border border-red-400/40 bg-red-500/15 px-2.5 py-0.5 text-xs font-semibold text-red-300">
                            Blocked change
                          </span>
                        )}
                        {result.overridden && (
                          <span className="rounded-full border border-amber-400/30 bg-amber-500/10 px-2.5 py-0.5 text-xs font-semibold text-amber-300">
                            Overridden
                          </span>
                        )}
                        {result.needsConfirmation && !result.blocked && (
                          <span className="rounded-full border border-amber-400/30 bg-amber-500/10 px-2.5 py-0.5 text-xs font-semibold text-amber-300">
                            Review required
                          </span>
                        )}
                      </div>
                      <p className="mt-1 text-sm text-vault-muted">{result.projection}</p>
                    </div>
                    <div className="flex items-center gap-2 text-sm">
                      <span className="rounded-lg border border-vault-border bg-vault-bg/40 px-2.5 py-1 font-mono text-vault-text">
                        {formatSimulatedValue(result.fromValue, result.unit)}
                      </span>
                      <ArrowRight className="h-4 w-4 text-red-400" aria-hidden="true" />
                      <span className="rounded-lg border border-red-400/30 bg-red-500/10 px-2.5 py-1 font-mono font-semibold text-red-200">
                        {formatSimulatedValue(result.toValue, result.unit)}
                      </span>
                    </div>
                  </div>
                  {result.blocked && result.blockedReason && (
                    <p className="mt-2 flex items-center gap-2 text-sm text-red-300">
                      <ShieldAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
                      {result.blockedReason}
                    </p>
                  )}
                  <p className="mt-2 text-xs text-vault-muted">{result.riskMessage}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-vault-muted">
                    {result.affectedServices.map((service) => (
                      <span key={service} className="rounded-full border border-vault-border bg-vault-bg/40 px-2 py-0.5">
                        {service}
                      </span>
                    ))}
                  </div>
                </li>
              ))}
            </ul>

            <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-vault-border pt-4">
              <label className="flex items-center gap-2 text-sm text-vault-muted">
                <input
                  type="checkbox"
                  checked={overrideBlocked}
                  onChange={(e) => setOverrideBlocked(e.target.checked)}
                  className="h-4 w-4 accent-red-500"
                />
                Allow override of blocked stringencies (requires explicit sign-off in the proposal)
              </label>
              <button type="button" onClick={downloadPreview} className="vq-btn-ghost ml-auto">
                <Download className="h-4 w-4" aria-hidden="true" />
                Download diff JSON
              </button>
            </div>
          </>
        )}
      </section>

      <div className="grid gap-6 lg:grid-cols-[1.15fr_0.85fr]">
        <section className="vq-glass p-5 sm:p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-vault-text">Active rounds</h2>
              <p className="mt-1 text-sm text-vault-muted">
                Operational snapshot for the rounds currently being managed.
              </p>
            </div>
            <Clock3 className="h-5 w-5 text-red-400" aria-hidden="true" />
          </div>

          <div className="mt-5 space-y-4">
            {ACTIVE_ROUNDS.map((round) => (
              <article
                key={round.name}
                className="rounded-2xl border border-vault-border bg-vault-surface/40 p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-base font-semibold text-vault-text">{round.name}</h3>
                      <StatusBadge status={round.status} />
                    </div>
                    <p className="mt-1 text-sm text-vault-muted">{round.deadline}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-lg font-bold text-vault-text">{round.pool}</p>
                    <p className="text-xs uppercase tracking-[0.24em] text-vault-muted">
                      Pool size
                    </p>
                  </div>
                </div>

                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <div className="rounded-xl border border-vault-border bg-vault-bg/40 p-3">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-vault-muted">
                      Participants
                    </p>
                    <p className="mt-1 text-sm font-medium text-vault-text">{round.participants}</p>
                  </div>
                  <div className="rounded-xl border border-vault-border bg-vault-bg/40 p-3">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-vault-muted">
                      Next action
                    </p>
                    <p className="mt-1 text-sm font-medium text-vault-text">{round.nextAction}</p>
                  </div>
                </div>

                <div className="mt-4">
                  <div className="mb-2 flex items-center justify-between text-xs text-vault-muted">
                    <span>Round progress</span>
                    <span>{round.progress}%</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-vault-border/40">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-red-500 to-amber-400"
                      style={{ width: `${round.progress}%` }}
                    />
                  </div>
                </div>
              </article>
            ))}
          </div>
        </section>

        <div className="space-y-6">
          <section className="vq-glass p-5 sm:p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-vault-text">Service status</h2>
                <p className="mt-1 text-sm text-vault-muted">
                  Monitored services that affect protocol visibility and execution.
                </p>
              </div>
              <Server className="h-5 w-5 text-red-400" aria-hidden="true" />
            </div>

            <div className="mt-5 space-y-3">
              {serviceItems.map((service) => (
                <div
                  key={service.name}
                  className="flex flex-col gap-2 rounded-2xl border border-vault-border bg-vault-surface/40 p-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-3">
                      <span className={`mt-1 h-2.5 w-2.5 rounded-full ${STATUS_STYLE[service.status]?.dot ?? "bg-gray-400"}`} />
                      <div>
                        <p className="font-medium text-vault-text">{service.name}</p>
                        <p className="mt-1 text-sm text-vault-muted">{service.detail}</p>
                      </div>
                    </div>
                    <StatusBadge status={service.status} />
                  </div>

                  {/* Remediation Links for Stale or Failed Statuses */}
                  {service.name === "Indexer" && service.status !== "operational" && service.status !== "loading" && (
                    <div className="mt-1 pl-5.5 text-xs text-amber-300">
                      <span>See the </span>
                      <a href="/docs/INDEXER_RUNBOOK.md" className="underline font-semibold hover:text-white transition-colors">
                        Indexer Operations Runbook
                      </a>
                      <span> for recovery steps.</span>
                    </div>
                  )}
                  {service.name === "Smart contract" && service.status !== "operational" && service.status !== "loading" && (
                    <div className="mt-1 pl-5.5 text-xs text-red-300">
                      <span>Verify deployment or see </span>
                      <a href="/docs/env-inventory.md" className="underline font-semibold hover:text-white transition-colors">
                        Environment Inventory Guide
                      </a>
                      <span>.</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>

          <section className="vq-glass p-5 sm:p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-vault-text">Operational notes</h2>
                <p className="mt-1 text-sm text-vault-muted">
                  A lightweight runbook for the current protocol cycle.
                </p>
              </div>
              <CheckCircle2 className="h-5 w-5 text-emerald-400" aria-hidden="true" />
            </div>

            <div className="mt-5 space-y-3">
              {OPERATIONAL_NOTES.map((note, index) => (
                <div
                  key={note.title}
                  className="flex items-start gap-3 rounded-2xl border border-vault-border bg-vault-surface/40 p-4"
                >
                  <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-red-500/10 text-xs font-semibold text-red-300">
                    {index + 1}
                  </span>
                  <div>
                    <p className="font-medium text-vault-text">{note.title}</p>
                    <p className="mt-1 text-sm text-vault-muted">{note.body}</p>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
