"use client";

import { useState } from "react";
import { Shield, ShieldCheck, ShieldAlert, Loader2, AlertCircle, RefreshCw } from "lucide-react";
import { verifyDrawProofClient, createFetchRpcClient } from "@/lib/draw-proof-verifier";

const FIELD_STATUS_LABEL = {
  pass: "PASS",
  fail: "FAILED",
  unverified: "UNVERIFIED",
};

const FIELD_STATUS_STYLES = {
  pass: {
    row: "bg-emerald-500/[0.03]",
    text: "text-emerald-400",
    chip: "bg-emerald-500/10 border-emerald-500/20 text-emerald-400",
  },
  fail: {
    row: "bg-red-500/[0.06]",
    text: "text-red-400",
    chip: "bg-red-500/15 border-red-500/30 text-red-400",
  },
  unverified: {
    row: "",
    text: "text-gray-500",
    chip: "bg-gray-500/10 border-gray-500/20 text-gray-400",
  },
};

function VerificationFieldRow({ field }) {
  const styles = FIELD_STATUS_STYLES[field.status] ?? FIELD_STATUS_STYLES.unverified;
  const StatusIcon = {
    pass: ShieldCheck,
    fail: ShieldAlert,
    unverified: AlertCircle,
  }[field.status] ?? AlertCircle;

  return (
    <div className={`flex items-start justify-between gap-3 py-1.5 px-2 rounded border-b border-gray-800/50 last:border-0 ${styles.row}`}>
      <span className="text-xs text-gray-400 font-medium">{field.name}</span>
      <div className="flex items-center gap-2 min-w-0">
        {field.detail && (
          <span
            className={`text-[10px] truncate max-w-[220px] ${
              field.status === "fail" ? "text-red-400/90" : "text-gray-600"
            }`}
            title={field.detail}
          >
            {field.detail}
          </span>
        )}
        <StatusIcon className={`h-3.5 w-3.5 shrink-0 ${styles.text}`} />
        <span
          className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[9px] font-mono font-semibold ${styles.chip}`}
        >
          {FIELD_STATUS_LABEL[field.status] ?? field.status}
        </span>
      </div>
    </div>
  );
}

export default function DrawProofVerifier({ proof, rpcUrl }) {
  const [result, setResult] = useState(null);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState(null);

  const handleVerify = async () => {
    if (!proof) return;
    setVerifying(true);
    setError(null);
    setResult(null);
    try {
      const p = proof.proof || proof;
      const rpc = rpcUrl ? createFetchRpcClient(rpcUrl) : undefined;
      const verification = await verifyDrawProofClient(p, rpc);
      setResult(verification);
    } catch (err) {
      setError(err.message || "Verification failed");
    } finally {
      setVerifying(false);
    }
  };

  const proofData = proof?.proof || proof;
  const drawId = proofData?.drawId || proof?.draw_id || "Unknown";

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Shield className="h-4 w-4 text-gray-400" />
          <span className="text-xs font-semibold text-gray-300">Independent Verifier</span>
        </div>
        <span className="text-[10px] text-gray-600 font-mono" title={drawId}>
          {drawId.length > 20 ? `${drawId.slice(0, 16)}...` : drawId}
        </span>
      </div>

      <button
        onClick={handleVerify}
        disabled={verifying || !proof}
        className="w-full flex items-center justify-center gap-2 rounded-lg border border-blue-600/30 bg-blue-600/10 hover:bg-blue-600/20 disabled:bg-gray-800 disabled:border-gray-700 px-4 py-2 text-xs font-semibold text-blue-400 disabled:text-gray-500 transition-colors"
      >
        {verifying ? (
          <>
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Verifying against Stellar RPC...
          </>
        ) : result ? (
          <>
            <RefreshCw className="h-3.5 w-3.5" />
            Re-verify
          </>
        ) : (
          <>
            <Shield className="h-3.5 w-3.5" />
            Verify Proof
          </>
        )}
      </button>

      {error && (
        <div className="rounded-lg bg-red-950/30 border border-red-900/30 p-2 text-xs text-red-400 flex items-start gap-2">
          <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          {error}
        </div>
      )}

      {result && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            {result.verified ? (
              <span className="text-xs font-semibold text-emerald-400 flex items-center gap-1">
                <ShieldCheck className="h-3.5 w-3.5" />
                Proof verified successfully
              </span>
            ) : (
              <span className="text-xs font-semibold text-red-400 flex items-center gap-1">
                <ShieldAlert className="h-3.5 w-3.5" />
                Proof verification failed
              </span>
            )}
            {result.rpcVerified && (
              <span className="text-[9px] text-gray-500 bg-gray-800 rounded px-1.5 py-0.5">
                RPC verified
              </span>
            )}
          </div>

          <div className="space-y-0">
            {result.fields.map((field, i) => (
              <VerificationFieldRow key={i} field={field} />
            ))}
          </div>

          <p className="text-[9px] text-gray-600">
            Verified at {new Date(result.verifiedAt).toLocaleString()}
          </p>
        </div>
      )}
    </div>
  );
}
