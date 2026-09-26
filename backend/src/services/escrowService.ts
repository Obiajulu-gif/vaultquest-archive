/**
 * Coordinates vault settlement flows: assemble → sign → submit with
 * exponential-backoff retries on transient Soroban RPC failures (issue #274).
 *
 * The settlement pipeline is idempotent: calling `settleVault` on an already-
 * resolved vault returns the existing record without re-submitting.
 */

import type { PrismaClient } from "@prisma/client";
import { RETRYABLE_RESULT_CODES, SETTLEMENT_RETRY, ERROR_CODES } from "../constants.js";

// ─── External dependency interfaces ──────────────────────────────────────────

/** Signs a transaction XDR blob on behalf of the admin key. */
export interface AdminSigner {
  publicKey: string;
  sign(xdr: string): Promise<string>;
}

export interface AssembleInput {
  vaultId: string;
  sequence: string;
  settlementType: string;
  recipient?: string;
  amount?: string;
}

export interface PreparedTransaction {
  xdr: string;
  sourceAccount: string;
  sequence: string;
}

export interface SubmitResult {
  hash: string;
  successful: boolean;
  resultCode: string;
}

/** Wraps the Horizon submit and sequence-loading calls. */
export interface HorizonGateway {
  loadSequence(account: string): Promise<string>;
  submit(signedXdr: string): Promise<SubmitResult>;
}

/** Facts extracted from a finalized token-transfer/payout event on-chain. */
export interface VerifiedPayoutFacts {
  recipient: string;
  amount: string;
  /** Asset/token code, when the underlying event exposes one. */
  asset?: string;
}

/**
 * Independently re-confirms a submitted transaction against finalized
 * ledger/contract-event state, rather than trusting `HorizonGateway.submit`'s
 * synchronous `successful` flag alone (#509 — a `tx_success` response is not
 * itself proof of *what* transferred, to *whom*, only that the ledger
 * accepted the envelope). `null` means no finalized transfer event was found
 * for this hash — including because the event hasn't been indexed yet.
 */
export interface PayoutVerifier {
  verify(txHash: string): Promise<VerifiedPayoutFacts | null>;
}

export interface TransactionAssembler {
  assemble(input: AssembleInput): Promise<PreparedTransaction>;
}

// ─── EscrowServiceDeps ────────────────────────────────────────────────────────

export interface EscrowServiceDeps {
  prisma: PrismaClient;
  horizon: HorizonGateway;
  signer: AdminSigner;
  assembler: TransactionAssembler;
  networkPassphrase: string;
  /**
   * Independently confirms a payout against finalized chain state before
   * `settleVault` reports `Resolved` (#509). Optional so existing callers
   * (and pre-#509 tests) keep working unchanged; omitting it reproduces the
   * prior trust-the-submission-result behavior, so new integrations should
   * supply one.
   */
  verifier?: PayoutVerifier;
  /** Injected sleep — override to `async () => {}` in tests. */
  sleep?: (ms: number) => Promise<void>;
}

// ─── Settlement outcome ───────────────────────────────────────────────────────

export interface SettleVaultInput {
  vaultId: string;
  settlementType: "release" | "distribute" | "refund";
  recipient?: string;
  amount?: string;
}

export type SettleVaultOutcome =
  | { state: "Resolved"; txHash: string; attempts: number; alreadySettled?: false; payoutVerified?: boolean }
  | { state: "Unresolved"; txHash: null; attempts: number; alreadySettled?: false; errorCode: string }
  | { state: "Resolved"; txHash: string; attempts: 0; alreadySettled: true }
  | { state: "PendingVerification"; txHash: string; attempts: number; payoutVerified: false; errorCode: string };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isRetryableCode(resultCode: string): boolean {
  return RETRYABLE_RESULT_CODES.some(
    (r) => resultCode.toLowerCase().includes(r.toLowerCase())
  );
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ─── EscrowService ────────────────────────────────────────────────────────────

/**
 * Builds, signs, and submits vault settlement transactions.
 *
 * Retry policy (from `SETTLEMENT_RETRY`):
 *   - Up to `maxAttempts` total tries
 *   - Exponential backoff with `baseDelayMs` doubling each attempt, capped at
 *     `maxDelayMs`
 *   - Only retries when the Horizon result code is in `RETRYABLE_RESULT_CODES`
 *   - Reloads the account sequence number before each attempt so stale-sequence
 *     failures are resolved automatically
 *
 * Independent payout verification (#509): once Horizon reports a successful
 * submission, a configured `verifier` is used to independently confirm the
 * finalized transfer event before reporting `Resolved`. A vault whose
 * verification doesn't (yet) agree is parked in `PendingVerification` — a
 * terminal-on-chain but not-yet-trusted state that is never auto-retried
 * (retrying a transaction that already succeeded on-chain risks a double
 * payout). Calling `settleVault` again on a `PendingVerification` vault only
 * re-checks the verifier against the existing hash; it never resubmits.
 */
export class EscrowService {
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: EscrowServiceDeps) {
    this.sleep = deps.sleep ?? defaultSleep;
  }

  /**
   * Executes a full settle-vault pipeline with retry logic.
   *
   * Returns immediately (idempotent) if the vault already has a terminal state.
   */
  async settleVault(input: SettleVaultInput): Promise<SettleVaultOutcome> {
    const { prisma, horizon, signer, assembler, verifier } = this.deps;

    // ── Idempotency check ─────────────────────────────────────────────────
    const existing = await prisma.vaultSettlement.findUnique({
      where: { vaultId: input.vaultId }
    });
    if (existing && (existing.state === "Resolved" || existing.state === "Refunded")) {
      return {
        state: "Resolved",
        txHash: existing.txHash!,
        attempts: 0,
        alreadySettled: true
      };
    }

    // #509: a vault stuck in PendingVerification already has a transaction
    // that submitted successfully — resubmitting here (falling through to the
    // retry loop below) risks a double payout. Instead, only re-check the
    // verifier against the hash that already succeeded on-chain.
    if (existing && existing.state === "PendingVerification" && existing.txHash) {
      return this.recheckPendingVerification(existing.txHash, existing.attempts, input);
    }

    // ── Create / reset the settlement record ──────────────────────────────
    await prisma.vaultSettlement.upsert({
      where: { vaultId: input.vaultId },
      create: {
        vaultId: input.vaultId,
        state: "Resolving",
        settlementType: input.settlementType,
        recipient: input.recipient ?? null,
        amount: input.amount ?? null
      },
      update: {
        state: "Resolving",
        settlementType: input.settlementType,
        recipient: input.recipient ?? null,
        amount: input.amount ?? null,
        errorCode: null,
        errorDetail: null,
        attempts: 0
      }
    });

    const { maxAttempts, baseDelayMs, maxDelayMs } = SETTLEMENT_RETRY;
    let lastResultCode = "";
    let attempt = 0;

    // ── Retry loop ────────────────────────────────────────────────────────
    for (attempt = 1; attempt <= maxAttempts; attempt++) {
      // Reload sequence on every attempt — essential for tx_bad_seq recovery.
      const sequence = await horizon.loadSequence(signer.publicKey);

      const prepared = await assembler.assemble({
        vaultId: input.vaultId,
        sequence,
        settlementType: input.settlementType,
        recipient: input.recipient,
        amount: input.amount
      });

      const signed = await signer.sign(prepared.xdr);

      let result: SubmitResult;
      try {
        result = await horizon.submit(signed);
      } catch (err: unknown) {
        // Network-level error — treat as retryable
        const msg = err instanceof Error ? err.message : String(err);
        lastResultCode = msg;
        if (attempt < maxAttempts && isRetryableCode(msg)) {
          const cap = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
          await this.sleep(Math.floor(Math.random() * cap));
          continue;
        }
        break;
      }

      lastResultCode = result.resultCode;

      if (result.successful) {
        // ── Success on-chain — independently verify before reporting Resolved ──
        return this.finalizeSuccess(input, result.hash, attempt, verifier);
      }

      // ── Failed attempt ────────────────────────────────────────────────
      if (!isRetryableCode(result.resultCode) || attempt >= maxAttempts) {
        break;
      }

      // Exponential backoff before next attempt
      const cap = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
      await this.sleep(Math.floor(Math.random() * cap));
    }

    // ── All attempts exhausted or non-retryable failure ───────────────────
    const errorCode =
      attempt >= maxAttempts
        ? ERROR_CODES.SETTLEMENT_RETRIES_EXHAUSTED
        : ERROR_CODES.SETTLEMENT_SUBMIT_FAILED;

    await prisma.vaultSettlement.update({
      where: { vaultId: input.vaultId },
      data: {
        state: "Unresolved",
        txHash: null,
        errorCode,
        errorDetail: lastResultCode || null,
        attempts: attempt
      }
    });

    return { state: "Unresolved", txHash: null, attempts: attempt, errorCode };
  }

  /**
   * Called once Horizon reports a successful submission. Verifies the payout
   * against finalized chain state when a `verifier` is configured and the
   * settlement has a single recipient/amount to check (#509); `distribute`
   * settlements fan out to multiple recipients and have no single fact to
   * verify, so — like the no-verifier case — they're reported Resolved
   * immediately.
   */
  private async finalizeSuccess(
    input: SettleVaultInput,
    txHash: string,
    attempts: number,
    verifier: PayoutVerifier | undefined
  ): Promise<SettleVaultOutcome> {
    const canVerify = Boolean(
      verifier && input.settlementType !== "distribute" && input.recipient && input.amount
    );

    if (canVerify) {
      const facts = await verifier!.verify(txHash);
      const verified = this.factsMatch(facts, input);
      if (!verified) {
        await this.deps.prisma.vaultSettlement.update({
          where: { vaultId: input.vaultId },
          data: {
            state: "PendingVerification",
            txHash,
            errorCode: ERROR_CODES.SETTLEMENT_PAYOUT_UNVERIFIED,
            errorDetail: facts ? "payout facts mismatch" : "no finalized event found",
            attempts
          }
        });
        return {
          state: "PendingVerification",
          txHash,
          attempts,
          payoutVerified: false,
          errorCode: ERROR_CODES.SETTLEMENT_PAYOUT_UNVERIFIED
        };
      }
    }

    const finalState = input.settlementType === "refund" ? "Refunded" : "Resolved";
    await this.persistResolved(input.vaultId, finalState, txHash, attempts);
    return { state: "Resolved", txHash, attempts, payoutVerified: canVerify ? true : undefined };
  }

  /** Re-checks the verifier for a vault already parked in PendingVerification, without resubmitting. */
  private async recheckPendingVerification(
    txHash: string,
    attempts: number,
    input: SettleVaultInput
  ): Promise<SettleVaultOutcome> {
    const { verifier } = this.deps;
    const facts = verifier ? await verifier.verify(txHash) : null;

    if (this.factsMatch(facts, input)) {
      const finalState = input.settlementType === "refund" ? "Refunded" : "Resolved";
      await this.persistResolved(input.vaultId, finalState, txHash, attempts);
      return { state: "Resolved", txHash, attempts, payoutVerified: true };
    }

    return {
      state: "PendingVerification",
      txHash,
      attempts,
      payoutVerified: false,
      errorCode: ERROR_CODES.SETTLEMENT_PAYOUT_UNVERIFIED
    };
  }

  private factsMatch(facts: VerifiedPayoutFacts | null, input: SettleVaultInput): boolean {
    return !!facts && facts.recipient === input.recipient && facts.amount === input.amount;
  }

  /** Persists the terminal Resolved/Refunded state, tolerating a tx-hash race. */
  private async persistResolved(
    vaultId: string,
    finalState: "Resolved" | "Refunded",
    txHash: string,
    attempts: number
  ): Promise<void> {
    const { prisma } = this.deps;
    try {
      await prisma.vaultSettlement.update({
        where: { vaultId },
        data: {
          state: finalState,
          txHash,
          resultCode: "tx_success",
          errorCode: null,
          errorDetail: null,
          attempts,
          resolvedAt: new Date()
        }
      });
    } catch (updateErr: unknown) {
      // P2002 on txHash means another settlement already owns this hash
      // (possible in test environments with scripted stub horizons).
      // The on-chain tx succeeded — record the state without the hash.
      const isHashConflict =
        updateErr instanceof Error &&
        (updateErr.message.includes("P2002") || (updateErr as any).code === "P2002");
      if (!isHashConflict) throw updateErr;

      await prisma.vaultSettlement.update({
        where: { vaultId },
        data: {
          state: finalState,
          resultCode: "tx_success",
          attempts,
          resolvedAt: new Date()
        }
      });
    }
  }

  /** Returns persisted settlement state for a vault, or null if none exists. */
  async getSettlement(vaultId: string) {
    return this.deps.prisma.vaultSettlement.findUnique({ where: { vaultId } });
  }
}
