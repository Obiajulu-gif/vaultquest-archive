import { describe, it, expect } from 'vitest';
import {
  isRecordVisible,
  filterVisibleRecords,
  assertRecordAccess,
  fetchRecordWithRetry,
  checkVisibilityConsistency,
  RecordAccessError,
  type Record,
  type VisibilityContext,
} from '../lib/visibility-checks';

describe('Authorization Tests for Hidden and Archived Records (#1109)', () => {
  const aliceContext: VisibilityContext = { viewerId: 'user-alice', viewerRole: 'owner' };
  const bobContext: VisibilityContext = { viewerId: 'user-bob', viewerRole: 'public' };
  const maintainerContext: VisibilityContext = { viewerId: 'maint-1', viewerRole: 'maintainer', includeArchived: true };
  const adminContext: VisibilityContext = { viewerId: 'admin-1', viewerRole: 'admin', includeDeleted: true, includeArchived: true };

  const records: Record[] = [
    {
      id: 'rec-public-active',
      visibility: 'public',
      ownerId: 'user-alice',
      data: { title: 'Public Active Pool', balance: 5000 },
    },
    {
      id: 'rec-public-archived',
      visibility: 'public',
      archived: true,
      archivedAt: '2026-01-01T00:00:00Z',
      ownerId: 'user-alice',
      data: { title: 'Public Archived Vault Round', payout: 1000 },
    },
    {
      id: 'rec-alice-private',
      visibility: 'private',
      ownerId: 'user-alice',
      data: { secretStrategy: 'alpha-arb', balance: 25000 },
    },
    {
      id: 'rec-alice-private-archived',
      visibility: 'private',
      archived: true,
      archivedAt: '2026-03-01T00:00:00Z',
      ownerId: 'user-alice',
      data: { secretStrategy: 'alpha-legacy', balance: 0 },
    },
    {
      id: 'rec-restricted-audit',
      visibility: 'restricted',
      archived: true,
      archivedAt: '2026-02-15T00:00:00Z',
      ownerId: 'system',
      data: { auditLog: 'suspicious activity cluster flagged' },
    },
    {
      id: 'rec-soft-deleted',
      visibility: 'deleted',
      ownerId: 'user-alice',
      data: { note: 'user closed account' },
    },
  ];

  describe('Normal Path', () => {
    it('allows public access to active and archived public records', () => {
      const publicActive = records.find((r) => r.id === 'rec-public-active')!;
      const publicArchived = records.find((r) => r.id === 'rec-public-archived')!;

      expect(isRecordVisible(publicActive, bobContext)).toBe(true);
      expect(isRecordVisible(publicArchived, bobContext)).toBe(true);

      const accessed = assertRecordAccess(publicArchived, bobContext, 'read');
      expect(accessed.id).toBe('rec-public-archived');
    });

    it('allows owners and admins to access private and private-archived records', () => {
      const alicePrivate = records.find((r) => r.id === 'rec-alice-private')!;
      const aliceArchived = records.find((r) => r.id === 'rec-alice-private-archived')!;

      expect(isRecordVisible(alicePrivate, aliceContext)).toBe(true);
      expect(isRecordVisible(aliceArchived, aliceContext)).toBe(true);
      expect(isRecordVisible(alicePrivate, adminContext)).toBe(true);
      expect(isRecordVisible(aliceArchived, adminContext)).toBe(true);

      expect(assertRecordAccess(alicePrivate, aliceContext, 'read').id).toBe('rec-alice-private');
    });

    it('allows maintainers with includeArchived to inspect restricted archived records', () => {
      const restricted = records.find((r) => r.id === 'rec-restricted-audit')!;
      expect(isRecordVisible(restricted, maintainerContext)).toBe(true);
      expect(assertRecordAccess(restricted, maintainerContext, 'read').id).toBe('rec-restricted-audit');
    });
  });

  describe('Failure Path', () => {
    it('hides private records from unauthorized actors returning 404 (zero leakage)', () => {
      const alicePrivate = records.find((r) => r.id === 'rec-alice-private')!;
      expect(isRecordVisible(alicePrivate, bobContext)).toBe(false);

      expect(() => assertRecordAccess(alicePrivate, bobContext, 'read')).toThrowError(
        expect.objectContaining({ statusCode: 404, code: 'NOT_FOUND' })
      );
    });

    it('rejects unprivileged access to restricted records with 403 Forbidden', () => {
      const restricted = records.find((r) => r.id === 'rec-restricted-audit')!;
      expect(isRecordVisible(restricted, bobContext)).toBe(false);

      expect(() => assertRecordAccess(restricted, bobContext, 'read')).toThrowError(
        expect.objectContaining({ statusCode: 403, code: 'FORBIDDEN' })
      );
    });

    it('hides deleted records unless explicitly requested by admin audit context', () => {
      const deleted = records.find((r) => r.id === 'rec-soft-deleted')!;
      expect(isRecordVisible(deleted, bobContext)).toBe(false);
      expect(isRecordVisible(deleted, aliceContext)).toBe(false);
      expect(isRecordVisible(deleted, { viewerId: 'admin', viewerRole: 'admin', includeDeleted: false })).toBe(false);

      // Admin with includeDeleted can view
      expect(isRecordVisible(deleted, adminContext)).toBe(true);
    });

    it('blocks mutation on archived records with 409 ILLEGAL_TRANSITION', () => {
      const publicArchived = records.find((r) => r.id === 'rec-public-archived')!;
      expect(() => assertRecordAccess(publicArchived, aliceContext, 'mutate')).toThrowError(
        expect.objectContaining({ statusCode: 409, code: 'ILLEGAL_TRANSITION' })
      );

      const privateArchived = records.find((r) => r.id === 'rec-alice-private-archived')!;
      expect(() => assertRecordAccess(privateArchived, aliceContext, 'mutate')).toThrowError(
        expect.objectContaining({ statusCode: 409, code: 'ILLEGAL_TRANSITION' })
      );
    });
  });

  describe('Retry Path', () => {
    it('retries on transient token expiration, refreshes token, and successfully recovers', async () => {
      let callCount = 0;
      let tokenRefreshed = false;

      const fetcher = async (ctx: VisibilityContext) => {
        callCount++;
        if (callCount === 1) {
          throw new RecordAccessError('Token expired', 401, 'TOKEN_EXPIRED', true);
        }
        return records.find((r) => r.id === 'rec-public-archived')!;
      };

      const refreshToken = async () => {
        tokenRefreshed = true;
        return 'new-valid-jwt';
      };

      const initialContext: VisibilityContext = {
        viewerId: 'user-alice',
        viewerRole: 'owner',
        isTokenExpired: true,
      };

      const { record, attempts } = await fetchRecordWithRetry(fetcher, initialContext, {
        maxRetries: 3,
        refreshToken,
      });

      expect(attempts).toBe(2);
      expect(tokenRefreshed).toBe(true);
      expect(record?.id).toBe('rec-public-archived');
    });

    it('aborts after exhausting max retries on persistent network error', async () => {
      let attempts = 0;
      const failingFetcher = async () => {
        attempts++;
        const err: any = new Error('Connection reset');
        err.code = 'ECONNRESET';
        throw err;
      };

      await expect(
        fetchRecordWithRetry(failingFetcher, bobContext, { maxRetries: 3, initialDelayMs: 1 })
      ).rejects.toThrow();

      expect(attempts).toBe(3);
    });
  });

  describe('Authorization Path & Multi-Tenant Boundary', () => {
    it('enforces multi-tenant isolation: Bob cannot view Alice’s private or archived-private records', () => {
      const visibleToBob = filterVisibleRecords(records, bobContext);
      expect(visibleToBob.map((r) => r.id)).toEqual(['rec-public-active', 'rec-public-archived']);
      expect(visibleToBob.some((r) => r.id.includes('alice-private'))).toBe(false);
    });

    it('ensures consistent visibility across direct lookup, search, export, and relationships', () => {
      const visibleList = filterVisibleRecords(records, bobContext);
      const searchResults = [...visibleList];
      const exportData = [...visibleList];
      const related = [...visibleList];

      const check = checkVisibilityConsistency(
        records[0], // public
        searchResults,
        exportData,
        related,
        bobContext
      );

      expect(check.consistent).toBe(true);
      expect(check.issues).toHaveLength(0);

      // Simulating a leak in search results
      const leakedSearch = [...searchResults, records.find((r) => r.id === 'rec-alice-private')!];
      const leakedCheck = checkVisibilityConsistency(
        records[0],
        leakedSearch,
        exportData,
        related,
        bobContext
      );

      expect(leakedCheck.consistent).toBe(false);
      expect(leakedCheck.issues[0]).toContain('Search exposed invisible record rec-alice-private');
    });
  });
});
