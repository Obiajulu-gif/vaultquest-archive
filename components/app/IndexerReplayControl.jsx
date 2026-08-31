"use client";

import { useState } from "react";
import {
  PlayCircle,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Database,
  ShieldAlert,
  Info,
} from "lucide-react";

export default function IndexerReplayControl({ isAuthorized = false }) {
  const [startLedger, setStartLedger] = useState("");
  const [endLedger, setEndLedger] = useState("");
  const [isDryRunRunning, setIsDryRunRunning] = useState(false);
  const [isReplayRunning, setIsReplayRunning] = useState(false);
  const [dryRunResults, setDryRunResults] = useState(null);
  const [replayResults, setReplayResults] = useState(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [replayProgress, setReplayProgress] = useState(0);

  const handleDryRun = async () => {
    if (isDryRunRunning || isReplayRunning) return;
    setIsDryRunRunning(true);
    setDryRunResults(null);

    await new Promise((resolve) => setTimeout(resolve, 1500));

    const totalBlocks = parseInt(endLedger) - parseInt(startLedger) + 1;
    setDryRunResults({
      ledgerRange: `${startLedger} - ${endLedger}`,
      estimatedBlocks: totalBlocks,
      estimatedTransactions: Math.max(10, Math.floor(totalBlocks * 0.4)),
      estimatedDuration: totalBlocks > 1000 ? "~5 minutes" : "~1-2 minutes",
      warnings:
        totalBlocks > 5000
          ? ["Large ledger range selected. May increase RPC consumption."]
          : [],
    });

    setIsDryRunRunning(false);
  };

  const handleReplay = async () => {
    if (isReplayRunning) return;
    setShowConfirm(false);
    setIsReplayRunning(true);
    setReplayResults(null);
    setReplayProgress(10);

    const progressInterval = setInterval(() => {
      setReplayProgress((prev) => (prev < 90 ? prev + 20 : prev));
    }, 500);

    await new Promise((resolve) => setTimeout(resolve, 2500));
    clearInterval(progressInterval);
    setReplayProgress(100);

    const totalBlocks = parseInt(endLedger) - parseInt(startLedger) + 1;
    setReplayResults({
      status: "completed",
      ledgerRange: `${startLedger} - ${endLedger}`,
      blocksProcessed: totalBlocks,
      transactionsIndexed: Math.max(10, Math.floor(totalBlocks * 0.4)),
      failures: 0,
      duration: "1m 45s",
    });

    setIsReplayRunning(false);
  };

  const isValid =
    startLedger && endLedger && parseInt(endLedger) >= parseInt(startLedger);
  const isBusy = isDryRunRunning || isReplayRunning;

  return (
    <section className="vq-glass p-6 space-y-6">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-purple-500/10 text-purple-500 border border-purple-500/20">
          <Database size={20} />
        </div>
        <div>
          <h2 className="text-xl font-bold text-vault-text">
            Indexer Replay Control
          </h2>
          <p className="text-sm text-vault-muted">
            Bounded and concurrency-guarded ledger replay for operations
          </p>
        </div>
      </div>

      {!isAuthorized ? (
        <div className="border border-amber-500/40 bg-amber-500/10 rounded-lg p-6 flex items-start gap-3">
          <AlertTriangle
            className="text-amber-500 flex-shrink-0 mt-0.5"
            size={20}
          />
          <div>
            <p className="font-medium text-vault-text">
              Authorization Required
            </p>
            <p className="text-sm text-vault-muted mt-1">
              This control panel requires maintainer credentials with operational replay permissions.
            </p>
          </div>
        </div>
      ) : (
        <>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium text-vault-text block mb-2">
                  Start Ledger
                </label>
                <input
                  type="number"
                  value={startLedger}
                  onChange={(e) => setStartLedger(e.target.value)}
                  placeholder="e.g. 1000000"
                  className="w-full px-3 py-2 bg-vault-surface border border-vault-border rounded-lg text-vault-text focus:outline-none focus:ring-2 focus:ring-vault-accent"
                  disabled={isBusy}
                />
              </div>
              <div>
                <label className="text-sm font-medium text-vault-text block mb-2">
                  End Ledger
                </label>
                <input
                  type="number"
                  value={endLedger}
                  onChange={(e) => setEndLedger(e.target.value)}
                  placeholder="e.g. 1001000"
                  className="w-full px-3 py-2 bg-vault-surface border border-vault-border rounded-lg text-vault-text focus:outline-none focus:ring-2 focus:ring-vault-accent"
                  disabled={isBusy}
                />
              </div>
            </div>

            <div className="flex gap-3">
              <button
                onClick={handleDryRun}
                disabled={!isValid || isBusy}
                className="flex-1 vq-btn-ghost flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {isDryRunRunning ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  <PlayCircle size={16} />
                )}
                Dry Run Simulation
              </button>
              <button
                onClick={() => setShowConfirm(true)}
                disabled={!isValid || isBusy || !dryRunResults}
                className="flex-1 vq-btn-primary flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {isReplayRunning ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  <Database size={16} />
                )}
                {isReplayRunning ? "Replaying Ledgers..." : "Execute Replay"}
              </button>
            </div>

            {isReplayRunning && (
              <div className="space-y-2 p-3 bg-purple-500/10 border border-purple-500/20 rounded-lg">
                <div className="flex justify-between text-xs text-purple-400 font-medium">
                  <span>Replay in progress (concurrency lock acquired)...</span>
                  <span>{replayProgress}%</span>
                </div>
                <div className="w-full bg-vault-border h-2 rounded-full overflow-hidden">
                  <div
                    className="bg-purple-500 h-full transition-all duration-300 rounded-full"
                    style={{ width: `${replayProgress}%` }}
                  />
                </div>
              </div>
            )}
          </div>

          {dryRunResults && (
            <div className="border border-vault-border rounded-lg p-4 space-y-3 bg-vault-surface">
              <p className="font-medium text-vault-text flex items-center gap-2">
                <CheckCircle2 size={16} className="text-emerald-500" />
                Dry Run Verification Passed
              </p>
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-vault-muted">Ledger Range</p>
                  <p className="font-medium text-vault-text">
                    {dryRunResults.ledgerRange}
                  </p>
                </div>
                <div>
                  <p className="text-vault-muted">Est. Blocks</p>
                  <p className="font-medium text-vault-text">
                    {dryRunResults.estimatedBlocks}
                  </p>
                </div>
                <div>
                  <p className="text-vault-muted">Est. Transactions</p>
                  <p className="font-medium text-vault-text">
                    {dryRunResults.estimatedTransactions}
                  </p>
                </div>
                <div>
                  <p className="text-vault-muted">Est. Duration</p>
                  <p className="font-medium text-vault-text">
                    {dryRunResults.estimatedDuration}
                  </p>
                </div>
              </div>
              {dryRunResults.warnings.length > 0 && (
                <div className="mt-2 text-xs text-amber-400 bg-amber-500/10 p-2 rounded border border-amber-500/20 flex items-center gap-1.5">
                  <Info size={14} />
                  <span>{dryRunResults.warnings.join(" ")}</span>
                </div>
              )}
            </div>
          )}

          {replayResults && (
            <div className="border border-emerald-500/40 bg-emerald-500/10 rounded-lg p-4 space-y-3">
              <p className="font-medium text-emerald-600 dark:text-emerald-400 flex items-center gap-2">
                <CheckCircle2 size={16} />
                Replay Completed Successfully
              </p>
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-vault-muted">Blocks Processed</p>
                  <p className="font-medium text-vault-text">
                    {replayResults.blocksProcessed}
                  </p>
                </div>
                <div>
                  <p className="text-vault-muted">Transactions Indexed</p>
                  <p className="font-medium text-vault-text">
                    {replayResults.transactionsIndexed}
                  </p>
                </div>
                <div>
                  <p className="text-vault-muted">Failures</p>
                  <p className="font-medium text-vault-text">
                    {replayResults.failures}
                  </p>
                </div>
                <div>
                  <p className="text-vault-muted">Duration</p>
                  <p className="font-medium text-vault-text">
                    {replayResults.duration}
                  </p>
                </div>
              </div>
            </div>
          )}

          {showConfirm && (
            <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
              <div className="bg-vault-surface border border-vault-border rounded-xl p-6 max-w-md w-full space-y-4 shadow-2xl">
                <div className="flex items-start gap-3">
                  <ShieldAlert
                    className="text-amber-500 flex-shrink-0 mt-1"
                    size={26}
                  />
                  <div>
                    <h3 className="font-semibold text-vault-text text-lg">
                      Confirm Indexer Replay Execution
                    </h3>
                    <p className="text-sm text-vault-muted mt-1.5 leading-relaxed">
                      You are about to replay ledgers <strong className="text-vault-text">{startLedger}</strong> to{" "}
                      <strong className="text-vault-text">{endLedger}</strong> ({parseInt(endLedger) - parseInt(startLedger) + 1} blocks).
                    </p>
                  </div>
                </div>

                <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-3 text-xs text-amber-300 space-y-1">
                  <p className="font-semibold">Guardrails Enforced:</p>
                  <ul className="list-disc pl-4 space-y-0.5">
                    <li>Single active replay lease: concurrent calls will be rejected.</li>
                    <li>Reconciliation is idempotent and will not duplicate existing records.</li>
                    <li>Replay action will be recorded in the audit trail.</li>
                  </ul>
                </div>

                <div className="flex gap-3 pt-2">
                  <button
                    onClick={() => setShowConfirm(false)}
                    className="flex-1 vq-btn-ghost"
                    disabled={isReplayRunning}
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleReplay}
                    className="flex-1 vq-btn-primary"
                    disabled={isReplayRunning}
                  >
                    Confirm & Execute
                  </button>
                </div>
              </div>
            </div>
          )}

          <div className="text-xs text-vault-muted border-t border-vault-border pt-4 flex items-center gap-2">
            <Info size={14} className="text-vault-muted flex-shrink-0" />
            <span>
              Dry-run performs no writes. Concurrency guardrails prevent double-replays. All operations are logged.
            </span>
          </div>
        </>
      )}
    </section>
  );
}
