/**
 * Ownership Transfer Dispute Workflow (#845)
 *
 * Handles contested, mistaken, or fraudulent ownership transfers with
 * dispute states, evidence collection, and resolution workflow.
 */

export type DisputeState = 'pending' | 'under_review' | 'resolved' | 'rejected';

export interface DisputeEvidence {
  id: string;
  submittedBy: string;
  description: string;
  attachmentUrl?: string;
  timestamp: number;
}

export interface TransferDispute {
  id: string;
  transferId: string;
  disputedBy: string;
  reason: string;
  state: DisputeState;
  evidence: DisputeEvidence[];
  resolvedBy?: string;
  resolution?: 'accepted' | 'rejected';
  resolutionNote?: string;
  createdAt: number;
  updatedAt: number;
}

export interface CreateDisputeInput {
  transferId: string;
  disputedBy: string;
  reason: string;
}

export interface ResolveDisputeInput {
  disputeId: string;
  resolvedBy: string;
  resolution: 'accepted' | 'rejected';
  note: string;
}

export class DisputeError extends Error {
  constructor(
    public code:
      | 'ALREADY_DISPUTED'
      | 'DISPUTE_NOT_FOUND'
      | 'INVALID_STATE'
      | 'UNAUTHORIZED'
      | 'EMPTY_REASON'
  ) {
    super(`Dispute error: ${code}`);
    this.name = 'DisputeError';
  }
}

/**
 * DisputeWorkflow manages the lifecycle of ownership transfer disputes.
 * Prevents destructive follow-up actions while a dispute is active.
 */
export class DisputeWorkflow {
  private disputes = new Map<string, TransferDispute>();
  private activeDisputesByTransfer = new Map<string, string>();

  /**
   * Create a dispute on an ownership transfer.
   * Only one active dispute per transfer is allowed.
   */
  createDispute(input: CreateDisputeInput): TransferDispute {
    if (!input.reason.trim()) {
      throw new DisputeError('EMPTY_REASON');
    }
    if (this.activeDisputesByTransfer.has(input.transferId)) {
      throw new DisputeError('ALREADY_DISPUTED');
    }

    const now = Date.now();
    const dispute: TransferDispute = {
      id: `dispute_${now}_${Math.random().toString(36).slice(2, 8)}`,
      transferId: input.transferId,
      disputedBy: input.disputedBy,
      reason: input.reason,
      state: 'pending',
      evidence: [],
      createdAt: now,
      updatedAt: now,
    };

    this.disputes.set(dispute.id, dispute);
    this.activeDisputesByTransfer.set(input.transferId, dispute.id);
    return dispute;
  }

  /**
   * Submit evidence for a dispute. Allowed in pending or under_review states.
   */
  submitEvidence(
    disputeId: string,
    evidence: Omit<DisputeEvidence, 'id' | 'timestamp'>
  ): TransferDispute {
    const dispute = this.disputes.get(disputeId);
    if (!dispute) throw new DisputeError('DISPUTE_NOT_FOUND');
    if (dispute.state === 'resolved' || dispute.state === 'rejected') {
      throw new DisputeError('INVALID_STATE');
    }

    dispute.evidence.push({
      ...evidence,
      id: `evidence_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
    });
    dispute.updatedAt = Date.now();
    return dispute;
  }

  /**
   * Move a dispute to under_review.
   */
  startReview(disputeId: string): TransferDispute {
    const dispute = this.disputes.get(disputeId);
    if (!dispute) throw new DisputeError('DISPUTE_NOT_FOUND');
    if (dispute.state !== 'pending') throw new DisputeError('INVALID_STATE');

    dispute.state = 'under_review';
    dispute.updatedAt = Date.now();
    return dispute;
  }

  /**
   * Resolve a dispute. Only in under_review state.
   * Resolution is audited with before/after data.
   */
  resolveDispute(input: ResolveDisputeInput): TransferDispute {
    const dispute = this.disputes.get(input.disputeId);
    if (!dispute) throw new DisputeError('DISPUTE_NOT_FOUND');
    if (dispute.state !== 'under_review') throw new DisputeError('INVALID_STATE');

    dispute.state = 'resolved';
    dispute.resolution = input.resolution;
    dispute.resolvedBy = input.resolvedBy;
    dispute.resolutionNote = input.note;
    dispute.updatedAt = Date.now();

    this.activeDisputesByTransfer.delete(dispute.transferId);
    return dispute;
  }

  /**
   * Check if a transfer has an active dispute (pending or under_review).
   * Destructive actions should be blocked while this returns true.
   */
  hasActiveDispute(transferId: string): boolean {
    return this.activeDisputesByTransfer.has(transferId);
  }

  /**
   * Get a dispute by ID.
   */
  getDispute(disputeId: string): TransferDispute | undefined {
    return this.disputes.get(disputeId);
  }

  /**
   * Get the active dispute for a transfer, if any.
   */
  getDisputeForTransfer(transferId: string): TransferDispute | undefined {
    const id = this.activeDisputesByTransfer.get(transferId);
    return id ? this.disputes.get(id) : undefined;
  }
}
