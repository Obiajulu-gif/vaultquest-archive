import { describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import {
  FileCheckpointStore,
  InMemoryCheckpointStore,
  OrphanRecord,
  OrphanRepairAdapter,
  OrphanRepairActor,
  OrphanRepairAuthorizationError,
  OrphanRepairCheckpointError,
  rollbackOrphanRepair,
  runOrphanRepair,
} from '../lib/orphan-repair';

function makeOrphans(count: number): OrphanRecord[] {
  return Array.from({ length: count }, (_, idx) => ({
    id: `orphan-${String(idx + 1).padStart(3, '0')}`,
    entityType: idx % 2 === 0 ? 'deposit' : 'ticket',
    parentId: `pool-${idx + 1}`,
    detectedAt: '2026-11-21T00:00:00.000Z',
    reason: 'missing_parent_reference',
  }));
}

const operatorActor: OrphanRepairActor = { id: 'op-1', role: 'operator' };
const auditorActor: OrphanRepairActor = { id: 'aud-1', role: 'auditor' };
const viewerActor: OrphanRepairActor = { id: 'view-1', role: 'viewer' };

describe('Resumable Orphan-Repair Command with Checkpoints', () => {
  describe('Authorization paths', () => {
    it('rejects viewer role for both dry-run and mutation', async () => {
      const store = new InMemoryCheckpointStore();
      const adapter: OrphanRepairAdapter = {
        listOrphans: async () => makeOrphans(1),
        repairRecord: async () => ({ action: 'relink', previousState: {} }),
      };

      await expect(
        runOrphanRepair({
          runId: 'auth-1',
          actor: viewerActor,
          adapter,
          checkpointStore: store,
        })
      ).rejects.toThrow(OrphanRepairAuthorizationError);

      await expect(
        runOrphanRepair({
          runId: 'auth-2',
          actor: viewerActor,
          adapter,
          checkpointStore: store,
          dryRun: true,
        })
      ).rejects.toThrow(OrphanRepairAuthorizationError);
    });

    it('allows auditor for dry-run only and blocks mutation and rollback', async () => {
      const store = new InMemoryCheckpointStore();
      const adapter: OrphanRepairAdapter = {
        listOrphans: async () => makeOrphans(2),
        repairRecord: async () => ({ action: 'relink', previousState: {} }),
        rollbackRecord: async () => {},
      };

      const dryReport = await runOrphanRepair({
        runId: 'auth-dry',
        actor: auditorActor,
        adapter,
        checkpointStore: store,
        dryRun: true,
      });
      expect(dryReport.status).toBe('completed');
      expect(dryReport.dryRun).toBe(true);
      expect(dryReport.checkpoint.rollbackLog).toHaveLength(0);

      await expect(
        runOrphanRepair({
          runId: 'auth-mut',
          actor: auditorActor,
          adapter,
          checkpointStore: store,
          dryRun: false,
        })
      ).rejects.toThrow(OrphanRepairAuthorizationError);

      await expect(
        rollbackOrphanRepair({
          runId: 'auth-dry',
          actor: auditorActor,
          adapter,
          checkpointStore: store,
        })
      ).rejects.toThrow(OrphanRepairAuthorizationError);
    });

    it('allows viewer with explicit orphan:repair permission override', async () => {
      const store = new InMemoryCheckpointStore();
      const adapter: OrphanRepairAdapter = {
        listOrphans: async () => makeOrphans(1),
        repairRecord: async () => ({ action: 'relink', previousState: {} }),
      };

      const report = await runOrphanRepair({
        runId: 'auth-perm',
        actor: { id: 'svc-bot', role: 'viewer', permissions: ['orphan:repair'] },
        adapter,
        checkpointStore: store,
      });
      expect(report.status).toBe('completed');
    });
  });

  describe('Normal execution path', () => {
    it('processes orphans in deterministic ID order and persists checkpoints per batch', async () => {
      const store = new InMemoryCheckpointStore();
      const saveSpy = vi.spyOn(store, 'save');
      const processedOrder: string[] = [];
      const orphans = [makeOrphans(3)[2], makeOrphans(3)[0], makeOrphans(3)[1]];

      const adapter: OrphanRepairAdapter = {
        listOrphans: async () => orphans,
        repairRecord: async (record) => {
          processedOrder.push(record.id);
          return { action: 'relink', previousState: { parentId: record.parentId } };
        },
      };

      const report = await runOrphanRepair({
        runId: 'normal-1',
        actor: operatorActor,
        adapter,
        checkpointStore: store,
        batchSize: 2,
      });

      expect(report.status).toBe('completed');
      expect(report.succeededTotal).toBe(3);
      expect(report.failedTotal).toBe(0);
      expect(processedOrder).toEqual(['orphan-001', 'orphan-002', 'orphan-003']);
      expect(report.checkpoint.rollbackLog).toHaveLength(3);
      // Initial save + 2 batch saves + final save
      expect(saveSpy.mock.calls.length).toBeGreaterThanOrEqual(4);
    });
  });

  describe('Failure and retry paths', () => {
    it('retries transient errors and succeeds before maxRetries', async () => {
      const store = new InMemoryCheckpointStore();
      const attemptsByRecord = new Map<string, number>();

      const adapter: OrphanRepairAdapter = {
        listOrphans: async () => makeOrphans(2),
        repairRecord: async (record) => {
          const count = (attemptsByRecord.get(record.id) ?? 0) + 1;
          attemptsByRecord.set(record.id, count);
          if (record.id === 'orphan-002' && count < 3) {
            throw new Error(`Transient DB timeout #${count}`);
          }
          return { action: 'relink', previousState: {} };
        },
      };

      const report = await runOrphanRepair({
        runId: 'retry-1',
        actor: operatorActor,
        adapter,
        checkpointStore: store,
        maxRetries: 3,
      });

      expect(report.status).toBe('completed');
      expect(attemptsByRecord.get('orphan-002')).toBe(3);
      expect(report.failedTotal).toBe(0);
    });

    it('dead-letters records that exhaust maxRetries and marks run failed', async () => {
      const store = new InMemoryCheckpointStore();
      const adapter: OrphanRepairAdapter = {
        listOrphans: async () => makeOrphans(3),
        repairRecord: async (record) => {
          if (record.id === 'orphan-002') {
            throw new Error('Permanent constraint violation');
          }
          return { action: 'quarantine', previousState: {} };
        },
      };

      const report = await runOrphanRepair({
        runId: 'dead-letter-1',
        actor: operatorActor,
        adapter,
        checkpointStore: store,
        maxRetries: 2,
      });

      expect(report.status).toBe('failed');
      expect(report.succeededTotal).toBe(2);
      expect(report.failedTotal).toBe(1);
      expect(report.deadLetteredTotal).toBe(1);
      expect(report.checkpoint.failedRecords['orphan-002']).toMatchObject({
        attempts: 2,
        deadLettered: true,
        lastError: 'Permanent constraint violation',
      });
    });

    it('halts immediately in paused state when stopOnFailure is enabled', async () => {
      const store = new InMemoryCheckpointStore();
      const visited: string[] = [];

      const adapter: OrphanRepairAdapter = {
        listOrphans: async () => makeOrphans(4),
        repairRecord: async (record) => {
          visited.push(record.id);
          if (record.id === 'orphan-002') {
            throw new Error('Upstream unavailable');
          }
          return { action: 'relink', previousState: {} };
        },
      };

      const report = await runOrphanRepair({
        runId: 'fail-fast-1',
        actor: operatorActor,
        adapter,
        checkpointStore: store,
        maxRetries: 1,
        stopOnFailure: true,
      });

      expect(report.status).toBe('paused');
      expect(visited).toEqual(['orphan-001', 'orphan-002']);
      expect(report.succeededTotal).toBe(1);
    });
  });

  describe('Resumable checkpointing and recovery', () => {
    it('resumes an aborted run without re-processing completed records', async () => {
      const store = new InMemoryCheckpointStore();
      const controller = new AbortController();
      const repairedCalls: string[] = [];

      const adapter: OrphanRepairAdapter = {
        listOrphans: async () => makeOrphans(5),
        repairRecord: async (record, ctx) => {
          repairedCalls.push(`${record.id}:${ctx.idempotencyKey}`);
          if (record.id === 'orphan-002') {
            controller.abort();
          }
          return { action: 'relink', previousState: { parentId: record.parentId } };
        },
      };

      const firstRun = await runOrphanRepair({
        runId: 'resume-1',
        actor: operatorActor,
        adapter,
        checkpointStore: store,
        batchSize: 2,
        signal: controller.signal,
      });

      expect(firstRun.status).toBe('paused');
      expect(firstRun.succeededTotal).toBe(2);

      // Attempting a fresh run without resume=true must fail safely.
      await expect(
        runOrphanRepair({
          runId: 'resume-1',
          actor: operatorActor,
          adapter,
          checkpointStore: store,
          resume: false,
        })
      ).rejects.toThrow(OrphanRepairCheckpointError);

      const resumedRun = await runOrphanRepair({
        runId: 'resume-1',
        actor: operatorActor,
        adapter,
        checkpointStore: store,
        batchSize: 2,
        resume: true,
      });

      expect(resumedRun.status).toBe('completed');
      expect(resumedRun.resumed).toBe(true);
      expect(resumedRun.skippedAlreadyCompleted).toBe(2);
      expect(resumedRun.processedInThisRun).toBe(3);
      expect(resumedRun.succeededTotal).toBe(5);
      // Every orphan repaired exactly once across both runs.
      expect(repairedCalls).toHaveLength(5);
    });

    it('retries dead-lettered records only when retryDeadLettered is true', async () => {
      const store = new InMemoryCheckpointStore();
      let shouldFail = true;

      const adapter: OrphanRepairAdapter = {
        listOrphans: async () => makeOrphans(2),
        repairRecord: async (record) => {
          if (record.id === 'orphan-002' && shouldFail) {
            throw new Error('Temporary outage');
          }
          return { action: 'relink', previousState: {} };
        },
      };

      const first = await runOrphanRepair({
        runId: 'retry-dlq-1',
        actor: operatorActor,
        adapter,
        checkpointStore: store,
        maxRetries: 1,
      });
      expect(first.status).toBe('failed');
      expect(first.deadLetteredTotal).toBe(1);

      shouldFail = false;

      // Without retryDeadLettered, dead-lettered record stays skipped/failed.
      const second = await runOrphanRepair({
        runId: 'retry-dlq-1',
        actor: operatorActor,
        adapter,
        checkpointStore: store,
        resume: true,
        retryDeadLettered: false,
      });
      expect(second.status).toBe('failed');
      expect(second.succeededTotal).toBe(1);

      // With retryDeadLettered, it recovers and completes.
      const third = await runOrphanRepair({
        runId: 'retry-dlq-1',
        actor: operatorActor,
        adapter,
        checkpointStore: store,
        resume: true,
        retryDeadLettered: true,
      });
      expect(third.status).toBe('completed');
      expect(third.succeededTotal).toBe(2);
      expect(third.failedTotal).toBe(0);
    });

    it('persists and reloads checkpoints atomically via FileCheckpointStore', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orphan-repair-'));
      const checkpointFile = path.join(tmpDir, 'checkpoint.json');
      const store = new FileCheckpointStore(checkpointFile);

      try {
        const adapter: OrphanRepairAdapter = {
          listOrphans: async () => makeOrphans(2),
          repairRecord: async () => ({ action: 'relink', previousState: {} }),
        };

        const report = await runOrphanRepair({
          runId: 'file-run-1',
          actor: operatorActor,
          adapter,
          checkpointStore: store,
        });
        expect(report.status).toBe('completed');

        const reloaded = await store.load('file-run-1');
        expect(reloaded?.completedIds).toEqual(['orphan-001', 'orphan-002']);

        // Mismatched runId must throw checkpoint error.
        await expect(store.load('different-run')).rejects.toThrow(
          OrphanRepairCheckpointError
        );
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('Rollback path', () => {
    it('reverts applied repairs in reverse order and is idempotent on re-run', async () => {
      const store = new InMemoryCheckpointStore();
      const rolledBackOrder: string[] = [];

      const adapter: OrphanRepairAdapter = {
        listOrphans: async () => makeOrphans(3),
        repairRecord: async (record) => ({
          action: 'relink',
          previousState: { parentId: record.parentId },
        }),
        rollbackRecord: async (entry) => {
          rolledBackOrder.push(entry.recordId);
        },
      };

      await runOrphanRepair({
        runId: 'rollback-1',
        actor: operatorActor,
        adapter,
        checkpointStore: store,
      });

      const rb1 = await rollbackOrphanRepair({
        runId: 'rollback-1',
        actor: operatorActor,
        adapter,
        checkpointStore: store,
      });
      expect(rb1.status).toBe('rolled_back');
      expect(rb1.rolledBackCount).toBe(3);
      expect(rolledBackOrder).toEqual(['orphan-003', 'orphan-002', 'orphan-001']);

      // Re-running rollback does not double-revert already rolled-back entries.
      const rb2 = await rollbackOrphanRepair({
        runId: 'rollback-1',
        actor: operatorActor,
        adapter,
        checkpointStore: store,
      });
      expect(rb2.rolledBackCount).toBe(0);
    });
  });
});
