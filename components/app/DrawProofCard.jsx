"use client";

import React from "react";
import { Shield, ShieldCheck, ShieldAlert, ExternalLink } from "lucide-react";

function truncateAddress(addr) {
  if (!addr || addr.length < 12) return addr || "N/A";
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function truncateHash(hash) {
  if (!hash || hash.length < 16) return hash || "N/A";
  return `${hash.slice(0, 10)}...${hash.slice(-6)}`;
}

function formatAmount(amount, asset = "USDC") {
  const num = Number(amount) / 1_000_000;
  return `${num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${asset}`;
}

function VerificationBadge({ verified, verificationError }) {
  if (verified) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-400 border border-emerald-500/20">
        <ShieldCheck className="h-3 w-3" />
        Verified
      </span>
    );
  }
  if (verificationError) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-red-500/10 px-2 py-0.5 text-[10px] font-semibold text-red-400 border border-red-500/20">
        <ShieldAlert className="h-3 w-3" />
        Failed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-gray-500/10 px-2 py-0.5 text-[10px] font-semibold text-gray-400 border border-gray-500/20">
      <Shield className="h-3 w-3" />
      Unverified
    </span>
  );
}

export default function DrawProofCard({ proof, onViewProof, explorerUrl = "https://stellar.expert/explorer/public/tx/" }) {
  if (!proof) return null;

  const proofData = proof.proof || proof;
  const winner = proofData.winnerSelection?.winnerAddress || "Unknown";
  const amount = proofData.payout?.amount || "0";
  const asset = proofData.payout?.asset || "USDC";
  const roundId = proofData.roundId ?? proof.round_id ?? "?";
  const drawId = proofData.drawId || proof.draw_id || "";
  const txHash = proofData.payout?.txHash || "";
  const proofHash = proofData.signature || proof.proof_hash || "";

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-4 space-y-3 hover:border-gray-700 transition-colors">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono text-gray-500">Round #{roundId}</span>
          <span className="text-gray-700">·</span>
          <span className="text-xs font-mono text-gray-500 truncate max-w-[120px]" title={drawId}>
            {truncateHash(drawId)}
          </span>
        </div>
        <VerificationBadge
          verified={proof.verified}
          verificationError={proof.verification_error}
        />
      </div>

      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs text-gray-400">Winner</p>
          <p className="text-sm font-mono text-white" title={winner}>
            {truncateAddress(winner)}
          </p>
        </div>
        <div className="text-right">
          <p className="text-xs text-gray-400">Prize</p>
          <p className="text-sm font-semibold text-amber-400">
            {formatAmount(amount, asset)}
          </p>
        </div>
      </div>

      <div className="flex items-center justify-between pt-1 border-t border-gray-800">
        <div className="flex items-center gap-2">
          {txHash && (
            <a
              href={`${explorerUrl}${txHash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[10px] text-blue-400 hover:text-blue-300 transition-colors"
            >
              Tx <ExternalLink className="h-2.5 w-2.5" />
            </a>
          )}
          {proofHash && (
            <span className="text-[10px] text-gray-600 font-mono" title={proofHash}>
              sig: {truncateHash(proofHash)}
            </span>
          )}
        </div>
        {onViewProof && (
          <button
            onClick={() => onViewProof(proof)}
            className="text-[10px] font-semibold text-gray-400 hover:text-white transition-colors"
          >
            View Proof →
          </button>
        )}
      </div>
    </div>
  );
}
