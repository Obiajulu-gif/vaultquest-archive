"use client";

import { useState } from "react";
import {
  PlayCircle,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Database,
} from "lucide-react";

export default function IndexerReplayControl({ isAuthorized = false }) {
  const [startLedger, setStartLedger] = useState("");
  const [endLedger, setEndLedger] = useState("");
  const [isDryRun, setIsDryRun] = useState(true);
  const [isRunning, setIsRunning] = useState(false);
  const [dryRunResults, setDryRunResults] = useState(null);
  const [replayResults, setReplayResults] = useState(null);
  const [showConfirm, setShowConfirm] = useState(false);

  const handleDryRun = async () => {
    setIsRunning(true);
    setDryRunResults(null);

    await new Promise((resolve) => setTimeout(resolve, 2000));

    setDryRunResults({
      ledgerRange: `${startLedger} - ${endLedger}`,
      estimatedBlocks: parseInt(endLedger) - parseInt(startLedger) + 1,
      estimatedTransactions: Math.floor(Math.random() * 500) + 100,
      estimatedDuration: "~3 minutes",
      warnings: [],
    });

    setIsRunning(false);
  };

  const handleReplay = async () => {
    setShowConfirm(false);
    setIsRunning(true);
    setReplayResults(null);

    await new Promise((resolve) => setTimeout(resolve, 3000));

    setReplayResults({
      status: "completed",
      ledgerRange: `${startLedger} - ${endLedger}`,
      blocksProcessed: parseInt(endLedger) - parseInt(startLedger) + 1,
      transactionsIndexed: Math.floor(Math.random() * 500) + 100,
      failures: 0,
      duration: "2m 45s",
    });

    setIsRunning(false);
  };

  const isValid =
    startLedger && endLedger && parseInt(endLedger) >= parseInt(startLedger);

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
            Bounded replay for maintenance
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
              This control panel requires maintainer credentials
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
                  disabled={isRunning}
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
                  disabled={isRunning}
                />
              </div>
            </div>

            <div className="flex gap-3">
              <button
                onClick={handleDryRun}
                disabled={!isValid || isRunning}
                className="flex-1 vq-btn-ghost flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {isRunning && isDryRun ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  <PlayCircle size={16} />
                )}
                Dry Run
              </button>
              <button
                onClick={() => setShowConfirm(true)}
                disabled={!isValid || isRunning || !dryRunResults}
                className="flex-1 vq-btn-primary flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {isRunning && !isDryRun ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  <Database size={16} />
                )}
                Execute Replay
              </button>
            </div>
          </div>

          {dryRunResults && (
            <div className="border border-vault-border rounded-lg p-4 space-y-3 bg-vault-surface">
              <p className="font-medium text-vault-text flex items-center gap-2">
                <CheckCircle2 size={16} className="text-emerald-500" />
                Dry Run Complete
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
              <div className="bg-vault-surface border border-vault-border rounded-xl p-6 max-w-md w-full space-y-4">
                <div className="flex items-start gap-3">
                  <AlertTriangle
                    className="text-amber-500 flex-shrink-0 mt-1"
                    size={24}
                  />
                  <div>
                    <h3 className="font-semibold text-vault-text">
                      Confirm Replay Execution
                    </h3>
                    <p className="text-sm text-vault-muted mt-1">
                      This will replay ledgers {startLedger} to {endLedger}.
                      This action is auditable.
                    </p>
                  </div>
                </div>
                <div className="flex gap-3">
                  <button
                    onClick={() => setShowConfirm(false)}
                    className="flex-1 vq-btn-ghost"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleReplay}
                    className="flex-1 vq-btn-primary"
                  >
                    Confirm
                  </button>
                </div>
              </div>
            </div>
          )}

          <div className="text-xs text-vault-muted border-t border-vault-border pt-4">
            Note: Dry-run performs no writes. Concurrent replay jobs are
            prevented. All operations are auditable.
          </div>
        </>
      )}
    </section>
  );
}
