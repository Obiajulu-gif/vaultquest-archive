"use client";

import { useState } from "react";
import {
  Shield,
  ShieldCheck,
  ShieldAlert,
  Database,
  Dices,
  Trophy,
  Banknote,
  FileText,
  ChevronDown,
  ChevronRight,
  Copy,
  Check,
  Loader2,
  AlertCircle,
} from "lucide-react";
import { verifyDrawProofClient, createFetchRpcClient } from "@/lib/draw-proof-verifier";

function truncateHash(hash, len = 12) {
  if (!hash || hash.length < len) return hash || "N/A";
  return `${hash.slice(0, 8)}...${hash.slice(-6)}`;
}

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button onClick={handleCopy} className="text-gray-500 hover:text-white transition-colors">
      {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

function FieldRow({ label, value, verified, copyable }) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-xs text-gray-400">{label}</span>
      <div className="flex items-center gap-1.5">
        <span className="text-xs font-mono text-gray-200 truncate max-w-[200px]" title={String(value)}>
          {value ?? "N/A"}
        </span>
        {copyable && value && <CopyButton text={String(value)} />}
        {verified !== undefined && (
          verified
            ? <ShieldCheck className="h-3 w-3 text-emerald-400" />
            : <ShieldAlert className="h-3 w-3 text-red-400" />
        )}
      </div>
    </div>
  );
}

function Section({ title, icon: Icon, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border border-gray-800 rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-2 bg-gray-900/50 hover:bg-gray-800/50 transition-colors text-left"
      >
        <Icon className="h-4 w-4 text-gray-400" />
        <span className="text-xs font-semibold text-gray-300 flex-1">{title}</span>
        {open ? <ChevronDown className="h-3.5 w-3.5 text-gray-500" /> : <ChevronRight className="h-3.5 w-3.5 text-gray-500" />}
      </button>
      {open && <div className="px-3 py-2 space-y-0.5 border-t border-gray-800">{children}</div>}
    </div>
  );
}

export default function DrawProofDetail({ proof, rpcUrl, onClose }) {
  const [verificationResult, setVerificationResult] = useState(null);
  const [verifying, setVerifying] = useState(false);
  const [verificationError, setVerificationError] = useState(null);

  if (!proof) return null;

  const p = proof.proof || proof;
  const snapshot = p.snapshot || {};
  const randomness = p.randomness || {};
  const winnerSelection = p.winnerSelection || {};
  const payout = p.payout || {};
  const metadata = p.metadata || {};

  const handleVerify = async () => {
    setVerifying(true);
    setVerificationError(null);
    try {
      const rpc = rpcUrl ? createFetchRpcClient(rpcUrl) : undefined;
      const result = await verifyDrawProofClient(p, rpc);
      setVerificationResult(result);
    } catch (err) {
      setVerificationError(err.message || "Verification failed");
    } finally {
      setVerifying(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="bg-gray-950 border border-gray-800 rounded-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto shadow-2xl">
        <div className="sticky top-0 bg-gray-950/95 backdrop-blur-sm border-b border-gray-800 px-4 py-3 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-white">Draw Proof</h2>
            <p className="text-[10px] text-gray-500 font-mono">{p.drawId || proof.draw_id}</p>
          </div>
          <div className="flex items-center gap-2">
            {p.signature && (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-400">
                <ShieldCheck className="h-3 w-3" />
                Signed
              </span>
            )}
            <button onClick={onClose} className="text-gray-400 hover:text-white text-xs">✕</button>
          </div>
        </div>

        <div className="p-4 space-y-3">
          <Section title="Snapshot" icon={Database} defaultOpen={true}>
            <FieldRow label="Ledger" value={snapshot.ledgerSeq} />
            <FieldRow label="Close Time" value={snapshot.ledgerCloseTime} />
            <FieldRow label="Participants" value={snapshot.participantCount} />
            <FieldRow label="Total Deposits" value={snapshot.totalDeposits} />
            <FieldRow label="Participants Hash" value={truncateHash(snapshot.participantsHash)} copyable />
            <FieldRow label="Pool Hash" value={truncateHash(snapshot.poolHash)} copyable />
          </Section>

          <Section title="Randomness" icon={Dices} defaultOpen={true}>
            <FieldRow label="Source" value={randomness.source} />
            <FieldRow label="Drawn at Ledger" value={randomness.drawnAtLedger} />
            <FieldRow label="Seed" value={truncateHash(randomness.seed)} copyable />
            <FieldRow label="Seed Hash" value={truncateHash(randomness.seedHash)} copyable />
          </Section>

          <Section title="Winner Selection" icon={Trophy} defaultOpen={true}>
            <FieldRow label="Method" value={winnerSelection.method} />
            <FieldRow label="Winner" value={winnerSelection.winnerAddress} copyable />
            <FieldRow label="Winner Weight" value={winnerSelection.winnerWeight} />
            <FieldRow label="Total Weight" value={winnerSelection.totalWeight} />
            <FieldRow label="Weights Hash" value={truncateHash(winnerSelection.ticketWeightsHash)} copyable />
            <FieldRow label="Proof Hash" value={truncateHash(winnerSelection.proofHash)} copyable />
          </Section>

          <Section title="Payout" icon={Banknote} defaultOpen={true}>
            <FieldRow label="Amount" value={payout.amount} />
            <FieldRow label="Asset" value={payout.asset} />
            <FieldRow label="Tx Hash" value={truncateHash(payout.txHash)} copyable />
            <FieldRow label="Ledger" value={payout.ledgerSeq} />
            <FieldRow label="Confirmed" value={payout.recipientConfirmed ? "Yes" : "No"} />
          </Section>

          <Section title="Metadata" icon={FileText}>
            <FieldRow label="Created" value={metadata.createdAt} />
            <FieldRow label="Engine Version" value={metadata.engineVersion} />
            <FieldRow label="Spec Hash" value={truncateHash(metadata.contractSpecHash)} />
          </Section>

          <div className="pt-2 border-t border-gray-800">
            <button
              onClick={handleVerify}
              disabled={verifying}
              className="w-full flex items-center justify-center gap-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 px-4 py-2 text-xs font-semibold text-white transition-colors"
            >
              {verifying ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Verifying...
                </>
              ) : (
                <>
                  <Shield className="h-3.5 w-3.5" />
                  Verify Independently
                </>
              )}
            </button>

            {verificationError && (
              <div className="mt-2 rounded-lg bg-red-950/30 border border-red-900/30 p-2 text-xs text-red-400 flex items-start gap-2">
                <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                {verificationError}
              </div>
            )}

            {verificationResult && (
              <div className="mt-2 space-y-1">
                <div className="flex items-center gap-2 mb-2">
                  {verificationResult.verified ? (
                    <span className="text-xs font-semibold text-emerald-400 flex items-center gap-1">
                      <ShieldCheck className="h-3.5 w-3.5" />
                      All checks passed
                    </span>
                  ) : (
                    <span className="text-xs font-semibold text-red-400 flex items-center gap-1">
                      <ShieldAlert className="h-3.5 w-3.5" />
                      Verification failed
                    </span>
                  )}
                </div>
                {verificationResult.fields.map((field, i) => (
                  <div key={i} className="flex items-center justify-between py-1">
                    <span className="text-[11px] text-gray-400">{field.name}</span>
                    <div className="flex items-center gap-1.5">
                      {field.status === "pass" && <ShieldCheck className="h-3 w-3 text-emerald-400" />}
                      {field.status === "fail" && <ShieldAlert className="h-3 w-3 text-red-400" />}
                      {field.status === "unverified" && <AlertCircle className="h-3 w-3 text-gray-500" />}
                      <span className={`text-[10px] font-mono ${
                        field.status === "pass" ? "text-emerald-400" :
                        field.status === "fail" ? "text-red-400" : "text-gray-500"
                      }`}>
                        {field.status}
                      </span>
                    </div>
                    {field.detail && (
                      <span className="text-[9px] text-gray-600 ml-2 truncate max-w-[150px]" title={field.detail}>
                        {field.detail}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
