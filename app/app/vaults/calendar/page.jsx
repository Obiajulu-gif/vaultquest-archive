"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { useTranslation } from "next-i18next";
import PoolCalendar from "@/components/app/PoolCalendar";
import { MOCK_VAULTS } from "@/lib/vault-mock-data";

export default function PoolCalendarPage() {
  const { t } = useTranslation("common");

  // Add mock dates to pools for demonstration
  const poolsWithDates = MOCK_VAULTS.map((pool, idx) => {
    const now = new Date();
    return {
      ...pool,
      opensAt: new Date(now.getTime() + idx * 24 * 60 * 60 * 1000),
      locksAt: new Date(now.getTime() + (idx + 7) * 24 * 60 * 60 * 1000),
      drawsAt: new Date(now.getTime() + (idx + 14) * 24 * 60 * 60 * 1000),
      claimDeadline: pool.status === "settled" 
        ? new Date(now.getTime() + (idx + 21) * 24 * 60 * 60 * 1000)
        : null,
    };
  });

  return (
    <div className="space-y-6">
      <header>
        <div className="flex items-center gap-4 mb-3">
          <Link
            href="/app/vaults"
            className="p-2 rounded-lg hover:bg-vault-surface transition-colors text-vault-muted hover:text-vault-text"
            aria-label="Back to vaults"
          >
            <ArrowLeft size={20} />
          </Link>
          <div>
            <h1 className="text-3xl font-bold text-vault-text">Pool Calendar</h1>
            <p className="mt-2 text-vault-muted">
              View upcoming pool openings, maturity dates, and claim deadlines
            </p>
          </div>
        </div>
      </header>

      <div className="vq-glass p-4 bg-blue-500/10 border-blue-500/20">
        <p className="text-sm text-blue-400">
          <strong>Timezone:</strong> All times are shown in your local timezone ({Intl.DateTimeFormat().resolvedOptions().timeZone})
        </p>
      </div>

      <PoolCalendar pools={poolsWithDates} />

      <Link href="/app/vaults" className="vq-btn-ghost inline-flex">
        ← Back to vaults
      </Link>
    </div>
  );
}
