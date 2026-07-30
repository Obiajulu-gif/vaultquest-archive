"use client";

import { useState, useEffect } from "react";
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
} from "lucide-react";
import { motion } from "framer-motion";
import { ADMIN_ADDRESSES } from "../admin-config";

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

function ProposalCard({ proposal, isAdmin, onApprove, onReject }) {
  const [expanded, setExpanded] = useState(false);
  const statusConfig = STATUS_CONFIG[proposal.status];
  const Icon = proposal.icon;

  const canInteract = isAdmin && proposal.status === "pending";

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

        {/* Timeline Section */}
        {proposal.status === "pending" && (
          <div className="mt-5 border-t border-vault-border/30 pt-4">
            <ProposalTimeline proposal={proposal} />
          </div>
        )}

        {/* Action Buttons */}
        {canInteract && (
          <div className="mt-5 flex gap-3 border-t border-vault-border/30 pt-4">
            <button
              type="button"
              onClick={() => onApprove(proposal.id)}
              className="vq-btn-primary flex-1"
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
              ✓ Executed on {new Date(proposal.executedAt).toLocaleString()}
            </p>
          </div>
        )}
        {proposal.status === "rejected" && proposal.rejectedAt && (
          <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 p-3">
            <p className="text-xs text-red-600 dark:text-red-400">
              ✗ Rejected on {new Date(proposal.rejectedAt).toLocaleString()}
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
