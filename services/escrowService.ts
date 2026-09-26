/**
 * Escrow Service
 *
 * High-level orchestration service for managing challenge rewards.
 * Only this service can trigger escrow actions.
 */

import { TrustlessWorkClient } from '@/lib/escrow/trustlessWork';
import { EscrowMapper } from '@/lib/escrow/mapper';
import { Challenge } from '@/types/challenge';
import {
  TWCreateEscrowResponse,
  TWEscrowStatusResponse,
  EscrowConflictError,
  EscrowProviderError,
} from '@/lib/escrow/types';

const LOG_PREFIX = '[EscrowService]';

/** Terminal states — an escrow here has already resolved one way; refunding/releasing it further is not a retry, it's a bug. */
const TERMINAL_ESCROW_STATUSES = new Set(['released', 'refunded', 'resolved', 'expired']);

function escrowLog(action: string, id: string): void {
  console.log(`${LOG_PREFIX} ${action}: ${id}`);
}

export const EscrowService = {
  /**
   * Initializes and funds an escrow for a challenge
   */
  async createEscrowForChallenge(challenge: Challenge, recipientAddress: string): Promise<TWCreateEscrowResponse> {
    escrowLog('Creating escrow for challenge', challenge.id);
    try {
      const request = EscrowMapper.toCreateRequest(challenge, recipientAddress);
      return await TrustlessWorkClient.createEscrow(request);
    } catch (err) {
      throw new Error(`Failed to create escrow for challenge ${challenge.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  },

  /**
   * Syncs the current status of an escrow from Trustless Work
   */
  async getEscrowStatus(type: string, escrowId: string): Promise<TWEscrowStatusResponse> {
    try {
      return await TrustlessWorkClient.getStatus(type, escrowId);
    } catch (err) {
      throw new Error(`Failed to get escrow status for ${escrowId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  },

  /**
   * Releases rewards for a specific user after milestone completion
   */
  async releaseReward(escrowId: string, recipient: string, milestoneIndex: number): Promise<{ xdr: string }> {
    escrowLog(`Triggering reward release for ${recipient} (Milestone ${milestoneIndex}) in escrow`, escrowId);
    try {
      return await TrustlessWorkClient.releaseFunds('multi-release', {
        escrowId,
        recipient,
        milestoneIndex
      });
    } catch (err) {
      throw new Error(`Failed to release reward for escrow ${escrowId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  },

  /**
   * Initiates a dispute for an escrow
   */
  async disputeEscrow(escrowId: string, reason: string): Promise<{ xdr: string }> {
    escrowLog(`Initiating dispute (${reason}) for escrow`, escrowId);
    try {
      return await TrustlessWorkClient.dispute('multi-release', escrowId, reason);
    } catch (err) {
      throw new Error(`Failed to dispute escrow ${escrowId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  },

  /**
   * #741 — refunds an unclaimed challenge past its deadline back to the
   * funder. See docs/QUEST_EXPIRY_AND_REFUND_POLICY.md for the full policy.
   *
   * Deliberately does NOT pre-check status via getStatus() before calling
   * refund(): a check-then-act sequence is exactly the race this needs to
   * avoid — the status could flip between the check and the refund call.
   * Instead this calls refund() directly and lets Trustless Work's own
   * contract be the single source of truth: if a completion already
   * landed, the call returns 409 and is surfaced as `EscrowConflictError`
   * rather than a generic failure, so the caller can tell "lost the race"
   * apart from "something broke."
   */
  async refundExpiredChallenge(challenge: Challenge, reason = 'Quest expired unclaimed'): Promise<{ xdr: string }> {
    if (!challenge.escrowId) {
      throw new Error(`Challenge ${challenge.id} has no escrow to refund.`);
    }
    if (new Date(challenge.deadline).getTime() > Date.now()) {
      throw new Error(`Challenge ${challenge.id} has not reached its deadline (${challenge.deadline}) yet.`);
    }

    escrowLog(`Refunding expired challenge (deadline ${challenge.deadline})`, challenge.escrowId);
    try {
      const request = EscrowMapper.toRefundRequest(challenge, reason);
      return await TrustlessWorkClient.refund(request);
    } catch (err) {
      if (err instanceof EscrowConflictError || err instanceof EscrowProviderError) {
        throw err;
      }
      throw new EscrowProviderError(
        `Failed to refund expired challenge ${challenge.id}: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }
  },

  /**
   * #738 — resolves a disputed escrow, either by explicit arbitration
   * (called within the dispute window) or by the pre-agreed timeout
   * fallback (called with the same signature once the window elapses with
   * no arbitration decision). See docs/QUEST_DISPUTE_STATE_MACHINE.md.
   */
  async resolveDispute(
    challenge: Challenge,
    resolution: 'released' | 'refunded' | 'split',
    splitBps?: number,
  ): Promise<{ xdr: string }> {
    if (!challenge.escrowId) {
      throw new Error(`Challenge ${challenge.id} has no escrow to resolve.`);
    }
    escrowLog(`Resolving dispute as "${resolution}"`, challenge.escrowId);
    try {
      const request = EscrowMapper.toResolveDisputeRequest(challenge, resolution, splitBps);
      return await TrustlessWorkClient.resolveDispute(request);
    } catch (err) {
      if (err instanceof EscrowConflictError || err instanceof EscrowProviderError) {
        throw err;
      }
      throw new EscrowProviderError(
        `Failed to resolve dispute for challenge ${challenge.id}: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }
  },

  /**
   * #738 — applies the pre-agreed fallback once a disputed escrow's
   * arbitration window elapses with no resolution: split by default so
   * neither party is unilaterally favored by staying silent (a full
   * refund would reward a funder who disputes in bad faith and goes
   * quiet; a full release would reward a claimant doing the same).
   */
  async applyDisputeTimeoutFallback(challenge: Challenge, fallbackSplitBps = 5000): Promise<{ xdr: string }> {
    return EscrowService.resolveDispute(challenge, 'split', fallbackSplitBps);
  },
};

export { TERMINAL_ESCROW_STATUSES };
