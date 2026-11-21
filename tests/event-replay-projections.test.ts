import { describe, it, expect } from 'vitest';
import {
  VersionedEventReplayEngine,
  createInitialProjections,
  computeStateChecksum,
  type StoredEvent,
  type ReplayOptions,
} from '../lib/event-replay-projections';

describe('Versioned Event Replay for Derived Projections (#1113)', () => {
  const maintainerOptions: ReplayOptions = {
    targetProjectionVersion: 1,
    actorRole: 'maintainer',
    actorSubject: 'GADMIN',
    reason: 'Routine projection replay verification',
  };

  const sampleEvents: StoredEvent[] = [
    {
      id: 'ev-1',
      sequence: 1,
      ledgerSequence: 100,
      txHash: '0xaaa1',
      type: 'deposit',
      version: 1,
      timestamp: '2026-01-01T00:00:00Z',
      payload: { vaultId: 'vault-1', walletAddress: 'wallet-alice', amount: 1000 },
    },
    {
      id: 'ev-2',
      sequence: 2,
      ledgerSequence: 101,
      txHash: '0xaaa2',
      type: 'deposit',
      version: 1,
      timestamp: '2026-01-01T00:01:00Z',
      payload: { vaultId: 'vault-1', walletAddress: 'wallet-bob', amount: 500 },
    },
    {
      id: 'ev-3',
      sequence: 3,
      ledgerSequence: 102,
      txHash: '0xaaa3',
      type: 'yield',
      version: 1,
      timestamp: '2026-01-01T00:02:00Z',
      payload: { vaultId: 'vault-1', amount: 75 },
    },
    {
      id: 'ev-4',
      sequence: 4,
      ledgerSequence: 103,
      txHash: '0xaaa4',
      type: 'quest_complete',
      version: 1,
      timestamp: '2026-01-01T00:03:00Z',
      payload: { questId: 'quest-deposit-first', walletAddress: 'wallet-alice' },
    },
    {
      id: 'ev-5',
      sequence: 5,
      ledgerSequence: 104,
      txHash: '0xaaa5',
      type: 'withdraw',
      version: 1,
      timestamp: '2026-01-01T00:04:00Z',
      payload: { vaultId: 'vault-1', walletAddress: 'wallet-bob', amount: 200 },
    },
  ];

  describe('Normal Path', () => {
    it('replays events in deterministic sequence and updates derived projections accurately', async () => {
      const engine = new VersionedEventReplayEngine();
      const result = await engine.replay(sampleEvents, maintainerOptions);

      expect(result.status).toBe('completed');
      expect(result.eventsReplayed).toBe(5);
      expect(result.checkpointSequence).toBe(5);

      const state = engine.getState();
      expect(state.vaults['vault-1']).toEqual({
        totalDeposits: 1300, // 1000 + 500 - 200
        participantCount: 2,
        yieldDistributed: 75,
      });

      expect(state.users['wallet-alice']).toEqual({
        totalDeposited: 1000,
        rewardsClaimed: 0,
        completedQuests: ['quest-deposit-first'],
      });

      expect(state.users['wallet-bob']).toEqual({
        totalDeposited: 300, // 500 - 200
        rewardsClaimed: 0,
        completedQuests: [],
      });

      expect(typeof result.stateChecksum).toBe('string');
      expect(result.stateChecksum.length).toBe(64);
    });

    it('guarantees replay determinism: replaying twice yields identical state checksum', async () => {
      const engine1 = new VersionedEventReplayEngine();
      const res1 = await engine1.replay(sampleEvents, maintainerOptions);

      const engine2 = new VersionedEventReplayEngine();
      const res2 = await engine2.replay(sampleEvents, maintainerOptions);

      expect(res1.stateChecksum).toBe(res2.stateChecksum);
      expect(engine1.getState()).toEqual(engine2.getState());
    });
  });

  describe('Failure Path', () => {
    it('halts replay when an out-of-order sequence gap is detected', async () => {
      const gappedEvents: StoredEvent[] = [
        sampleEvents[0], // seq 1
        sampleEvents[2], // seq 3 (seq 2 missing!)
      ];

      const engine = new VersionedEventReplayEngine();
      const result = await engine.replay(gappedEvents, maintainerOptions);

      expect(result.status).toBe('failed');
      expect(result.error?.code).toBe('SEQUENCE_GAP');
      expect(result.error?.sequence).toBe(3);
      expect(result.checkpointSequence).toBe(1);
    });

    it('quarantines poison event on invariant violation (e.g. withdraw exceeds balance)', async () => {
      const poisonEvents: StoredEvent[] = [
        sampleEvents[0], // Alice deposits 1000
        {
          id: 'ev-poison',
          sequence: 2,
          ledgerSequence: 105,
          txHash: '0xpoison',
          type: 'withdraw',
          version: 1,
          timestamp: '2026-01-01T00:05:00Z',
          payload: { vaultId: 'vault-1', walletAddress: 'wallet-alice', amount: 5000 }, // Overdraft!
        },
      ];

      const engine = new VersionedEventReplayEngine();
      const result = await engine.replay(poisonEvents, maintainerOptions);

      expect(result.status).toBe('quarantined');
      expect(result.error?.code).toBe('INVARIANT_VIOLATION');
      expect(result.checkpointSequence).toBe(1);
      expect(engine.getState().vaults['vault-1'].totalDeposits).toBe(1000); // Unaltered
    });

    it('quarantines events with forward schema versions exceeding target projection', async () => {
      const forwardVersionEvents: StoredEvent[] = [
        sampleEvents[0],
        {
          id: 'ev-v2',
          sequence: 2,
          ledgerSequence: 106,
          txHash: '0xv2',
          type: 'deposit',
          version: 2, // Requires schema v2
          timestamp: '2026-01-01T00:06:00Z',
          payload: { vaultId: 'vault-1', walletAddress: 'wallet-charlie', amount: 200 },
        },
      ];

      const engine = new VersionedEventReplayEngine();
      const result = await engine.replay(forwardVersionEvents, {
        ...maintainerOptions,
        targetProjectionVersion: 1, // Target is v1
      });

      expect(result.status).toBe('quarantined');
      expect(result.error?.code).toBe('FORWARD_VERSION_UNSUPPORTED');
    });

    it('forbids version downgrade unless explicit allowDowngrade flag is granted', async () => {
      const initialV2State = createInitialProjections(2);
      const engine = new VersionedEventReplayEngine(initialV2State);

      await expect(
        engine.replay(sampleEvents, {
          ...maintainerOptions,
          targetProjectionVersion: 1,
          allowDowngrade: false,
        })
      ).rejects.toMatchObject({ statusCode: 409, code: 'DOWNGRADE_FORBIDDEN' });

      // Permitted with allowDowngrade
      const downgradeResult = await engine.replay(sampleEvents, {
        ...maintainerOptions,
        targetProjectionVersion: 1,
        allowDowngrade: true,
      });

      expect(downgradeResult.status).toBe('completed');
      expect(downgradeResult.projectionVersion).toBe(1);
    });
  });

  describe('Retry Path', () => {
    it('resumes from committed checkpoint cursor without duplicating side effects', async () => {
      const engine = new VersionedEventReplayEngine();

      // Batch 1: events 1-2
      const batch1 = await engine.replay(sampleEvents.slice(0, 2), maintainerOptions);
      expect(batch1.checkpointSequence).toBe(2);
      expect(engine.getState().vaults['vault-1'].totalDeposits).toBe(1500);

      // Batch 2: resuming with full list from sequence 3
      const batch2 = await engine.replay(sampleEvents, {
        ...maintainerOptions,
        fromSequence: 3,
      });

      expect(batch2.checkpointSequence).toBe(5);
      expect(batch2.eventsReplayed).toBe(3);
      expect(engine.getState().vaults['vault-1'].totalDeposits).toBe(1300);
    });

    it('identifies retryable transient errors for automated retry loops', async () => {
      const engine = new VersionedEventReplayEngine();

      await expect(
        engine.replay(sampleEvents, {
          ...maintainerOptions,
          simulateTransientError: true,
        })
      ).rejects.toMatchObject({
        statusCode: 503,
        code: 'TRANSIENT_IO_ERROR',
        retryable: true,
      });
    });

    it('resumes after operator resolves a quarantined poison event', async () => {
      const engine = new VersionedEventReplayEngine();
      const faultyEvent: StoredEvent = {
        id: 'ev-bad',
        sequence: 2,
        ledgerSequence: 102,
        txHash: '0xbad',
        type: 'withdraw',
        version: 1,
        timestamp: '2026-01-01T00:02:00Z',
        payload: { vaultId: 'vault-1', walletAddress: 'wallet-bob', amount: 9999 },
      };

      const run1 = await engine.replay([sampleEvents[0], faultyEvent], maintainerOptions);
      expect(run1.status).toBe('quarantined');

      // Operator resolves quarantine and provides valid replacement event
      engine.resolveQuarantinedEvent('ev-bad');
      const correctedEvent: StoredEvent = {
        ...faultyEvent,
        id: 'ev-good',
        payload: { vaultId: 'vault-1', walletAddress: 'wallet-alice', amount: 100 },
      };

      const run2 = await engine.replay([correctedEvent], {
        ...maintainerOptions,
        fromSequence: 2,
      });

      expect(run2.status).toBe('completed');
      expect(run2.checkpointSequence).toBe(2);
      expect(engine.getState().vaults['vault-1'].totalDeposits).toBe(900);
    });
  });

  describe('Authorization Path', () => {
    it('rejects unauthenticated requests with 401', async () => {
      const engine = new VersionedEventReplayEngine();
      await expect(
        engine.replay(sampleEvents, {
          ...maintainerOptions,
          actorRole: 'public',
          actorSubject: '',
        })
      ).rejects.toMatchObject({ statusCode: 401, code: 'UNAUTHORIZED' });
    });

    it('rejects non-maintainer / standard user roles with 403 Forbidden', async () => {
      const engine = new VersionedEventReplayEngine();
      await expect(
        engine.replay(sampleEvents, {
          ...maintainerOptions,
          actorRole: 'user',
          actorSubject: 'wallet-alice',
        })
      ).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
    });

    it('rejects requests missing an audited reason', async () => {
      const engine = new VersionedEventReplayEngine();
      await expect(
        engine.replay(sampleEvents, {
          ...maintainerOptions,
          reason: '  ',
        })
      ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_REASON' });
    });
  });
});
