/**
 * Orchestrates batch vault settlements across a concluded savings period.
 *
 * Delegates individual vault settlement to `EscrowService`, which handles
 * retry logic and Horizon submission (issue #274).
 */

import type { EscrowService } from "./escrowService.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface VaultSettleInput {
  vaultId: string;
  settlementType: "release" | "distribute" | "refund";
  recipient?: string;
  amount?: string;
}

export interface SettlePeriodResult {
  /** Total vaults attempted. */
  total: number;
  /** Vaults that reached the Resolved state (release / distribute). */
  resolved: number;
  /** Vaults that reached the Refunded state. */
  refunded: number;
  /** Vaults that failed after all retries. */
  failed: number;
}

// ─── SavingsService ───────────────────────────────────────────────────────────

/**
 * Settles a batch of vaults for a concluded savings period.
 *
 * Each vault is settled independently; a failure on one vault does not abort
 * the rest of the batch.
 */
export class SavingsService {
  constructor(private readonly escrow: EscrowService) {}

  /**
   * Iterates through `vaults`, calling `EscrowService.settleVault` for each,
   * and returns aggregate counts.
   */
  async settleConcludedPeriod(vaults: VaultSettleInput[]): Promise<SettlePeriodResult> {
    let resolved = 0;
    let refunded = 0;
    let failed = 0;

    for (const vault of vaults) {
      try {
        const outcome = await this.escrow.settleVault(vault);

        if (outcome.state === "Resolved") {
          if (vault.settlementType === "refund") {
            refunded += 1;
          } else {
            resolved += 1;
          }
        } else {
          failed += 1;
        }
      } catch {
        failed += 1;
      }
    }

    return {
      total: vaults.length,
      resolved,
      refunded,
      failed
    };
  }
}
