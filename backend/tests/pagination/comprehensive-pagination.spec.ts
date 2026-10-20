/**
 * Comprehensive cursor pagination tests for Issue #2.
 * 
 * Tests stable pagination under inserts, deletes, and permission changes.
 * Verifies cursors remain deterministic and never leak forbidden records.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { setupTestDatabase, teardownTestDatabase } from "../helpers/db.js";
import {
  CursorPaginationService,
  paginateWithPermissions,
  type PageRequest,
} from "../../src/services/cursorPagination.js";
import { ERROR_CODES } from "../../src/constants.js";
import { AppError } from "../../src/errors.js";

describe("Comprehensive Cursor Pagination Suite", () => {
  let prisma: PrismaClient;
  let cursorService: CursorPaginationService;
  const secret = "test-cursor-secret-key-32bytes!";

  beforeEach(async () => {
    const db = await setupTestDatabase();
    prisma = db.prisma;
    cursorService = new CursorPaginationService({
      secret,
      ttlMs: 3600000,
    });
  });

  afterEach(async () => {
    await teardownTestDatabase(prisma);
  });

  describe("Cursor Encoding and Decoding", () => {
    it("should encode and decode cursor correctly", () => {
      const id = "action-123";
      const sortKey = "2026-10-19T12:00:00.000Z";

      const encoded = cursorService.encodeCursor(id, sortKey);
      expect(encoded).toBeTruthy();
      expect(typeof encoded).toBe("string");

      const decoded = cursorService.decodeCursor(encoded);
      expect(decoded.id).toBe(id);
      expect(decoded.sortKey).toBe(sortKey);
    });

    it("should reject tampered cursors", () => {
      const cursor = cursorService.encodeCursor("action-123", "2026-10-19T12:00:00.000Z");
      const tampered = cursor.slice(0, -5) + "AAAAA";

      expect(() => cursorService.decodeCursor(tampered)).toThrow(AppError);
      expect(() => cursorService.decodeCursor(tampered)).toThrow(ERROR_CODES.INVALID_CURSOR);
    });

    it("should reject expired cursors", () => {
      const shortTtlService = new CursorPaginationService({
        secret,
        ttlMs: 10, // 10ms TTL
      });

      const cursor = shortTtlService.encodeCursor("action-123", "2026-10-19T12:00:00.000Z");
      
      // Wait for expiry
      return new Promise((resolve) => {
        setTimeout(() => {
          expect(() => shortTtlService.decodeCursor(cursor)).toThrow(AppError);
          expect(() => shortTtlService.decodeCursor(cursor)).toThrow(ERROR_CODES.EXPIRED_CURSOR);
          resolve(undefined);
        }, 20);
      });
    });

    it("should reject malformed cursors", () => {
      expect(() => cursorService.decodeCursor("not-base64url")).toThrow(AppError);
      expect(() => cursorService.decodeCursor("YWJj")).toThrow(AppError); // "abc" in base64
    });
  });

  describe("Pagination Under Concurrent Inserts", () => {
    it("should exclude new inserts during pagination", async () => {
      const walletAddress = "GPAGE123";

      // Create initial actions
      const initialActions = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          prisma.actionLedger.create({
            data: {
              idempotencyKey: `action-initial-${i}`,
              walletAddress,
              actionType: "deposit",
              actionPayload: { amount: `${100 * i}` },
              status: "pending",
              createdAt: new Date(Date.now() - (5 - i) * 1000),
            },
          })
        )
      );

      // Fetch first page
      const page1 = await paginateWithPermissions(
        {
          filter: { walletAddress },
          limit: 3,
          cursor: null,
        },
        {
          tableName: "action_ledger",
          idColumn: "id",
          sortColumn: "createdAt",
          sortDirection: "desc",
          permissionCheck: (filter, row) => row.walletAddress === filter.walletAddress,
          queryBuilder: async (filter, cursor, limit) => {
            const where: any = { walletAddress: filter.walletAddress };
            
            if (cursor) {
              where.OR = [
                { createdAt: { lt: new Date(cursor.sortKey) } },
                {
                  createdAt: new Date(cursor.sortKey),
                  id: { lt: cursor.id },
                },
              ];
            }

            return prisma.actionLedger.findMany({
              where,
              orderBy: [{ createdAt: "desc" }, { id: "desc" }],
              take: limit,
            });
          },
        },
        cursorService
      );

      expect(page1.items).toHaveLength(3);
      expect(page1.hasMore).toBe(true);
      expect(page1.nextCursor).toBeTruthy();

      // Insert new actions BETWEEN pages
      await Promise.all(
        Array.from({ length: 3 }, (_, i) =>
          prisma.actionLedger.create({
            data: {
              idempotencyKey: `action-inserted-${i}`,
              walletAddress,
              actionType: "deposit",
              actionPayload: { amount: `${500 + 100 * i}` },
              status: "pending",
              createdAt: new Date(), // Most recent
            },
          })
        )
      );

      // Fetch second page with cursor from page 1
      const page2 = await paginateWithPermissions(
        {
          filter: { walletAddress },
          limit: 3,
          cursor: page1.nextCursor,
        },
        {
          tableName: "action_ledger",
          idColumn: "id",
          sortColumn: "createdAt",
          sortDirection: "desc",
          permissionCheck: (filter, row) => row.walletAddress === filter.walletAddress,
          queryBuilder: async (filter, cursor, limit) => {
            const where: any = { walletAddress: filter.walletAddress };
            
            if (cursor) {
              where.OR = [
                { createdAt: { lt: new Date(cursor.sortKey) } },
                {
                  createdAt: new Date(cursor.sortKey),
                  id: { lt: cursor.id },
                },
              ];
            }

            return prisma.actionLedger.findMany({
              where,
              orderBy: [{ createdAt: "desc" }, { id: "desc" }],
              take: limit,
            });
          },
        },
        cursorService
      );

      expect(page2.items).toHaveLength(2); // Remaining initial actions
      
      // Verify new inserts NOT in page 2 (stable iteration)
      const page2Ids = page2.items.map((a) => a.idempotencyKey);
      expect(page2Ids.every((id) => id.startsWith("action-initial"))).toBe(true);
    });
  });

  describe("Pagination Under Concurrent Deletes", () => {
    it("should continue pagination when cursor row is deleted", async () => {
      const walletAddress = "GDEL123";

      // Create actions
      const actions = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          prisma.actionLedger.create({
            data: {
              idempotencyKey: `action-del-${i}`,
              walletAddress,
              actionType: "deposit",
              actionPayload: { amount: `${100 * i}` },
              status: "pending",
              createdAt: new Date(Date.now() - (6 - i) * 1000),
            },
          })
        )
      );

      // Fetch page 1
      const page1 = await paginateWithPermissions(
        {
          filter: { walletAddress },
          limit: 3,
          cursor: null,
        },
        {
          tableName: "action_ledger",
          idColumn: "id",
          sortColumn: "createdAt",
          sortDirection: "desc",
          permissionCheck: (filter, row) => row.walletAddress === filter.walletAddress,
          queryBuilder: async (filter, cursor, limit) => {
            const where: any = { walletAddress: filter.walletAddress };
            
            if (cursor) {
              where.OR = [
                { createdAt: { lt: new Date(cursor.sortKey) } },
                {
                  createdAt: new Date(cursor.sortKey),
                  id: { lt: cursor.id },
                },
              ];
            }

            return prisma.actionLedger.findMany({
              where,
              orderBy: [{ createdAt: "desc" }, { id: "desc" }],
              take: limit,
            });
          },
        },
        cursorService
      );

      expect(page1.items).toHaveLength(3);
      const lastItemPage1 = page1.items[2];

      // Delete the last item from page 1 (cursor row)
      await prisma.actionLedger.delete({
        where: { id: lastItemPage1.id },
      });

      // Fetch page 2 - should continue from cursor position
      const page2 = await paginateWithPermissions(
        {
          filter: { walletAddress },
          limit: 3,
          cursor: page1.nextCursor,
        },
        {
          tableName: "action_ledger",
          idColumn: "id",
          sortColumn: "createdAt",
          sortDirection: "desc",
          permissionCheck: (filter, row) => row.walletAddress === filter.walletAddress,
          queryBuilder: async (filter, cursor, limit) => {
            const where: any = { walletAddress: filter.walletAddress };
            
            if (cursor) {
              where.OR = [
                { createdAt: { lt: new Date(cursor.sortKey) } },
                {
                  createdAt: new Date(cursor.sortKey),
                  id: { lt: cursor.id },
                },
              ];
            }

            return prisma.actionLedger.findMany({
              where,
              orderBy: [{ createdAt: "desc" }, { id: "desc" }],
              take: limit,
            });
          },
        },
        cursorService
      );

      expect(page2.items.length).toBeGreaterThan(0);
      
      // Verify deleted item not in page 2
      expect(page2.items.every((a) => a.id !== lastItemPage1.id)).toBe(true);
    });
  });

  describe("Permission-Aware Pagination", () => {
    it("should filter forbidden records on every page", async () => {
      const wallet1 = "GPERM1";
      const wallet2 = "GPERM2";

      // Create interleaved actions from two wallets
      await Promise.all([
        ...Array.from({ length: 5 }, (_, i) =>
          prisma.actionLedger.create({
            data: {
              idempotencyKey: `action-w1-${i}`,
              walletAddress: wallet1,
              actionType: "deposit",
              actionPayload: { amount: `${100 * i}` },
              status: "pending",
              createdAt: new Date(Date.now() - (10 - 2 * i) * 1000),
            },
          })
        ),
        ...Array.from({ length: 5 }, (_, i) =>
          prisma.actionLedger.create({
            data: {
              idempotencyKey: `action-w2-${i}`,
              walletAddress: wallet2,
              actionType: "deposit",
              actionPayload: { amount: `${200 * i}` },
              status: "pending",
              createdAt: new Date(Date.now() - (10 - 2 * i - 1) * 1000),
            },
          })
        ),
      ]);

      // Paginate as wallet1
      let cursor: string | null = null;
      const wallet1Actions: any[] = [];

      while (true) {
        const page = await paginateWithPermissions(
          {
            filter: { walletAddress: wallet1 },
            limit: 3,
            cursor,
          },
          {
            tableName: "action_ledger",
            idColumn: "id",
            sortColumn: "createdAt",
            sortDirection: "desc",
            permissionCheck: (filter, row) => row.walletAddress === filter.walletAddress,
            queryBuilder: async (filter, cursor, limit) => {
              const where: any = {};
              
              if (cursor) {
                where.OR = [
                  { createdAt: { lt: new Date(cursor.sortKey) } },
                  {
                    createdAt: new Date(cursor.sortKey),
                    id: { lt: cursor.id },
                  },
                ];
              }

              return prisma.actionLedger.findMany({
                where,
                orderBy: [{ createdAt: "desc" }, { id: "desc" }],
                take: limit,
              });
            },
          },
          cursorService
        );

        wallet1Actions.push(...page.items);
        
        if (!page.hasMore) break;
        cursor = page.nextCursor;
      }

      // Verify only wallet1 actions returned
      expect(wallet1Actions).toHaveLength(5);
      expect(wallet1Actions.every((a) => a.walletAddress === wallet1)).toBe(true);
    });

    it("should handle permission revocations between pages", async () => {
      const wallet = "GREVOKE";

      // Create actions
      const actions = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          prisma.actionLedger.create({
            data: {
              idempotencyKey: `action-revoke-${i}`,
              walletAddress: wallet,
              actionType: "deposit",
              actionPayload: { amount: `${100 * i}` },
              status: "pending",
              createdAt: new Date(Date.now() - (6 - i) * 1000),
            },
          })
        )
      );

      // Fetch page 1 with access granted
      let accessGranted = true;
      
      const page1 = await paginateWithPermissions(
        {
          filter: { walletAddress: wallet },
          limit: 3,
          cursor: null,
        },
        {
          tableName: "action_ledger",
          idColumn: "id",
          sortColumn: "createdAt",
          sortDirection: "desc",
          permissionCheck: (filter, row) => accessGranted && row.walletAddress === filter.walletAddress,
          queryBuilder: async (filter, cursor, limit) => {
            const where: any = { walletAddress: filter.walletAddress };
            
            if (cursor) {
              where.OR = [
                { createdAt: { lt: new Date(cursor.sortKey) } },
                {
                  createdAt: new Date(cursor.sortKey),
                  id: { lt: cursor.id },
                },
              ];
            }

            return prisma.actionLedger.findMany({
              where,
              orderBy: [{ createdAt: "desc" }, { id: "desc" }],
              take: limit,
            });
          },
        },
        cursorService
      );

      expect(page1.items).toHaveLength(3);

      // Revoke access
      accessGranted = false;

      // Fetch page 2 - should return empty (permission revoked)
      const page2 = await paginateWithPermissions(
        {
          filter: { walletAddress: wallet },
          limit: 3,
          cursor: page1.nextCursor,
        },
        {
          tableName: "action_ledger",
          idColumn: "id",
          sortColumn: "createdAt",
          sortDirection: "desc",
          permissionCheck: (filter, row) => accessGranted && row.walletAddress === filter.walletAddress,
          queryBuilder: async (filter, cursor, limit) => {
            const where: any = { walletAddress: filter.walletAddress };
            
            if (cursor) {
              where.OR = [
                { createdAt: { lt: new Date(cursor.sortKey) } },
                {
                  createdAt: new Date(cursor.sortKey),
                  id: { lt: cursor.id },
                },
              ];
            }

            return prisma.actionLedger.findMany({
              where,
              orderBy: [{ createdAt: "desc" }, { id: "desc" }],
              take: limit,
            });
          },
        },
        cursorService
      );

      expect(page2.items).toHaveLength(0);
      expect(page2.hasMore).toBe(false);
    });
  });

  describe("Edge Cases", () => {
    it("should handle empty result set", async () => {
      const page = await paginateWithPermissions(
        {
          filter: { walletAddress: "GNONEXISTENT" },
          limit: 10,
          cursor: null,
        },
        {
          tableName: "action_ledger",
          idColumn: "id",
          sortColumn: "createdAt",
          sortDirection: "desc",
          permissionCheck: () => true,
          queryBuilder: async (filter, cursor, limit) => {
            return prisma.actionLedger.findMany({
              where: { walletAddress: filter.walletAddress },
              orderBy: [{ createdAt: "desc" }, { id: "desc" }],
              take: limit,
            });
          },
        },
        cursorService
      );

      expect(page.items).toHaveLength(0);
      expect(page.hasMore).toBe(false);
      expect(page.nextCursor).toBeNull();
    });

    it("should detect last page correctly", async () => {
      const walletAddress = "GLAST";

      // Create exactly 5 actions
      await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          prisma.actionLedger.create({
            data: {
              idempotencyKey: `action-last-${i}`,
              walletAddress,
              actionType: "deposit",
              actionPayload: { amount: `${100 * i}` },
              status: "pending",
            },
          })
        )
      );

      // Paginate with limit 3
      const page1 = await paginateWithPermissions(
        {
          filter: { walletAddress },
          limit: 3,
          cursor: null,
        },
        {
          tableName: "action_ledger",
          idColumn: "id",
          sortColumn: "createdAt",
          sortDirection: "desc",
          permissionCheck: () => true,
          queryBuilder: async (filter, cursor, limit) => {
            const where: any = { walletAddress: filter.walletAddress };
            
            if (cursor) {
              where.OR = [
                { createdAt: { lt: new Date(cursor.sortKey) } },
                {
                  createdAt: new Date(cursor.sortKey),
                  id: { lt: cursor.id },
                },
              ];
            }

            return prisma.actionLedger.findMany({
              where,
              orderBy: [{ createdAt: "desc" }, { id: "desc" }],
              take: limit,
            });
          },
        },
        cursorService
      );

      expect(page1.items).toHaveLength(3);
      expect(page1.hasMore).toBe(true);

      // Fetch page 2 (last 2 items)
      const page2 = await paginateWithPermissions(
        {
          filter: { walletAddress },
          limit: 3,
          cursor: page1.nextCursor,
        },
        {
          tableName: "action_ledger",
          idColumn: "id",
          sortColumn: "createdAt",
          sortDirection: "desc",
          permissionCheck: () => true,
          queryBuilder: async (filter, cursor, limit) => {
            const where: any = { walletAddress: filter.walletAddress };
            
            if (cursor) {
              where.OR = [
                { createdAt: { lt: new Date(cursor.sortKey) } },
                {
                  createdAt: new Date(cursor.sortKey),
                  id: { lt: cursor.id },
                },
              ];
            }

            return prisma.actionLedger.findMany({
              where,
              orderBy: [{ createdAt: "desc" }, { id: "desc" }],
              take: limit,
            });
          },
        },
        cursorService
      );

      expect(page2.items).toHaveLength(2);
      expect(page2.hasMore).toBe(false);
      expect(page2.nextCursor).toBeNull();
    });
  });
});
