/** Demo metrics shown when a wallet is connected (until live indexer data is wired). */
export const DEMO_PORTFOLIO = {
  activeDeposits: 4250.0,
  cumulativeWinnings: 312.5,
  apyPercent: 8.5,
  accruedYieldBase: 127.84,
};

export const DEMO_TRANSACTIONS = [
  { id: "tx-1", type: "deposit", pool: "Community Drip Pool", asset: "USDC", amount: 500, date: "2026-05-28T14:22:00Z", status: "confirmed" },
  { id: "tx-2", type: "reward", pool: "Community Drip Pool", asset: "USDC", amount: 42.5, date: "2026-05-20T09:00:00Z", status: "confirmed" },
  { id: "tx-sys-1", type: "system_message", message: "System Upgrade Completed", date: "2026-05-18T00:00:00Z", status: "confirmed" },
  { id: "tx-3", type: "deposit", pool: "Starter Vault", asset: "AVAX", amount: 250, date: "2026-05-15T18:45:00Z", status: "confirmed" },
  { id: "tx-round-1", type: "round_update", message: "Round 47 Ended, Yield distributed.", date: "2026-05-14T12:00:00Z", status: "confirmed" },
  { id: "tx-4", type: "withdraw", pool: "Starter Vault", asset: "AVAX", amount: 100, date: "2026-05-10T11:30:00Z", status: "confirmed" },
  { id: "tx-vault-1", type: "vault_action", pool: "Starter Vault", message: "Vault Strategy Updated", date: "2026-05-08T09:00:00Z", status: "confirmed" },
  { id: "tx-account-1", type: "account_action", message: "Profile Updated", date: "2026-05-05T15:20:00Z", status: "confirmed" },
  { id: "tx-5", type: "deposit", pool: "Community Drip Pool", asset: "USDC", amount: 1000, date: "2026-05-01T08:15:00Z", status: "confirmed" },
  { id: "tx-6", type: "deposit", pool: "High-Yield Round", asset: "XLM", amount: 750, date: "2026-04-22T16:00:00Z", status: "confirmed" },
  { id: "tx-7", type: "reward", pool: "High-Yield Round", asset: "XLM", amount: 270, date: "2026-04-18T12:00:00Z", status: "confirmed" },
  { id: "tx-8", type: "deposit", pool: "Community Drip Pool", asset: "USDC", amount: 300, date: "2026-04-05T10:20:00Z", status: "pending" },
];

export const PUBLIC_STATS = {
  tvl: 2_847_500,
  prizePool: 142_375,
  activeSavers: 3842,
  currentRound: 47,
  prizeEstimate: 14_237,
  recentActivityCount: 28,
};

/**
 * Aggregates raw activity into a per-vault position summary: how many
 * vaults the user has joined, their balance in each, and any transactions
 * still awaiting confirmation.
 * @param {typeof DEMO_TRANSACTIONS} transactions
 */
export function summarizeAccountPositions(transactions = DEMO_TRANSACTIONS) {
  const byPool = new Map();

  for (const tx of transactions) {
    if (!tx.pool) continue;

    const entry = byPool.get(tx.pool) ?? {
      pool: tx.pool,
      asset: tx.asset,
      balance: 0,
      pendingCount: 0,
    };

    if (tx.type === "deposit" || tx.type === "reward") {
      entry.balance += tx.amount;
    } else if (tx.type === "withdraw") {
      entry.balance -= tx.amount;
    }

    if (tx.status === "pending") {
      entry.pendingCount += 1;
    }

    byPool.set(tx.pool, entry);
  }

  const positions = Array.from(byPool.values());

  return {
    positions,
    totalJoinedVaults: positions.length,
    totalBalance: positions.reduce((sum, position) => sum + position.balance, 0),
    pendingActionsCount: positions.reduce((sum, position) => sum + position.pendingCount, 0),
  };
}
