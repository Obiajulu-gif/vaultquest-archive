/**
 * Evaluates wallet progression through quest milestones and progress tracking.
 *
 * Computes quest metrics from action history and derives progress state.
 */

/**
 * Aggregated quest evaluation metrics for a wallet.
 */
export interface QuestMetrics {
  walletAddress: string;
  totalDeposits: number;
  totalWithdrawals: number;
  totalClaims: number;
  questsCompleted: number;
  currentQuestId?: string;
}

/**
 * Describes progress toward a single quest requirement.
 */
export interface QuestProgress {
  questId: string;
  title: string;
  completed: boolean;
  current: number;
  target: number;
}

/**
 * Normalizes unknown numeric values to numbers for evaluation.
 *
 * @param value - Value to coerce
 * @returns Numeric value or 0 if not numeric
 */
function num(value: unknown): number {
  const n = typeof value === "number" ? value : parseInt(String(value ?? 0), 10);
  return Number.isFinite(n) ? n : 0;
}

export interface QuestServiceDeps {
  getActions(walletAddress: string): Promise<any[]>;
}

export class QuestService {
  constructor(private deps: QuestServiceDeps) {}

  /**
   * Computes aggregate metrics for a wallet across deposit, withdrawal, and claim actions.
   *
   * @param walletAddress - Wallet to evaluate
   * @returns Quest metrics summary
   */
  async computeMetrics(walletAddress: string): Promise<QuestMetrics> {
    const actions = await this.deps.getActions(walletAddress);
    const confirmed = actions.filter((a) => (a.status ?? "") === "confirmed");

    const totalDeposits = confirmed
      .filter((a) => a.actionType === "deposit")
      .reduce((s, a) => s + num((a.actionPayload as any)?.amount), 0);

    const totalWithdrawals = confirmed
      .filter((a) => a.actionType === "withdraw")
      .reduce((s, a) => s + num((a.actionPayload as any)?.amount), 0);

    const totalClaims = confirmed
      .filter((a) => a.actionType === "claim")
      .reduce((s, a) => s + num((a.actionPayload as any)?.amount), 0);

    return {
      walletAddress,
      totalDeposits,
      totalWithdrawals,
      totalClaims,
      questsCompleted: 0,
    };
  }

  /**
   * Projects raw metrics into a list of quest progress states.
   *
   * @param metrics - Wallet metrics
   * @returns Quest progress entries
   */
  projectProgress(metrics: QuestMetrics): QuestProgress[] {
    return [
      {
        questId: "deposit",
        title: "First deposit",
        completed: metrics.totalDeposits > 0,
        current: metrics.totalDeposits,
        target: 100,
      },
      {
        questId: "claim",
        title: "First prize claim",
        completed: metrics.totalClaims > 0,
        current: metrics.totalClaims,
        target: 1,
      },
    ];
  }

  /**
   * Evaluates current quest progress for a wallet.
   *
   * @param walletAddress - Wallet identifier
   * @returns Quest progress list
   */
  async evaluateWallet(walletAddress: string): Promise<QuestProgress[]> {
    const metrics = await this.computeMetrics(walletAddress);
    return this.projectProgress(metrics);
  }

  /**
   * Evaluates quest progress across a recent window of wallets.
   *
   * @param since - Start of evaluation window
   * @param limit - Maximum number of wallets to consider
   * @returns Count of wallets evaluated
   */
  async evaluateRecent(since: Date, limit = 500): Promise<{ wallets: number }> {
    // Placeholder: enumerate wallets from recent actions and evaluate
    return { wallets: 0 };
  }

  /**
   * Returns cached quest progress for a wallet.
   *
   * @param walletAddress - Wallet identifier
   * @returns Quest progress entries
   */
  async getUserQuests(walletAddress: string): Promise<QuestProgress[]> {
    const metrics = await this.computeMetrics(walletAddress);
    return this.projectProgress(metrics);
  }
}