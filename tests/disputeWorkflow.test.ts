/**
 * DisputeWorkflow tests (#845)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { DisputeWorkflow, DisputeError } from '../services/disputeWorkflow';

describe('DisputeWorkflow', () => {
  let workflow: DisputeWorkflow;

  beforeEach(() => {
    workflow = new DisputeWorkflow();
  });

  it('creates a dispute successfully', () => {
    const dispute = workflow.createDispute({
      transferId: 'tx-1',
      disputedBy: 'user-1',
      reason: 'Fraudulent transfer',
    });
    expect(dispute.state).toBe('pending');
    expect(dispute.transferId).toBe('tx-1');
  });

  it('rejects empty reason', () => {
    expect(() =>
      workflow.createDispute({ transferId: 'tx-1', disputedBy: 'user-1', reason: '  ' })
    ).toThrow(DisputeError);
  });

  it('rejects duplicate dispute on same transfer', () => {
    workflow.createDispute({ transferId: 'tx-1', disputedBy: 'user-1', reason: 'test' });
    expect(() =>
      workflow.createDispute({ transferId: 'tx-1', disputedBy: 'user-2', reason: 'test2' })
    ).toThrow(DisputeError);
  });

  it('allows evidence submission in pending state', () => {
    const dispute = workflow.createDispute({
      transferId: 'tx-1',
      disputedBy: 'user-1',
      reason: 'test',
    });
    const updated = workflow.submitEvidence(dispute.id, {
      submittedBy: 'user-1',
      description: 'Screenshot of unauthorized action',
    });
    expect(updated.evidence).toHaveLength(1);
  });

  it('blocks evidence after resolution', () => {
    const dispute = workflow.createDispute({
      transferId: 'tx-1',
      disputedBy: 'user-1',
      reason: 'test',
    });
    workflow.startReview(dispute.id);
    workflow.resolveDispute({
      disputeId: dispute.id,
      resolvedBy: 'admin-1',
      resolution: 'accepted',
      note: 'Valid dispute',
    });
    expect(() =>
      workflow.submitEvidence(dispute.id, { submittedBy: 'user-1', description: 'late' })
    ).toThrow(DisputeError);
  });

  it('resolves a dispute and audits the resolution', () => {
    const dispute = workflow.createDispute({
      transferId: 'tx-1',
      disputedBy: 'user-1',
      reason: 'test',
    });
    workflow.startReview(dispute.id);
    const resolved = workflow.resolveDispute({
      disputeId: dispute.id,
      resolvedBy: 'admin-1',
      resolution: 'accepted',
      note: 'Ownership restored',
    });
    expect(resolved.state).toBe('resolved');
    expect(resolved.resolution).toBe('accepted');
    expect(resolved.resolvedBy).toBe('admin-1');
  });

  it('blocks destructive actions while dispute is active', () => {
    const dispute = workflow.createDispute({
      transferId: 'tx-1',
      disputedBy: 'user-1',
      reason: 'test',
    });
    expect(workflow.hasActiveDispute('tx-1')).toBe(true);
    workflow.startReview(dispute.id);
    workflow.resolveDispute({
      disputeId: dispute.id,
      resolvedBy: 'admin',
      resolution: 'rejected',
      note: 'No issue',
    });
    expect(workflow.hasActiveDispute('tx-1')).toBe(false);
  });

  it('rejects resolution of non-under_review disputes', () => {
    const dispute = workflow.createDispute({
      transferId: 'tx-1',
      disputedBy: 'user-1',
      reason: 'test',
    });
    expect(() =>
      workflow.resolveDispute({
        disputeId: dispute.id,
        resolvedBy: 'admin',
        resolution: 'accepted',
        note: 'test',
      })
    ).toThrow(DisputeError);
  });
});
