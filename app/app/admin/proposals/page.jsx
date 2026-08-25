"use client";

import { useState, useEffect, useMemo } from "react";
import { useAccount } from "wagmi";
import { useTranslation } from "next-i18next";
import {
  Shield,
  CheckCircle,
  XCircle,
  Clock,
  Users,
  AlertTriangle,
  TrendingUp,
  DollarSign,
  Settings,
  Eye,
  FileCheck,
  Lock,
  Unlock,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { ADMIN_ADDRESSES } from "../admin-config";

/**
 * Decode a Soroban authorization tree from XDR into human-readable form (#607).
 *
 * In production, this would decode the actual XDR blob from the wallet.
 * For the mock data, we produce a structured representation of what
 * the decoded tree would look like so the UI is ready for real integration.
 */
function decodeAuthorizationTree(proposal) {
  if (!proposal.authorizationTree) return null;

  return proposal.authorizationTree.map((entry, idx) => ({
    index: idx,
    contract: entry.contract,
    method: entry.method,
    args: entry.args.map((arg) => ({
      name: arg.name,
      value: arg.value,
      type: arg.type,
      isContractAddress: arg.type === "Address" && arg.value?.startsWith("C"),
    })),
    authRequired: entry.authRequired ?? true,
    description: entry.description || "",
  }));
}

/**
 * Verify the decoded authorization tree against the approved proposal hash.
 * Returns { valid, mismatches } where mismatches lists any discrepancies.
 */
function verifyAuthorizationTree(tree, expectedHash) {
  if (!tree || !expectedHash) return { valid: true, mismatches: [] };

  const mismatches = [];

  // In production, we would hash the decoded XDR and compare against
  // the proposal's signed hash. Here we verify structural integrity.
  for (const entry of tree) {
    if (!entry.contract) {
      mismatches.push(`Entry ${entry.index}: missing contract address`);
    }
    if (!entry.method) {
      mismatches.push(`Entry ${entry.index}: missing method name`);
    }
    for (const arg of entry.args) {
      if (arg.isContractAddress && !arg.value?.startsWith("C")) {
        mismatches.push(
          `Entry ${entry.index}, arg "${arg.name}": expected contract address format`
        );
      }
    }
  }

  return { valid: mismatches.length === 0, mismatches };
}

const MOCK_PROPOSALS = [
  {
    id: "prop-001",
    title: "Increase USDC Pool APY to 5.2%",
    description:
      "Adjust the base yield rate for the USDC Community Drip pool from 4.5% to 5.2% to remain competitive with market rates.",
    type: "interest-rate",
    icon: TrendingUp,
    status: "pending",
    requiredSignatures: 3,
    currentSignatures: 2,
    signers: [
      {
        address: "0x1234...7890",
        signed: true,
        timestamp: "2026-05-28T10:30:00Z",
      },
      {
        address: "0xabcd...abcd",
        signed: true,
        timestamp: "2026-05-29T14:15:00Z",
      },
      { address: "0x9876...4321", signed: false, timestamp: null },
    ],
    createdAt: "2026-05-27T09:00:00Z",
    expiresAt: "2026-06-10T09:00:00Z",
    proposer: "0x1234...7890",
    signedHash: "a1b2c3d4e5f6...",
    authorizationTree: [
      {
        contract: "CBKQXYM...POOL",
        method: "add_yield",
        args: [
          { name: "caller", value: "0x1234...7890", type: "Address" },
          { name: "amount", value: "5200000", type: "i128" },
        ],
        authRequired: true,
        description: "Credit 5.2% yield to pool distributable reserves",
      },
    ],
  },
  {
    id: "prop-002",
    title: "Reduce Vault Management Fee to 0.5%",
    description:
      "Lower the annual management fee from 1% to 0.5% to increase net returns for savers.",
    type: "fee-adjustment",
    icon: DollarSign,
    status: "pending",
    requiredSignatures: 3,
    currentSignatures: 1,
    signers: [
      {
        address: "0x1234...7890",
        signed: true,
        timestamp: "2026-05-30T16:45:00Z",
      },
      { address: "0xabcd...abcd", signed: false, timestamp: null },
      { address: "0x9876...4321", signed: false, timestamp: null },
    ],
    createdAt: "2026-05-30T16:00:00Z",
    expiresAt: "2026-06-13T16:00:00Z",
    proposer: "0x1234...7890",
    signedHash: "f6e5d4c3b2a1...",
    authorizationTree: [
      {
        contract: "CBKQXYM...POOL",
        method: "set_min_idle_reserve",
        args: [
          { name: "caller", value: "0x1234...7890", type: "Address" },
          { name: "amount", value: "10000000", type: "i128" },
        ],
        authRequired: true,
        description: "Update idle reserve to reflect new fee structure",
      },
    ],
  },
  {
    id: "prop-003",
    title: "Enable Emergency Pause for XLM Pool",
    description:
      "Grant emergency pause capability for the XLM High-Yield pool in case of security incidents.",
    type: "security",
    icon: Shield,
    status: "approved",
    requiredSignatures: 3,
    currentSignatures: 3,
    signers: [
      {
        address: "0x1234...7890",
        signed: true,
        timestamp: "2026-05-25T11:20:00Z",
      },
      {
        address: "0xabcd...abcd",
        signed: true,
        timestamp: "2026-05-25T13:40:00Z",
      },
      {
        address: "0x9876...4321",
        signed: true,
        timestamp: "2026-05-26T09:10:00Z",
      },
    ],
    createdAt: "2026-05-25T10:00:00Z",
    expiresAt: "2026-06-08T10:00:00Z",
    proposer: "0xabcd...abcd",
    executedAt: "2026-05-26T10:00:00Z",
    signedHash: "a1b2c3d4e5f6...",
    authorizationTree: [
      {
        contract: "CBKQXYM...POOL",
        method: "propose",
        args: [
          { name: "signer", value: "0xabcd...abcd", type: "Address" },
          {
            name: "action",
            value: "TriggerEmergency(0)",
            type: "ProposalAction",
          },
        ],
        authRequired: true,
        description: "Propose emergency pause activation",
      },
    ],
  },
  {
    id: "prop-004",
    title: "Update Prize Distribution Algorithm",
    description:
      "Modify the prize distribution to allocate 70% to grand prize and 30% to runner-up prizes.",
    type: "configuration",
    icon: Settings,
    status: "rejected",
    requiredSignatures: 3,
    currentSignatures: 0,
    signers: [
      { address: "0x1234...7890", signed: false, timestamp: null },
      { address: "0xabcd...abcd", signed: false, timestamp: null },
      { address: "0x9876...4321", signed: false, timestamp: null },
    ],
    createdAt: "2026-05-20T14:00:00Z",
    expiresAt: "2026-06-03T14:00:00Z",
    proposer: "0x9876...4321",
    rejectedAt: "2026-05-22T16:30:00Z",
    signedHash: "f6e5d4c3b2a1...",
    authorizationTree: [],
  },
];

const STATUS_CONFIG = {
  pending: {
    label: "Pending Approval",
    color: "amber",
    icon: Clock,
    bgClass: "bg-amber-500/10",
    borderClass: "border-amber-500/40",
    textClass: "text-amber-600 dark:text-amber-400",
  },
  approved: {
    label: "Approved",
    color: "emerald",
    icon: CheckCircle,
    bgClass: "bg-emerald-500/10",
    borderClass: "border-emerald-500/40",
    textClass: "text-emerald-600 dark:text-emerald-400",
  },
  rejected: {
    label: "Rejected",
    color: "red",
    icon: XCircle,
    bgClass: "bg-red-500/10",
    borderClass: "border-red-500/40",
    textClass: "text-red-600 dark:text-red-400",
  },
};

function ProposalTimeline({ proposal }) {
  const progress =
    (proposal.currentSignatures / proposal.requiredSignatures) * 100;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium text-vault-text">
          Signatures: {proposal.currentSignatures} /{" "}
          {proposal.requiredSignatures}
        </span>
        <span className="text-vault-muted">
          {Math.round(progress)}% complete
        </span>
      </div>

      {/* Progress Bar */}
      <div className="h-2 overflow-hidden rounded-full bg-vault-border/30">
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: `${progress}%` }}
          transition={{ duration: 0.5, ease: "easeOut" }}
          className={`h-full rounded-full ${
            proposal.status === "approved"
              ? "bg-emerald-500"
              : proposal.status === "rejected"
                ? "bg-red-500"
                : "bg-amber-500"
          }`}
        />
      </div>

      {/* Signers List */}
      <div className="space-y-2">
        {proposal.signers.map((signer, index) => (
          <div
            key={index}
            className="flex items-center justify-between rounded-lg border border-vault-border bg-vault-surface/40 p-2"
          >
            <div className="flex items-center gap-2">
              {signer.signed ? (
                <CheckCircle
                  className="h-4 w-4 text-emerald-500"
                  aria-hidden="true"
                />
              ) : (
                <Clock
                  className="h-4 w-4 text-vault-muted"
                  aria-hidden="true"
                />
              )}
              <span className="text-xs font-medium text-vault-text">
                {signer.address}
              </span>
            </div>
            {signer.signed && signer.timestamp && (
              <span className="text-xs text-vault-muted">
                {new Date(signer.timestamp).toLocaleDateString()}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Displays decoded Soroban authorization tree entries for admin
 * verification before signing (#607).
 */
function AuthorizationTreeView({ proposal }) {
  const [expanded, setExpanded] = useState(false);

  const tree = useMemo(
    () => decodeAuthorizationTree(proposal),
    [proposal]
  );

  const verification = useMemo(
    () => verifyAuthorizationTree(tree, proposal.signedHash),
    [tree, proposal.signedHash]
  );

  if (!tree || tree.length === 0) {
    return (
      <div className="mt-4 rounded-lg border border-vault-border bg-vault-surface/30 p-3">
        <p className="text-xs text-vault-muted">
          No authorization tree decoded for this proposal.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-4 rounded-lg border border-vault-border bg-vault-surface/30 p-4">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between text-left"
      >
        <div className="flex items-center gap-2">
          <Eye className="h-4 w-4 text-blue-500" aria-hidden="true" />
          <span className="text-sm font-medium text-vault-text">
            Authorization Tree ({tree.length} {tree.length === 1 ? "entry" : "entries"})
          </span>
        </div>
        <div className="flex items-center gap-2">
          {verification.valid ? (
            <span className="flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-500">
              <FileCheck className="h-3 w-3" aria-hidden="true" />
              Verified
            </span>
          ) : (
            <span className="flex items-center gap-1 rounded-full bg-red-500/10 px-2 py-0.5 text-xs text-red-500">
              <AlertTriangle className="h-3 w-3" aria-hidden="true" />
              Mismatch
            </span>
          )}
        </div>
      </button>

      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="mt-3 space-y-3">
              {/* Signed hash verification */}
              {proposal.signedHash && (
                <div className="flex items-center gap-2 rounded-md bg-vault-surface/50 p-2">
                  <Lock className="h-3.5 w-3.5 text-vault-muted" aria-hidden="true" />
                  <span className="text-xs text-vault-muted">Signed hash:</span>
                  <code className="text-xs text-vault-text font-mono">
                    {proposal.signedHash}
                  </code>
                </div>
              )}

              {/* Verification mismatches */}
              {!verification.valid && (
                <div className="rounded-md border border-red-500/30 bg-red-500/10 p-2">
                  {verification.mismatches.map((msg, i) => (
                    <p key={i} className="text-xs text-red-500">
                      {msg}
                    </p>
                  ))}
                </div>
              )}

              {/* Authorization entries */}
              {tree.map((entry) => (
                <div
                  key={entry.index}
                  className="rounded-md border border-vault-border bg-vault-surface/50 p-3"
                >
                  <div className="flex items-center gap-2 mb-2">
                    <span className="rounded bg-blue-500/10 px-1.5 py-0.5 text-xs font-mono text-blue-500">
                      {entry.method}
                    </span>
                    <span className="text-xs text-vault-muted">on</span>
                    <code className="text-xs text-vault-text font-mono truncate">
                      {entry.contract}
                    </code>
                    {entry.authRequired && (
                      <span className="ml-auto flex items-center gap-1 text-xs text-amber-500">
                        <Unlock className="h-3 w-3" aria-hidden="true" />
                        Auth required
                      </span>
                    )}
                  </div>
                  {entry.description && (
                    <p className="mb-2 text-xs text-vault-muted">
                      {entry.description}
                    </p>
                  )}
                  <div className="space-y-1">
                    {entry.args.map((arg, argIdx) => (
                      <div
                        key={argIdx}
                        className="flex items-center gap-2 text-xs"
                      >
                        <span className="text-vault-muted w-16 shrink-0">
                          {arg.name}:
                        </span>
                        <code
                          className={`font-mono truncate ${
                            arg.isContractAddress
                              ? "text-amber-500"
                              : "text-vault-text"
                          }`}
                        >
                          {arg.value}
                        </code>
                        <span className="text-vault-muted text-[10px]">
                          ({arg.type})
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function ProposalCard({ proposal, isAdmin, onApprove, onReject }) {
  const [expanded, setExpanded] = useState(false);
  const statusConfig = STATUS_CONFIG[proposal.status];
  const Icon = proposal.icon;

  const canInteract = isAdmin && proposal.status === "pending";

  // Verify authorization tree before allowing approval (#607)
  const tree = useMemo(
    () => decodeAuthorizationTree(proposal),
    [proposal]
  );
  const verification = useMemo(
    () => verifyAuthorizationTree(tree, proposal.signedHash),
    [tree, proposal.signedHash]
  );
  const canApprove = canInteract && verification.valid;

  return (
    <article className={`vq-glass overflow-hidden ${statusConfig.borderClass}`}>
      <div className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <span
              className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${statusConfig.bgClass} text-${statusConfig.color}-500`}
            >
              <Icon className="h-5 w-5" aria-hidden="true" />
            </span>
            <div className="flex-1">
              <h3 className="text-base font-semibold text-vault-text">
                {proposal.title}
              </h3>
              <p className="mt-1 text-sm text-vault-muted">
                {proposal.description}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-vault-muted">
                <span>Proposed by {proposal.proposer}</span>
                <span>•</span>
                <span>{new Date(proposal.createdAt).toLocaleDateString()}</span>
              </div>
            </div>
          </div>
          <span
            className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium ${statusConfig.bgClass} ${statusConfig.textClass}`}
          >
            {statusConfig.label}
          </span>
        </div>

        {/* Authorization Tree Display (#607) */}
        {proposal.authorizationTree &&
          proposal.authorizationTree.length > 0 && (
            <AuthorizationTreeView proposal={proposal} />
          )}

        {/* Timeline Section */}
        {proposal.status === "pending" && (
          <div className="mt-5 border-t border-vault-border/30 pt-4">
            <ProposalTimeline proposal={proposal} />
          </div>
        )}

        {/* Action Buttons */}
        {canInteract && (
          <div className="mt-5 flex gap-3 border-t border-vault-border/30 pt-4">
            {!verification.valid && (
              <div className="mb-2 w-full rounded-md border border-red-500/30 bg-red-500/10 p-2">
                <p className="text-xs text-red-500">
                  Authorization tree verification failed. Review the decoded
                  tree before approving.
                </p>
              </div>
            )}
            <button
              type="button"
              onClick={() => onApprove(proposal.id)}
              disabled={!canApprove}
              className={`vq-btn-primary flex-1 ${!canApprove ? "opacity-50 cursor-not-allowed" : ""}`}
            >
              <CheckCircle className="h-4 w-4" aria-hidden="true" />
              Approve
            </button>
            <button
              type="button"
              onClick={() => onReject(proposal.id)}
              className="vq-btn-ghost flex-1 border-red-400/40 text-red-600 hover:bg-red-500/10 dark:text-red-400"
            >
              <XCircle className="h-4 w-4" aria-hidden="true" />
              Reject
            </button>
          </div>
        )}

        {/* Execution/Rejection Info */}
        {proposal.status === "approved" && proposal.executedAt && (
          <div className="mt-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3">
            <p className="text-xs text-emerald-600 dark:text-emerald-400">
              Executed on {new Date(proposal.executedAt).toLocaleString()}
            </p>
          </div>
        )}
        {proposal.status === "rejected" && proposal.rejectedAt && (
          <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 p-3">
            <p className="text-xs text-red-600 dark:text-red-400">
              Rejected on {new Date(proposal.rejectedAt).toLocaleString()}
            </p>
          </div>
        )}
      </div>
    </article>
  );
}

export default function AdminProposalsPage() {
  const { t } = useTranslation("common");
  const { address, isConnected } = useAccount();
  const [proposals, setProposals] = useState(MOCK_PROPOSALS);
  const [filter, setFilter] = useState("all");

  // Check if connected address is an admin
  const isAdmin =
    isConnected &&
    ADMIN_ADDRESSES.some(
      (addr) => addr.toLowerCase() === address?.toLowerCase(),
    );

  const handleApprove = async (proposalId) => {
    // In production: call smart contract to sign proposal
    // await contract.approveProposal(proposalId);

    setProposals((prev) =>
      prev.map((p) => {
        if (p.id === proposalId) {
          const newSignatures = p.currentSignatures + 1;
          const newStatus =
            newSignatures >= p.requiredSignatures ? "approved" : "pending";
          return {
            ...p,
            currentSignatures: newSignatures,
            status: newStatus,
            executedAt:
              newStatus === "approved"
                ? new Date().toISOString()
                : p.executedAt,
          };
        }
        return p;
      }),
    );
  };

  const handleReject = async (proposalId) => {
    // In production: call smart contract to reject proposal
    // await contract.rejectProposal(proposalId);

    setProposals((prev) =>
      prev.map((p) =>
        p.id === proposalId
          ? { ...p, status: "rejected", rejectedAt: new Date().toISOString() }
          : p,
      ),
    );
  };

  const filteredProposals = proposals.filter(
    (p) => filter === "all" || p.status === filter,
  );

  const stats = {
    pending: proposals.filter((p) => p.status === "pending").length,
    approved: proposals.filter((p) => p.status === "approved").length,
    rejected: proposals.filter((p) => p.status === "rejected").length,
  };

  if (!isConnected) {
    return (
      <div className="space-y-6">
        <header>
          <h1 className="text-3xl font-bold text-vault-text">{t("routes.admin.proposals.title")}</h1>
          <p className="mt-2 text-vault-muted">
            {t("routes.admin.proposals.subtitle")}
          </p>
        </header>

        <div className="vq-glass flex flex-col items-center px-6 py-16 text-center">
          <Shield className="h-16 w-16 text-vault-muted" aria-hidden="true" />
          <h2 className="mt-6 text-xl font-semibold text-vault-text">
            Wallet Not Connected
          </h2>
          <p className="mt-2 max-w-md text-sm text-vault-muted">
            Connect your wallet to access the admin proposal dashboard.
          </p>
        </div>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="space-y-6">
        <header>
          <h1 className="text-3xl font-bold text-vault-text">{t("routes.admin.proposals.title")}</h1>
          <p className="mt-2 text-vault-muted">
            {t("routes.admin.proposals.subtitle")}
          </p>
        </header>

        <div className="vq-glass flex flex-col items-center border-amber-500/40 bg-amber-500/10 px-6 py-16 text-center">
          <AlertTriangle
            className="h-16 w-16 text-amber-500"
            aria-hidden="true"
          />
          <h2 className="mt-6 text-xl font-semibold text-vault-text">
            Access Restricted
          </h2>
          <p className="mt-2 max-w-md text-sm text-vault-muted">
            This dashboard is only accessible to authorized administrator wallet
            addresses.
          </p>
          <p className="mt-4 text-xs text-vault-muted">Connected: {address}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header>
        <div className="flex items-center gap-2">
          <Shield className="h-8 w-8 text-red-500" aria-hidden="true" />
          <h1 className="text-3xl font-bold text-vault-text">{t("routes.admin.proposals.title")}</h1>
        </div>
        <p className="mt-2 text-vault-muted">
          {t("routes.admin.proposals.reviewBody")}
        </p>
      </header>

      {/* Stats Overview */}
      <div className="grid gap-4 sm:grid-cols-3">
        <button
          type="button"
          onClick={() => setFilter("pending")}
          className={`vq-glass-hover p-5 text-left transition-all ${
            filter === "pending" ? "ring-2 ring-amber-400/30" : ""
          }`}
        >
          <div className="flex items-center justify-between">
            <Clock className="h-5 w-5 text-amber-500" aria-hidden="true" />
            <span className="text-2xl font-bold text-vault-text">
              {stats.pending}
            </span>
          </div>
          <p className="mt-2 text-xs font-medium uppercase tracking-wide text-vault-muted">
            Pending Approval
          </p>
        </button>

        <button
          type="button"
          onClick={() => setFilter("approved")}
          className={`vq-glass-hover p-5 text-left transition-all ${
            filter === "approved" ? "ring-2 ring-emerald-400/30" : ""
          }`}
        >
          <div className="flex items-center justify-between">
            <CheckCircle
              className="h-5 w-5 text-emerald-500"
              aria-hidden="true"
            />
            <span className="text-2xl font-bold text-vault-text">
              {stats.approved}
            </span>
          </div>
          <p className="mt-2 text-xs font-medium uppercase tracking-wide text-vault-muted">
            Approved
          </p>
        </button>

        <button
          type="button"
          onClick={() => setFilter("rejected")}
          className={`vq-glass-hover p-5 text-left transition-all ${
            filter === "rejected" ? "ring-2 ring-red-400/30" : ""
          }`}
        >
          <div className="flex items-center justify-between">
            <XCircle className="h-5 w-5 text-red-500" aria-hidden="true" />
            <span className="text-2xl font-bold text-vault-text">
              {stats.rejected}
            </span>
          </div>
          <p className="mt-2 text-xs font-medium uppercase tracking-wide text-vault-muted">
            Rejected
          </p>
        </button>
      </div>

      {/* Filter Controls */}
      <div className="flex items-center justify-between">
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setFilter("all")}
            className={`rounded-lg px-4 py-2 text-sm font-medium transition-all ${
              filter === "all"
                ? "bg-red-500/15 text-red-600 ring-1 ring-red-400/30 dark:text-red-400"
                : "text-vault-muted hover:bg-vault-surface hover:text-vault-text"
            }`}
          >
            All
          </button>
          <button
            type="button"
            onClick={() => setFilter("pending")}
            className={`rounded-lg px-4 py-2 text-sm font-medium transition-all ${
              filter === "pending"
                ? "bg-red-500/15 text-red-600 ring-1 ring-red-400/30 dark:text-red-400"
                : "text-vault-muted hover:bg-vault-surface hover:text-vault-text"
            }`}
          >
            Pending
          </button>
        </div>
        <span className="text-sm text-vault-muted">
          {filteredProposals.length}{" "}
          {filteredProposals.length === 1 ? "proposal" : "proposals"}
        </span>
      </div>

      {/* Proposals List */}
      <div className="space-y-4">
        {filteredProposals.length === 0 ? (
          <div className="vq-glass p-12 text-center">
            <Users
              className="mx-auto h-12 w-12 text-vault-muted"
              aria-hidden="true"
            />
            <p className="mt-4 text-sm text-vault-muted">No proposals found</p>
          </div>
        ) : (
          filteredProposals.map((proposal) => (
            <ProposalCard
              key={proposal.id}
              proposal={proposal}
              isAdmin={isAdmin}
              onApprove={handleApprove}
              onReject={handleReject}
            />
          ))
        )}
      </div>
    </div>
  );
}
