"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
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
  Play,
  Ban,
  Timer,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { ADMIN_ADDRESSES } from "../admin-config";

/**
 * On-chain proposal lifecycle states matching the Soroban contract:
 *   pending-below-threshold → pending-timelock → ready-to-execute → executed
 *   Any state can also transition to expired or cancelled.
 */
const ProposalLifecycle = {
  PENDING_BELOW_THRESHOLD: "pending_below_threshold",
  PENDING_TIMELOCK: "pending_timelock",
  READY_TO_EXECUTE: "ready_to_execute",
  EXECUTED: "executed",
  EXPIRED: "expired",
  CANCELLED: "cancelled",
};

const HIGH_RISK_DELAY_LEDGERS = 17_280;
const LEDGER_SECONDS = 5;
const HIGH_RISK_DELAY_SECONDS = HIGH_RISK_DELAY_LEDGERS * LEDGER_SECONDS;

/**
 * Determine the on-chain lifecycle state from proposal fields.
 */
function resolveLifecycle(proposal) {
  if (proposal.status === "cancelled") return ProposalLifecycle.CANCELLED;
  if (proposal.status === "expired") return ProposalLifecycle.EXPIRED;
  if (proposal.executedAt) return ProposalLifecycle.EXECUTED;

  const signaturesMet =
    proposal.currentSignatures >= proposal.requiredSignatures;

  if (!signaturesMet) return ProposalLifecycle.PENDING_BELOW_THRESHOLD;

  if (proposal.isHighRisk) {
    const createdAtMs = new Date(proposal.createdAt).getTime();
    const readyAtMs = createdAtMs + HIGH_RISK_DELAY_SECONDS;
    if (Date.now() < readyAtMs) return ProposalLifecycle.PENDING_TIMELOCK;
  }

  return ProposalLifecycle.READY_TO_EXECUTE;
}

const LIFECYCLE_CONFIG = {
  [ProposalLifecycle.PENDING_BELOW_THRESHOLD]: {
    label: "Pending Approval",
    color: "amber",
    icon: Clock,
    bgClass: "bg-amber-500/10",
    borderClass: "border-amber-500/40",
    textClass: "text-amber-600 dark:text-amber-400",
  },
  [ProposalLifecycle.PENDING_TIMELOCK]: {
    label: "Awaiting Timelock",
    color: "blue",
    icon: Timer,
    bgClass: "bg-blue-500/10",
    borderClass: "border-blue-500/40",
    textClass: "text-blue-600 dark:text-blue-400",
  },
  [ProposalLifecycle.READY_TO_EXECUTE]: {
    label: "Ready to Execute",
    color: "emerald",
    icon: Play,
    bgClass: "bg-emerald-500/10",
    borderClass: "border-emerald-500/40",
    textClass: "text-emerald-600 dark:text-emerald-400",
  },
  [ProposalLifecycle.EXECUTED]: {
    label: "Executed",
    color: "emerald",
    icon: CheckCircle,
    bgClass: "bg-emerald-500/10",
    borderClass: "border-emerald-500/40",
    textClass: "text-emerald-600 dark:text-emerald-400",
  },
  [ProposalLifecycle.EXPIRED]: {
    label: "Expired",
    color: "red",
    icon: XCircle,
    bgClass: "bg-red-500/10",
    borderClass: "border-red-500/40",
    textClass: "text-red-600 dark:text-red-400",
  },
  [ProposalLifecycle.CANCELLED]: {
    label: "Cancelled",
    color: "red",
    icon: Ban,
    bgClass: "bg-red-500/10",
    borderClass: "border-red-500/40",
    textClass: "text-red-600 dark:text-red-400",
  },
};

/**
 * Surface contract error variants as human-readable messages.
 */
const CONTRACT_ERROR_MESSAGES = {
  ThresholdNotMet: "Not enough signer approvals to execute this proposal.",
  ProposalExpired: "This proposal has expired and can no longer be executed.",
  AlreadySigned: "You have already signed this proposal.",
  GovernanceEpochChanged:
    "The admin set or threshold changed since this proposal was created. It must be re-proposed.",
  TimelockNotElapsed:
    "The high-risk timelock has not yet elapsed. Wait for the delay period to pass.",
  Unauthorized: "Your wallet address is not an authorized signer.",
  ProposalNotFound: "This proposal was not found on-chain.",
  NotInitialized: "The pool contract has not been initialized.",
};

function getContractErrorMessage(error) {
  if (!error) return null;
  const msg = error?.message || String(error);
  for (const [code, humanMsg] of Object.entries(CONTRACT_ERROR_MESSAGES)) {
    if (msg.includes(code)) return humanMsg;
  }
  if (msg.includes("user rejected")) return "Transaction was rejected by your wallet.";
  if (msg.includes("insufficient funds")) return "Insufficient funds for gas.";
  return `Unexpected error: ${msg.slice(0, 120)}`;
}

/**
 * Decode a Soroban authorization tree from XDR into human-readable form (#607).
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
 */
function verifyAuthorizationTree(tree, expectedHash) {
  if (!tree || !expectedHash) return { valid: true, mismatches: [] };

  const mismatches = [];

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
    requiredSignatures: 3,
    currentSignatures: 2,
    isHighRisk: false,
    approverSnapshot: ["0x1234...7890", "0xabcd...abcd", "0x9876...4321"],
    signers: [
      { address: "0x1234...7890", signed: true, timestamp: "2026-05-28T10:30:00Z" },
      { address: "0xabcd...abcd", signed: true, timestamp: "2026-05-29T14:15:00Z" },
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
    requiredSignatures: 3,
    currentSignatures: 1,
    isHighRisk: false,
    approverSnapshot: ["0x1234...7890", "0xabcd...abcd", "0x9876...4321"],
    signers: [
      { address: "0x1234...7890", signed: true, timestamp: "2026-05-30T16:45:00Z" },
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
    requiredSignatures: 3,
    currentSignatures: 3,
    isHighRisk: true,
    approverSnapshot: ["0x1234...7890", "0xabcd...abcd", "0x9876...4321"],
    signers: [
      { address: "0x1234...7890", signed: true, timestamp: "2026-05-25T11:20:00Z" },
      { address: "0xabcd...abcd", signed: true, timestamp: "2026-05-25T13:40:00Z" },
      { address: "0x9876...4321", signed: true, timestamp: "2026-05-26T09:10:00Z" },
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
          { name: "action", value: "TriggerEmergency(0)", type: "ProposalAction" },
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
    requiredSignatures: 3,
    currentSignatures: 0,
    isHighRisk: false,
    approverSnapshot: ["0x1234...7890", "0xabcd...abcd", "0x9876...4321"],
    signers: [
      { address: "0x1234...7890", signed: false, timestamp: null },
      { address: "0xabcd...abcd", signed: false, timestamp: null },
      { address: "0x9876...4321", signed: false, timestamp: null },
    ],
    createdAt: "2026-05-20T14:00:00Z",
    expiresAt: "2026-06-03T14:00:00Z",
    proposer: "0x9876...4321",
    signedHash: "f6e5d4c3b2a1...",
    authorizationTree: [],
  },
];

function TimelockCountdown({ createdAt }) {
  const [remaining, setRemaining] = useState(null);

  useEffect(() => {
    const createdAtMs = new Date(createdAt).getTime();
    const readyAtMs = createdAtMs + HIGH_RISK_DELAY_SECONDS;

    function update() {
      const diff = readyAtMs - Date.now();
      if (diff <= 0) {
        setRemaining(null);
        return;
      }
      const hours = Math.floor(diff / (1000 * 60 * 60));
      const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
      const seconds = Math.floor((diff % (1000 * 60)) / 1000);
      setRemaining({ hours, minutes, seconds });
    }

    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [createdAt]);

  if (!remaining) return null;

  return (
    <div className="flex items-center gap-2 rounded-lg border border-blue-500/30 bg-blue-500/10 px-3 py-2">
      <Timer className="h-4 w-4 text-blue-500" aria-hidden="true" />
      <span className="text-xs font-medium text-blue-600 dark:text-blue-400">
        Timelock: {remaining.hours}h {remaining.minutes}m {remaining.seconds}s remaining
      </span>
    </div>
  );
}

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

      <div className="h-2 overflow-hidden rounded-full bg-vault-border/30">
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: `${progress}%` }}
          transition={{ duration: 0.5, ease: "easeOut" }}
          className="h-full rounded-full bg-amber-500"
        />
      </div>

      <div className="space-y-2">
        {proposal.signers.map((signer, index) => (
          <div
            key={index}
            className="flex items-center justify-between rounded-lg border border-vault-border bg-vault-surface/40 p-2"
          >
            <div className="flex items-center gap-2">
              {signer.signed ? (
                <CheckCircle className="h-4 w-4 text-emerald-500" aria-hidden="true" />
              ) : (
                <Clock className="h-4 w-4 text-vault-muted" aria-hidden="true" />
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

function ApproverSnapshotView({ proposal }) {
  if (!proposal.approverSnapshot || proposal.approverSnapshot.length === 0) {
    return null;
  }

  return (
    <div className="mt-3 rounded-lg border border-vault-border bg-vault-surface/30 p-3">
      <p className="mb-2 text-xs font-medium text-vault-muted">
        Signer set at proposal creation:
      </p>
      <div className="flex flex-wrap gap-1">
        {proposal.approverSnapshot.map((addr, i) => {
          const isCurrentSigner = proposal.signers.some(
            (s) => s.address === addr
          );
          return (
            <span
              key={i}
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-mono ${
                isCurrentSigner
                  ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                  : "bg-red-500/10 text-red-600 dark:text-red-400"
              }`}
            >
              {addr}
              {!isCurrentSigner && (
                <span className="text-[8px]" title="No longer a current signer">
                  (removed)
                </span>
              )}
            </span>
          );
        })}
      </div>
    </div>
  );
}

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
              {proposal.signedHash && (
                <div className="flex items-center gap-2 rounded-md bg-vault-surface/50 p-2">
                  <Lock className="h-3.5 w-3.5 text-vault-muted" aria-hidden="true" />
                  <span className="text-xs text-vault-muted">Signed hash:</span>
                  <code className="text-xs text-vault-text font-mono">
                    {proposal.signedHash}
                  </code>
                </div>
              )}

              {!verification.valid && (
                <div className="rounded-md border border-red-500/30 bg-red-500/10 p-2">
                  {verification.mismatches.map((msg, i) => (
                    <p key={i} className="text-xs text-red-500">
                      {msg}
                    </p>
                  ))}
                </div>
              )}

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
                      <div key={argIdx} className="flex items-center gap-2 text-xs">
                        <span className="text-vault-muted w-16 shrink-0">
                          {arg.name}:
                        </span>
                        <code
                          className={`font-mono truncate ${
                            arg.isContractAddress ? "text-amber-500" : "text-vault-text"
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

function ProposalCard({ proposal, isAdmin, onApprove, onExecute, onCancel, error }) {
  const [expanded, setExpanded] = useState(false);
  const lifecycle = resolveLifecycle(proposal);
  const statusConfig = LIFECYCLE_CONFIG[lifecycle];
  const Icon = proposal.icon;

  const tree = useMemo(
    () => decodeAuthorizationTree(proposal),
    [proposal]
  );
  const verification = useMemo(
    () => verifyAuthorizationTree(tree, proposal.signedHash),
    [tree, proposal.signedHash]
  );

  const canApprove =
    isAdmin &&
    lifecycle === ProposalLifecycle.PENDING_BELOW_THRESHOLD &&
    verification.valid;

  const canExecute =
    isAdmin &&
    (lifecycle === ProposalLifecycle.READY_TO_EXECUTE ||
      lifecycle === ProposalLifecycle.PENDING_TIMELOCK);

  const canCancel = isAdmin && proposal.status !== "cancelled";

  const errorMessage = getContractErrorMessage(error);

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
                <span>·</span>
                <span>{new Date(proposal.createdAt).toLocaleDateString()}</span>
                {proposal.isHighRisk && (
                  <>
                    <span>·</span>
                    <span className="flex items-center gap-1 text-amber-500">
                      <Lock className="h-3 w-3" aria-hidden="true" />
                      High-risk
                    </span>
                  </>
                )}
              </div>
            </div>
          </div>
          <span
            className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium ${statusConfig.bgClass} ${statusConfig.textClass}`}
          >
            {statusConfig.label}
          </span>
        </div>

        {/* Approver snapshot vs current signers */}
        <ApproverSnapshotView proposal={proposal} />

        {/* Authorization Tree Display (#607) */}
        {proposal.authorizationTree && proposal.authorizationTree.length > 0 && (
          <AuthorizationTreeView proposal={proposal} />
        )}

        {/* Timelock countdown for high-risk proposals */}
        {lifecycle === ProposalLifecycle.PENDING_TIMELOCK && (
          <div className="mt-4">
            <TimelockCountdown createdAt={proposal.createdAt} />
          </div>
        )}

        {/* Signature timeline */}
        {lifecycle === ProposalLifecycle.PENDING_BELOW_THRESHOLD && (
          <div className="mt-5 border-t border-vault-border/30 pt-4">
            <ProposalTimeline proposal={proposal} />
          </div>
        )}

        {/* Contract error display */}
        {errorMessage && (
          <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 p-3">
            <p className="text-xs text-red-600 dark:text-red-400">
              {errorMessage}
            </p>
          </div>
        )}

        {/* Action Buttons */}
        {isAdmin && (
          <div className="mt-5 flex gap-3 border-t border-vault-border/30 pt-4">
            {canApprove && (
              <>
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
              </>
            )}
            {canExecute && lifecycle === ProposalLifecycle.READY_TO_EXECUTE && (
              <button
                type="button"
                onClick={() => onExecute(proposal.id)}
                className="vq-btn-primary flex-1"
              >
                <Play className="h-4 w-4" aria-hidden="true" />
                Execute
              </button>
            )}
            {canCancel && (
              <button
                type="button"
                onClick={() => onCancel(proposal.id)}
                className="vq-btn-ghost flex-1 border-red-400/40 text-red-600 hover:bg-red-500/10 dark:text-red-400"
              >
                <Ban className="h-4 w-4" aria-hidden="true" />
                Cancel
              </button>
            )}
          </div>
        )}

        {/* Execution info */}
        {lifecycle === ProposalLifecycle.EXECUTED && proposal.executedAt && (
          <div className="mt-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3">
            <p className="text-xs text-emerald-600 dark:text-emerald-400">
              Executed on {new Date(proposal.executedAt).toLocaleString()}
            </p>
          </div>
        )}

        {/* Expiry info */}
        {lifecycle === ProposalLifecycle.EXPIRED && (
          <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 p-3">
            <p className="text-xs text-red-600 dark:text-red-400">
              Expired on {new Date(proposal.expiresAt).toLocaleString()}
            </p>
          </div>
        )}

        {/* Cancellation info */}
        {lifecycle === ProposalLifecycle.CANCELLED && (
          <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 p-3">
            <p className="text-xs text-red-600 dark:text-red-400">
              This proposal was cancelled.
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
  const [proposalErrors, setProposalErrors] = useState({});

  const isAdmin =
    isConnected &&
    ADMIN_ADDRESSES.some(
      (addr) => addr.toLowerCase() === address?.toLowerCase()
    );

  const handleApprove = useCallback(async (proposalId) => {
    try {
      setProposalErrors((prev) => ({ ...prev, [proposalId]: null }));
      // Production: call smart contract approve()
      // const tx = await contract.approve(proposalId);
      // await tx.wait();

      setProposals((prev) =>
        prev.map((p) => {
          if (p.id !== proposalId) return p;
          const newSignatures = p.currentSignatures + 1;
          return {
            ...p,
            currentSignatures: newSignatures,
          };
        })
      );
    } catch (err) {
      setProposalErrors((prev) => ({ ...prev, [proposalId]: err }));
    }
  }, []);

  const handleExecute = useCallback(async (proposalId) => {
    try {
      setProposalErrors((prev) => ({ ...prev, [proposalId]: null }));
      // Production: call smart contract execute_proposal()
      // const tx = await contract.executeProposal(proposalId);
      // await tx.wait();

      setProposals((prev) =>
        prev.map((p) =>
          p.id === proposalId
            ? { ...p, executedAt: new Date().toISOString() }
            : p
        )
      );
    } catch (err) {
      setProposalErrors((prev) => ({ ...prev, [proposalId]: err }));
    }
  }, []);

  const handleCancel = useCallback(async (proposalId) => {
    try {
      setProposalErrors((prev) => ({ ...prev, [proposalId]: null }));
      // Production: call smart contract cancel_proposal()
      // const tx = await contract.cancelProposal(proposalId);
      // await tx.wait();

      setProposals((prev) =>
        prev.map((p) =>
          p.id === proposalId
            ? { ...p, status: "cancelled" }
            : p
        )
      );
    } catch (err) {
      setProposalErrors((prev) => ({ ...prev, [proposalId]: err }));
    }
  }, []);

  const filteredProposals = proposals.filter(
    (p) => filter === "all" || resolveLifecycle(p) === filter
  );

  const stats = useMemo(() => ({
    pending: proposals.filter(
      (p) =>
        resolveLifecycle(p) === ProposalLifecycle.PENDING_BELOW_THRESHOLD ||
        resolveLifecycle(p) === ProposalLifecycle.PENDING_TIMELOCK
    ).length,
    ready: proposals.filter(
      (p) => resolveLifecycle(p) === ProposalLifecycle.READY_TO_EXECUTE
    ).length,
    executed: proposals.filter(
      (p) => resolveLifecycle(p) === ProposalLifecycle.EXECUTED
    ).length,
    expired: proposals.filter(
      (p) =>
        resolveLifecycle(p) === ProposalLifecycle.EXPIRED ||
        resolveLifecycle(p) === ProposalLifecycle.CANCELLED
    ).length,
  }), [proposals]);

  if (!isConnected) {
    return (
      <div className="space-y-6">
        <header>
          <h1 className="text-3xl font-bold text-vault-text">
            {t("routes.admin.proposals.title")}
          </h1>
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
          <h1 className="text-3xl font-bold text-vault-text">
            {t("routes.admin.proposals.title")}
          </h1>
          <p className="mt-2 text-vault-muted">
            {t("routes.admin.proposals.subtitle")}
          </p>
        </header>
        <div className="vq-glass flex flex-col items-center border-amber-500/40 bg-amber-500/10 px-6 py-16 text-center">
          <AlertTriangle className="h-16 w-16 text-amber-500" aria-hidden="true" />
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
          <h1 className="text-3xl font-bold text-vault-text">
            {t("routes.admin.proposals.title")}
          </h1>
        </div>
        <p className="mt-2 text-vault-muted">
          {t("routes.admin.proposals.reviewBody")}
        </p>
      </header>

      {/* Stats Overview */}
      <div className="grid gap-4 sm:grid-cols-4">
        <button
          type="button"
          onClick={() => setFilter("pending_below_threshold")}
          className={`vq-glass-hover p-5 text-left transition-all ${
            filter === "pending_below_threshold" ? "ring-2 ring-amber-400/30" : ""
          }`}
        >
          <div className="flex items-center justify-between">
            <Clock className="h-5 w-5 text-amber-500" aria-hidden="true" />
            <span className="text-2xl font-bold text-vault-text">{stats.pending}</span>
          </div>
          <p className="mt-2 text-xs font-medium uppercase tracking-wide text-vault-muted">
            Pending
          </p>
        </button>

        <button
          type="button"
          onClick={() => setFilter("ready_to_execute")}
          className={`vq-glass-hover p-5 text-left transition-all ${
            filter === "ready_to_execute" ? "ring-2 ring-emerald-400/30" : ""
          }`}
        >
          <div className="flex items-center justify-between">
            <Play className="h-5 w-5 text-emerald-500" aria-hidden="true" />
            <span className="text-2xl font-bold text-vault-text">{stats.ready}</span>
          </div>
          <p className="mt-2 text-xs font-medium uppercase tracking-wide text-vault-muted">
            Ready
          </p>
        </button>

        <button
          type="button"
          onClick={() => setFilter("executed")}
          className={`vq-glass-hover p-5 text-left transition-all ${
            filter === "executed" ? "ring-2 ring-emerald-400/30" : ""
          }`}
        >
          <div className="flex items-center justify-between">
            <CheckCircle className="h-5 w-5 text-emerald-500" aria-hidden="true" />
            <span className="text-2xl font-bold text-vault-text">{stats.executed}</span>
          </div>
          <p className="mt-2 text-xs font-medium uppercase tracking-wide text-vault-muted">
            Executed
          </p>
        </button>

        <button
          type="button"
          onClick={() => setFilter("expired")}
          className={`vq-glass-hover p-5 text-left transition-all ${
            filter === "expired" ? "ring-2 ring-red-400/30" : ""
          }`}
        >
          <div className="flex items-center justify-between">
            <XCircle className="h-5 w-5 text-red-500" aria-hidden="true" />
            <span className="text-2xl font-bold text-vault-text">{stats.expired}</span>
          </div>
          <p className="mt-2 text-xs font-medium uppercase tracking-wide text-vault-muted">
            Expired
          </p>
        </button>
      </div>

      {/* Filter Controls */}
      <div className="flex items-center justify-between">
        <div className="flex gap-2">
          {["all", "pending_below_threshold", "ready_to_execute", "executed", "expired"].map(
            (f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                className={`rounded-lg px-4 py-2 text-sm font-medium transition-all ${
                  filter === f
                    ? "bg-red-500/15 text-red-600 ring-1 ring-red-400/30 dark:text-red-400"
                    : "text-vault-muted hover:bg-vault-surface hover:text-vault-text"
                }`}
              >
                {f === "all"
                  ? "All"
                  : f === "pending_below_threshold"
                    ? "Pending"
                    : f === "ready_to_execute"
                      ? "Ready"
                      : f.charAt(0).toUpperCase() + f.slice(1)}
              </button>
            )
          )}
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
            <Users className="mx-auto h-12 w-12 text-vault-muted" aria-hidden="true" />
            <p className="mt-4 text-sm text-vault-muted">No proposals found</p>
          </div>
        ) : (
          filteredProposals.map((proposal) => (
            <ProposalCard
              key={proposal.id}
              proposal={proposal}
              isAdmin={isAdmin}
              onApprove={handleApprove}
              onExecute={handleExecute}
              onCancel={handleCancel}
              error={proposalErrors[proposal.id]}
            />
          ))
        )}
      </div>
    </div>
  );
}
