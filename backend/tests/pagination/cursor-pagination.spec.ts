/**
 * Cursor pagination tests (Issue #2).
 * 
 * Verifies stable pagination under inserts, deletes, permission changes.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { CursorPaginationService, paginateWithPermissions } from "../../src/services/cursorPagination.js";
import { AppError } from "../../src/errors.js";
import { ERROR_CODES } from "../../src/constants.js";

describe("CursorPaginationService", () => {
  let service: CursorPaginationService;

  beforeEach(() => {
    service = new CursorPaginationService({ secret: "test-secret-key-for-pagination" });
  });

  it("encodes and decodes cursor successfully", () => {
    const cursor = service.encodeCursor("action-123", "2026-10-19T12:00:00.000Z");
    const decoded = service.decodeCursor(cursor);

    expect(decoded.id).toBe("action-123");
    expect(decoded.sortKey).toBe("2026-10-19T12:00:00.000Z");
  });

  it("rejects tampered cursor", () => {
    const cursor = service.encodeCursor("action-456", "2026-10-19T13:00:00.000Z");
    const tamperedCursor = cursor.slice(0, -5) + "AAAAA";

    expect(() => service.decodeCursor(tamperedCursor)).toThrow(AppError);
    expect(() => service.decodeCursor(tamperedCursor)).toThrow(ERROR_CODES.INVALID_CURSOR);
  });

  it("rejects malformed cursor", () => {
    expect(() => service.decodeCursor("not-a-cursor")).toThrow(AppError);
    expect(() => service.decodeCursor("not-a-cursor")).toThrow(ERROR_CODES.INVALID_CURSOR);
  });

  it("rejects expired cursor", () => {
    const shortTtl = new CursorPaginationService({ secret: "test-secret", ttlMs: 100 });
    const cursor = shortTtl.encodeCursor("action-789", "2026-10-19T14:00:00.000Z");

    return new Promise((resolve) => {
      setTimeout(() => {
        expect(() => shortTtl.decodeCursor(cursor)).toThrow(AppError);
        expect(() => shortTtl.decodeCursor(cursor)).toThrow(ERROR_CODES.EXPIRED_CURSOR);
        resolve();
      }, 150);
    });
  });
});

describe("paginateWithPermissions", () => {
  let service: CursorPaginationService;

  type TestRow = { id: string; createdAt: string; walletAddress: string; amount: number };
  type TestFilter = { walletAddress: string };

  const mockData: TestRow[] = [
    { id: "1", createdAt: "2026-10-19T10:00:00.000Z", walletAddress: "ALICE", amount: 100 },
    { id: "2", createdAt: "2026-10-19T11:00:00.000Z", walletAddress: "BOB", amount: 200 },
    { id: "3", createdAt: "2026-10-19T12:00:00.000Z", walletAddress: "ALICE", amount: 300 },
    { id: "4", createdAt: "2026-10-19T13:00:00.000Z", walletAddress: "CHARLIE", amount: 400 },
    { id: "5", createdAt: "2026-10-19T14:00:00.000Z", walletAddress: "ALICE", amount: 500 },
  ];

  beforeEach(() => {
    service = new CursorPaginationService({ secret: "test-secret-key-for-pagination" });
  });

  it("paginates with permission filter applied on every page", async () => {
    const page1 = await paginateWithPermissions(
      { filter: { walletAddress: "ALICE" }, limit: 2, cursor: null },
      {
        tableName: "actions",
        idColumn: "id",
        sortColumn: "createdAt",
        sortDirection: "asc",
        permissionCheck: (filter, row) => row.walletAddress === filter.walletAddress,
        queryBuilder: async (filter, cursor, limit) => {
          let filtered = mockData;
          if (cursor) {
            const cursorIndex = mockData.findIndex((r) => r.id === cursor.id);
            filtered = mockData.slice(cursorIndex + 1);
          }
          return filtered.slice(0, limit);
        },
      },
      service
    );

    expect(page1.items).toHaveLength(2);
    expect(page1.items[0].id).toBe("1");
    expect(page1.items[1].id).toBe("3");
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).toBeDefined();

    const page2 = await paginateWithPermissions(
      { filter: { walletAddress: "ALICE" }, limit: 2, cursor: page1.nextCursor },
      {
        tableName: "actions",
        idColumn: "id",
        sortColumn: "createdAt",
        sortDirection: "asc",
        permissionCheck: (filter, row) => row.walletAddress === filter.walletAddress,
        queryBuilder: async (filter, cursor, limit) => {
          let filtered = mockData;
          if (cursor) {
            const cursorIndex = mockData.findIndex((r) => r.id === cursor.id);
            filtered = mockData.slice(cursorIndex + 1);
          }
          return filtered.slice(0, limit);
        },
      },
      service
    );

    expect(page2.items).toHaveLength(1);
    expect(page2.items[0].id).toBe("5");
    expect(page2.hasMore).toBe(false);
    expect(page2.nextCursor).toBeNull();
  });

  it("never leaks newly forbidden records", async () => {
    let dataSnapshot = [...mockData];

    const page1 = await paginateWithPermissions(
      { filter: { walletAddress: "ALICE" }, limit: 2, cursor: null },
      {
        tableName: "actions",
        idColumn: "id",
        sortColumn: "createdAt",
        sortDirection: "asc",
        permissionCheck: (filter, row) => row.walletAddress === filter.walletAddress,
        queryBuilder: async (filter, cursor, limit) => {
          let filtered = dataSnapshot;
          if (cursor) {
            const cursorIndex = dataSnapshot.findIndex((r) => r.id === cursor.id);
            filtered = dataSnapshot.slice(cursorIndex + 1);
          }
          return filtered.slice(0, limit);
        },
      },
      service
    );

    expect(page1.items).toHaveLength(2);

    dataSnapshot = dataSnapshot.map((row) =>
      row.id === "5" ? { ...row, walletAddress: "BOB" } : row
    );

    const page2 = await paginateWithPermissions(
      { filter: { walletAddress: "ALICE" }, limit: 2, cursor: page1.nextCursor },
      {
        tableName: "actions",
        idColumn: "id",
        sortColumn: "createdAt",
        sortDirection: "asc",
        permissionCheck: (filter, row) => row.walletAddress === filter.walletAddress,
        queryBuilder: async (filter, cursor, limit) => {
          let filtered = dataSnapshot;
          if (cursor) {
            const cursorIndex = dataSnapshot.findIndex((r) => r.id === cursor.id);
            filtered = dataSnapshot.slice(cursorIndex + 1);
          }
          return filtered.slice(0, limit);
        },
      },
      service
    );

    expect(page2.items).toHaveLength(0);
    expect(page2.hasMore).toBe(false);
  });

  it("handles deleted records gracefully", async () => {
    let dataSnapshot = [...mockData];

    const page1 = await paginateWithPermissions(
      { filter: { walletAddress: "ALICE" }, limit: 2, cursor: null },
      {
        tableName: "actions",
        idColumn: "id",
        sortColumn: "createdAt",
        sortDirection: "asc",
        permissionCheck: (filter, row) => row.walletAddress === filter.walletAddress,
        queryBuilder: async (filter, cursor, limit) => {
          let filtered = dataSnapshot;
          if (cursor) {
            const cursorIndex = dataSnapshot.findIndex((r) => r.id === cursor.id);
            filtered = dataSnapshot.slice(cursorIndex + 1);
          }
          return filtered.slice(0, limit);
        },
      },
      service
    );

    dataSnapshot = dataSnapshot.filter((row) => row.id !== "3");

    const page2 = await paginateWithPermissions(
      { filter: { walletAddress: "ALICE" }, limit: 2, cursor: page1.nextCursor },
      {
        tableName: "actions",
        idColumn: "id",
        sortColumn: "createdAt",
        sortDirection: "asc",
        permissionCheck: (filter, row) => row.walletAddress === filter.walletAddress,
        queryBuilder: async (filter, cursor, limit) => {
          let filtered = dataSnapshot;
          if (cursor) {
            const cursorIndex = dataSnapshot.findIndex((r) => r.id === cursor.id);
            filtered = dataSnapshot.slice(cursorIndex + 1);
          }
          return filtered.slice(0, limit);
        },
      },
      service
    );

    expect(page2.items).toHaveLength(1);
    expect(page2.items[0].id).toBe("5");
  });
});
