"use client";

import { Award, Info, Minus, TrendingUp, UserPlus } from "lucide-react";

const SAMPLE_RANKINGS = [
  {
    rank: 1,
    name: "0xA17...92C",
    vault: "USDC Stable Pool",
    engagement: "14 deposits",
    score: "9,840 pts",
    state: "rising",
  },
  {
    rank: 2,
    name: "0x91B...E10",
    vault: "ETH Growth Pool",
    engagement: "8 week streak",
    score: "8,120 pts",
    state: "holding",
  },
  {
    rank: 3,
    name: "New saver",
    vault: "XLM Drip Vault",
    engagement: "First deposit",
    score: "Pending",
    state: "new",
  },
];

const STATE_STYLES = {
  rising: {
    label: "Rising",
    icon: TrendingUp,
    className: "text-emerald-600 dark:text-emerald-400",
  },
  holding: {
    label: "Holding",
    icon: Minus,
    className: "text-vault-muted",
  },
  new: {
    label: "New",
    icon: UserPlus,
    className: "text-blue-600 dark:text-blue-400",
  },
};

export default function VaultLeaderboardPlaceholder({ rankings = SAMPLE_RANKINGS }) {
  const hasRankings = rankings.length > 0;

  return (
    <section className="vq-glass p-4 sm:p-6" aria-labelledby="vault-leaderboard-title">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-vault-border bg-vault-surface text-amber-500">
            <Award className="h-5 w-5" aria-hidden="true" />
          </span>
          <div>
            <h2 id="vault-leaderboard-title" className="text-lg font-bold text-vault-text">
              Vault Leaderboard
            </h2>
            <p className="mt-1 text-sm text-vault-muted">
              Placeholder ranking model for future vault engagement features.
            </p>
          </div>
        </div>
        <span className="self-start rounded-full border border-vault-border bg-vault-surface px-3 py-1 text-xs font-semibold text-vault-muted">
          Preview data
        </span>
      </div>

      {hasRankings ? (
        <div className="mt-5 space-y-3">
          {rankings.map((ranking) => {
            const state = STATE_STYLES[ranking.state] || STATE_STYLES.holding;
            const Icon = state.icon;
            return (
              <div
                key={`${ranking.rank}-${ranking.name}`}
                className="grid gap-3 rounded-xl border border-vault-border bg-vault-surface/40 p-4 sm:grid-cols-[auto_1fr_auto]"
              >
                <div className="flex h-10 w-10 items-center justify-center rounded-full border border-vault-border bg-vault-bg text-sm font-black text-vault-text">
                  #{ranking.rank}
                </div>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold text-vault-text">{ranking.name}</p>
                    <span className={`inline-flex items-center gap-1 text-xs font-semibold ${state.className}`}>
                      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                      {state.label}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-vault-muted">
                    {ranking.vault} · {ranking.engagement}
                  </p>
                </div>
                <p className="text-left font-bold text-vault-text sm:text-right">{ranking.score}</p>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="mt-5 flex flex-col items-center rounded-xl border border-dashed border-vault-border bg-vault-surface/30 px-4 py-10 text-center">
          <Info className="h-8 w-8 text-vault-muted" aria-hidden="true" />
          <h3 className="mt-3 text-base font-semibold text-vault-text">No leaderboard activity yet</h3>
          <p className="mt-1 max-w-md text-sm text-vault-muted">
            Rankings will appear after engagement scoring, wallet identity, and vault participation data are connected.
          </p>
        </div>
      )}

      <div className="mt-5 rounded-xl border border-vault-border bg-vault-bg/30 p-4">
        <h3 className="text-sm font-semibold text-vault-text">Future data requirements</h3>
        <ul className="mt-2 space-y-1 text-sm text-vault-muted">
          <li>Wallet identity, vault ID, score, rank delta, and eligibility status.</li>
          <li>Deposit streaks, ticket counts, prize participation, and last activity timestamp.</li>
          <li>Privacy controls for anonymized names and opt-in public rankings.</li>
        </ul>
      </div>
    </section>
  );
}
