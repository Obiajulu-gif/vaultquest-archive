"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useAccount } from "wagmi";
import { useTranslation } from "next-i18next";
import PublicStatsBar from "@/components/app/PublicStatsBar";
import RecentWinners from "@/components/app/RecentWinners";
import TicketDistributionGrid from "@/components/app/TicketDistributionGrid";
import RoundCountdown from "@/components/app/RoundCountdown";
import TicketSimulator from "@/components/app/TicketSimulator";
import DrawProofCard from "@/components/app/DrawProofCard";
import DrawProofDetail from "@/components/app/DrawProofDetail";

const API_BASE = process.env.NEXT_PUBLIC_VAULTQUEST_API_BASE_URL || "/api";

const generateMockTickets = (count) => {
  return Array.from({ length: count }, (_, i) => ({
    ticketNumber: 10000 + i,
    ownerAddress: i % 10 === 0
      ? "0xYourAddress1234567890abcdef1234567890"
      : `0x${Math.random().toString(16).substr(2, 40)}`,
    winProbability: Math.random() * 0.001,
  }));
};

const getCurrentRoundDates = () => {
  const now = new Date();
  const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const endOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59));
  return { startDate: startOfMonth, endDate: endOfMonth };
};

export default function PrizesPage() {
  const { t } = useTranslation("common");
  const { address } = useAccount();
  const mockTickets = generateMockTickets(1500);
  const { startDate, endDate } = getCurrentRoundDates();

  const [proofs, setProofs] = useState([]);
  const [proofsLoading, setProofsLoading] = useState(true);
  const [selectedProof, setSelectedProof] = useState(null);

  useEffect(() => {
    fetch(`${API_BASE}/draw-proofs?limit=10`)
      .then((res) => res.json())
      .then((data) => {
        setProofs(data.data || []);
      })
      .catch(() => {
        setProofs([]);
      })
      .finally(() => {
        setProofsLoading(false);
      });
  }, []);

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold text-vault-text">{t("routes.prizes.title")}</h1>
      <RoundCountdown
        startDate={startDate}
        endDate={endDate}
        label={t("routes.prizes.currentRound")}
      />
      <TicketSimulator />
      <PublicStatsBar />

      {proofs.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold text-white">Verified Draws</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {proofs.map((proof) => (
              <DrawProofCard
                key={proof.draw_id || proof.id}
                proof={proof}
                onViewProof={setSelectedProof}
              />
            ))}
          </div>
        </div>
      )}

      {proofsLoading && (
        <div className="text-center py-4">
          <p className="text-xs text-gray-500">Loading draw proofs...</p>
        </div>
      )}

      {!proofsLoading && proofs.length === 0 && (
        <div className="text-center py-4 rounded-xl border border-gray-800 bg-gray-900/30">
          <p className="text-xs text-gray-500">
            No verified draws yet. Proofs are generated automatically after each draw is confirmed on-chain.
          </p>
        </div>
      )}

      <RecentWinners />

      <TicketDistributionGrid
        tickets={mockTickets}
        userAddress={address}
        onTicketClick={(ticket) => console.log("Clicked ticket:", ticket)}
      />

      <p className="text-vault-muted">Browse active prize rounds and past winners.</p>
      <Link href="/app" className="vq-btn-ghost inline-flex">
        ← {t("routes.prizes.backToDashboard")}
      </Link>

      {selectedProof && (
        <DrawProofDetail
          proof={selectedProof}
          onClose={() => setSelectedProof(null)}
        />
      )}
    </div>
  );
}
