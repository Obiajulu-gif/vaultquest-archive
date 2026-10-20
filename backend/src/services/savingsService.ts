/**
 * Orchestrates batch vault settlements across a concluded savings period.
 *
 * Delegates individual vault settlement to `EscrowService`, which handles
 * retry logic and Horizon submission (issue #274).
 */

import type { EscrowService } from "./escrowService.js";

// ─── Concurrency control ──────────────────────────────────────────────────────

/**
 * Per-vault async mutex.
 *
 * Critical mutation paths (vault settlement) must be serialized per vault id so
 * that concurrent submissions for the same vault cannot interleave and produce
 * duplicate irreversible records (e.g. two `release` settlements).
 *
 * Strategy: a keyed promise chain. Each vault id owns a tail promise; new work
 * is appended to the tail and awaited in FIFO order. This gives us:
 *   - mutual exclusion per vault id (no duplicate settlements),
 *   - idempotency for duplicate retries (the second call observes the first
 *     result via the settlement ledger below),
 *   - bounded memory (entries are released once the chain drains).
 */
class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>();

  async runExclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();

    // Swallow rejections on the chain so one failure cannot poison the queue.
    const run = previous.then(task, task);
    const tail = run.then(
      () => undefined,
      () => undefined
    );

    this.tails.set(key, tail);

    try {
      return await run;
    } finally {
      // Release the entry only if no newer work was queued behind us.
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    }
  }
}

/**
 * Idempotency ledger for irreversible settlement outcomes.
 *
 * Once a vault reaches a terminal state (Resolved / Refunded) the outcome is
 * recorded here. Duplicate retries and conflicting concurrent requests for the
 * same vault id replay the recorded outcome instead of re-submitting to
 * Horizon, guaranteeing no duplicate irreversible records.
 */
class SettlementLedger {
  private readonly outcomes = new Map<string, VaultSettleOutcome>();

  get(vaultId: string): VaultSettleOutcome | undefined {
    return this.outcomes.get(vaultId);
  }

  record(vaultId: string, outcome: VaultSettleOutcome): void {
    this.outcomes.set(vaultId, outcome);
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface VaultSettleInput {
  vaultId: string;
  settlementType: "release" | "distribute" | "refund";
  recipient?: string;
  amount?: string;
}

export interface VaultSettleOutcome {
  state: "Resolved" | "Refunded" | "Failed";
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
  private readonly mutex = new KeyedMutex();
  private readonly ledger = new SettlementLedger();

  constructor(private readonly escrow: EscrowService) {}

  /**
   * Settles a single vault exactly once.
   *
   * Concurrency contract:
   *   - Calls for the same `vaultId` are serialized by the keyed mutex.
   *   - If a terminal outcome already exists in the ledger, it is replayed and
   *     `EscrowService.settleVault` is NOT called again (idempotent retries).
   *   - A conflicting request (e.g. `release` after `refund`) observes the
   *     recorded outcome and does not create a second irreversible record.
   */
  private async settleVaultOnce(vault: VaultSettleInput): Promise<VaultSettleOutcome> {
    return this.mutex.runExclusive(vault.vaultId, async () => {
      const existing = this.ledger.get(vault.vaultId);
      if (existing) {
        return existing;
      }

      const outcome = (await this.escrow.settleVault(vault)) as VaultSettleOutcome;

      if (outcome.state === "Resolved" || outcome.state === "Refunded") {
        this.ledger.record(vault.vaultId, outcome);
      }

      return outcome;
    });
  }

  /**
   * Iterates through `vaults`, calling `EscrowService.settleVault` for each,
   * and returns aggregate counts.
   */
  async settleConcludedPeriod(vaults: VaultSettleInput[]): Promise<SettlePeriodResult> {
    let resolved = 0;
    let refunded = 0;
    let failed = 0;

    // Settle vaults concurrently; the keyed mutex + ledger guarantee that
    // duplicate or conflicting submissions for the same vault id collapse to a
    // single irreversible record.
    const outcomes = await Promise.all(
      vaults.map(async (vault) => {
        try {
          return { vault, outcome: await this.settleVaultOnce(vault) };
        } catch {
          return { vault, outcome: { state: "Failed" } as VaultSettleOutcome };
        }
      })
    );

    for (const { vault, outcome } of outcomes) {
      if (outcome.state === "Resolved") {
        if (vault.settlementType === "refund") {
          refunded += 1;
        } else {
          resolved += 1;
        }
      } else if (outcome.state === "Refunded") {
        refunded += 1;
      } else {
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
