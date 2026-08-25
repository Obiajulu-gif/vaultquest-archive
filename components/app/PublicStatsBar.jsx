import { formatUsd } from "@/lib/yield-counter";
import { PUBLIC_STATS } from "@/lib/demo-portfolio";

function Stat({ label, value }) {
  return (
    <div className="vq-glass min-w-0 flex-1 px-4 py-3 sm:px-5 sm:py-4">
      <p className="text-xs font-medium uppercase tracking-wide text-vault-muted">{label}</p>
      <p className="mt-1 truncate text-lg font-bold text-vault-text sm:text-xl">{value}</p>
    </div>
  );
}

export default function PublicStatsBar({ layout = "horizontal" }) {
  const locale = typeof navigator !== "undefined" ? navigator.language : "en";
  const containerClass = layout === "vertical"
    ? "flex flex-col gap-3 w-full"
    : "grid grid-cols-2 gap-3 lg:grid-cols-4 w-full";

  return (
    <section aria-label="Protocol statistics" className={containerClass}>
      <Stat label="Total value locked" value={formatUsd(PUBLIC_STATS.tvl, locale)} />
      <Stat label="Prize pool" value={formatUsd(PUBLIC_STATS.prizePool, locale)} />
      <Stat
        label="Active savers"
        value={PUBLIC_STATS.activeSavers.toLocaleString(locale)}
      />
      <Stat label="Current round" value={`#${PUBLIC_STATS.currentRound}`} />
    </section>
  );
}
