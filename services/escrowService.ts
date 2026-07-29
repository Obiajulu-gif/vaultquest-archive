/**
 * Escrow Service
 *
 * High-level orchestration service for managing challenge rewards.
 * Only this service can trigger escrow actions.
 */

import { TrustlessWorkClient } from '@/lib/escrow/trustlessWork';
import { EscrowMapper } from '@/lib/escrow/mapper';
import { Challenge } from '@/types/challenge';
import { TWCreateEscrowResponse, TWEscrowStatusResponse } from '@/lib/escrow/types';

const LOG_PREFIX = '[EscrowService]';

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
  }
};
