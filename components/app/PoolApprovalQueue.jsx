"use client";

import { useState } from "react";
import { CheckCircle, XCircle, Clock, Shield, FileText } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

const MOCK_PENDING_POOLS = [
  {
    id: "pool-001",
    name: "USDC High Yield",
    asset: "USDC",
    network: "Stellar",
    apy: 6.8,
    lockup: 14,
    tvl: 0,
    status: "pending",
    submittedAt: "2026-07-27T10:30:00Z",
    submitter: "0x1234...5678",
    validationResults: {
      contractValid: true,
      ownershipVerified: true,
      securityChecked: false,
    },
  },
  {
    id: "pool-002",
    name: "XLM Flexible Savings",
    asset: "XLM",
    network: "Stellar",
    apy: 4.2,
    lockup: 0,
    tvl: 0,
    status: "pending",
    submittedAt: "2026-07-26T15:20:00Z",
    submitter: "0xabcd...efgh",
    validationResults: {
      contractValid: true,
      ownershipVerified: true,
      securityChecked: true,
    },
  },
];

export default function PoolApprovalQueue({ isAdmin = false }) {
  const [pools, setPools] = useState(MOCK_PENDING_POOLS);
  const [selectedPool, setSelectedPool] = useState(null);
  const [reviewNote, setReviewNote] = useState("");

  const handleApprove = (poolId) => {
    setPools((prev) =>
      prev.map((pool) =>
        pool.id === poolId
          ? {
              ...pool,
              status: "approved",
              reviewedAt: new Date().toISOString(),
              reviewNote,
              reviewer: "admin@vaultquest.io",
            }
          : pool,
      ),
    );
    setSelectedPool(null);
    setReviewNote("");
  };

  const handleReject = (poolId) => {
    setPools((prev) =>
      prev.map((pool) =>
        pool.id === poolId
          ? {
              ...pool,
              status: "rejected",
              reviewedAt: new Date().toISOString(),
              reviewNote,
              reviewer: "admin@vaultquest.io",
            }
          : pool,
      ),
    );
    setSelectedPool(null);
    setReviewNote("");
  };

  const pendingPools = pools.filter((p) => p.status === "pending");

  return (
    <section className="vq-glass p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-500/10 text-amber-500 border border-amber-500/20">
            <Shield size={20} />
          </div>
          <div>
            <h2 className="text-xl font-bold text-vault-text">
              Pool Approval Queue
            </h2>
            <p className="text-sm text-vault-muted">
              Review pending pool configurations
            </p>
          </div>
        </div>
        <span className="text-sm font-medium text-vault-text">
          {pendingPools.length} pending
        </span>
      </div>

      {pendingPools.length === 0 ? (
        <div className="border border-vault-border rounded-lg p-12 text-center">
          <CheckCircle className="h-12 w-12 mx-auto text-emerald-500" />
          <p className="mt-4 text-sm text-vault-muted">
            No pools pending review
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {pendingPools.map((pool) => (
            <div
              key={pool.id}
              className="border border-vault-border rounded-lg bg-vault-surface overflow-hidden"
            >
              <div className="p-4">
                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="font-semibold text-vault-text">
                      {pool.name}
                    </h3>
                    <p className="text-sm text-vault-muted">
                      {pool.network} • {pool.asset}
                    </p>
                  </div>
                  <span className="text-lg font-bold text-emerald-500">
                    {pool.apy}%
                  </span>
                </div>

                <div className="mt-4 grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <p className="text-vault-muted">Lockup</p>
                    <p className="font-medium text-vault-text">
                      {pool.lockup === 0 ? "Flexible" : `${pool.lockup} Days`}
                    </p>
                  </div>
                  <div>
                    <p className="text-vault-muted">Submitted</p>
                    <p className="font-medium text-vault-text">
                      {new Date(pool.submittedAt).toLocaleDateString()}
                    </p>
                  </div>
                </div>

                <div className="mt-4 space-y-2">
                  <p className="text-xs font-medium text-vault-muted uppercase">
                    Validation Results
                  </p>
                  <div className="space-y-1">
                    {Object.entries(pool.validationResults).map(
                      ([key, value]) => (
                        <div
                          key={key}
                          className="flex items-center gap-2 text-sm"
                        >
                          {value ? (
                            <CheckCircle
                              size={14}
                              className="text-emerald-500"
                            />
                          ) : (
                            <XCircle size={14} className="text-red-500" />
                          )}
                          <span className="text-vault-text capitalize">
                            {key.replace(/([A-Z])/g, " $1").trim()}
                          </span>
                        </div>
                      ),
                    )}
                  </div>
                </div>

                {isAdmin && (
                  <div className="mt-4 pt-4 border-t border-vault-border">
                    <textarea
                      placeholder="Add review notes (optional)..."
                      value={selectedPool === pool.id ? reviewNote : ""}
                      onChange={(e) => {
                        setSelectedPool(pool.id);
                        setReviewNote(e.target.value);
                      }}
                      className="w-full px-3 py-2 text-sm bg-vault-surface border border-vault-border rounded-lg text-vault-text resize-none focus:outline-none focus:ring-2 focus:ring-vault-accent"
                      rows={2}
                    />
                    <div className="flex gap-3 mt-3">
                      <button
                        onClick={() => handleApprove(pool.id)}
                        className="flex-1 vq-btn-primary flex items-center justify-center gap-2"
                      >
                        <CheckCircle size={16} />
                        Approve
                      </button>
                      <button
                        onClick={() => handleReject(pool.id)}
                        className="flex-1 vq-btn-ghost border-red-500/40 text-red-600 dark:text-red-400 hover:bg-red-500/10 flex items-center justify-center gap-2"
                      >
                        <XCircle size={16} />
                        Reject
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="text-xs text-vault-muted border-t border-vault-border pt-4">
        Note: Pool approval does not change contract ownership or balances.
        Approved pools become publicly discoverable.
      </div>
    </section>
  );
}
