import { describe, expect, it } from "vitest";
import { AppError } from "../src/errors.js";
import { ERROR_CODES } from "../src/constants.js";
import {
  DeterministicSortService,
  deterministicSortService,
  compareMixedStatus,
  encodeSortCursor,
  decodeSortCursor,
  getEffectiveTimestampMs,
  type MixedRecordOrEvent,
} from "../src/services/deterministicSortService.js";

const WALLET_ALICE = "GALICE" + "A".repeat(50);
const WALLET_BOB = "GBOB" + "B".repeat(52);

describe("Deterministic Sorting for Mixed-Status Records and Events (#997)", () => {
  describe("1. Normal Path & Total Ordering", () => {
    it("sorts mixed-status records by effective lifecycle timestamp (descending)", () => {
      const records: MixedRecordOrEvent[] = [
        {
          id: "rec-pending",
          status: "pending",
          createdAt: new Date("2026-03-01T10:00:00Z"), // 10:00
        },
        {
          id: "rec-confirmed-recent",
          status: "confirmed",
          createdAt: new Date("2026-03-01T09:00:00Z"),
          confirmedAt: new Date("2026-03-01T12:00:00Z"), // 12:00 (newest)
          finalizedLedger: 10500,
        },
        {
          id: "rec-submitted",
          status: "submitted",
          createdAt: new Date("2026-03-01T09:30:00Z"),
          submittedAt: new Date("2026-03-01T11:00:00Z"), // 11:00
        },
        {
          id: "rec-failed",
          status: "failed",
          createdAt: new Date("2026-03-01T08:00:00Z"),
          updatedAt: new Date("2026-03-01T08:30:00Z"), // 08:30 (oldest)
        },
      ];

      const sorted = deterministicSortService.sort(records, "desc");
      expect(sorted.map((r) => r.id)).toEqual([
        "rec-confirmed-recent", // 12:00
        "rec-submitted",        // 11:00
        "rec-pending",          // 10:00
        "rec-failed",           // 08:30
      ]);
    });

    it("breaks ties with status priority rank when effective timestamps are identical", () => {
      const sameTime = new Date("2026-03-01T10:00:00Z");
      const records: MixedRecordOrEvent[] = [
        { id: "r-failed", status: "failed", updatedAt: sameTime },
        { id: "r-confirmed", status: "confirmed", confirmedAt: sameTime },
        { id: "r-pending", status: "pending", createdAt: sameTime },
        { id: "r-submitted", status: "submitted", submittedAt: sameTime },
        { id: "r-reverted", status: "reverted", updatedAt: sameTime },
        { id: "r-orphaned", status: "orphaned", updatedAt: sameTime },
      ];

      const sorted = deterministicSortService.sort(records, "desc");
      // Priority: pending (0) > submitted (1) > confirmed (2) > reverted (3) > orphaned (4) > failed (5)
      expect(sorted.map((r) => r.id)).toEqual([
        "r-pending",
        "r-submitted",
        "r-confirmed",
        "r-reverted",
        "r-orphaned",
        "r-failed",
      ]);
    });

    it("breaks ties with on-chain ledger coordinates and event indices", () => {
      const sameTime = new Date("2026-03-01T10:00:00Z");
      const records: MixedRecordOrEvent[] = [
        {
          id: "tx-ledger-100",
          status: "confirmed",
          confirmedAt: sameTime,
          ledgerSequence: 100,
          eventIndex: 1,
        },
        {
          id: "tx-ledger-200-ev1",
          status: "confirmed",
          confirmedAt: sameTime,
          ledgerSequence: 200,
          eventIndex: 1,
        },
        {
          id: "tx-ledger-200-ev2",
          status: "confirmed",
          confirmedAt: sameTime,
          ledgerSequence: 200,
          eventIndex: 2,
        },
      ];

      const sorted = deterministicSortService.sort(records, "desc");
      expect(sorted.map((r) => r.id)).toEqual([
        "tx-ledger-200-ev2", // ledger 200, event 2
        "tx-ledger-200-ev1", // ledger 200, event 1
        "tx-ledger-100",     // ledger 100
      ]);
    });

    it("breaks ties using Stellar Soroban RPC event TOID ordering", () => {
      const sameTime = new Date("2026-03-01T10:00:00Z");
      const records: MixedRecordOrEvent[] = [
        {
          id: "ev-a",
          status: "confirmed",
          confirmedAt: sameTime,
          sorobanEventId: "0000000000000000100-0000000001",
        },
        {
          id: "ev-b",
          status: "confirmed",
          confirmedAt: sameTime,
          sorobanEventId: "0000000000000000100-0000000002",
        },
      ];

      const sorted = deterministicSortService.sort(records, "desc");
      expect(sorted.map((r) => r.id)).toEqual(["ev-b", "ev-a"]);
    });

    it("strictly breaks ties with unique ID (total ordering)", () => {
      const sameTime = new Date("2026-03-01T10:00:00Z");
      const records: MixedRecordOrEvent[] = [
        { id: "uuid-bravo", status: "confirmed", confirmedAt: sameTime, ledgerSequence: 100 },
        { id: "uuid-alpha", status: "confirmed", confirmedAt: sameTime, ledgerSequence: 100 },
        { id: "uuid-charlie", status: "confirmed", confirmedAt: sameTime, ledgerSequence: 100 },
      ];

      const sortedDesc = deterministicSortService.sort(records, "desc");
      expect(sortedDesc.map((r) => r.id)).toEqual(["uuid-charlie", "uuid-bravo", "uuid-alpha"]);

      const sortedAsc = deterministicSortService.sort(records, "asc");
      expect(sortedAsc.map((r) => r.id)).toEqual(["uuid-alpha", "uuid-bravo", "uuid-charlie"]);
    });

    it("supports ascending sort direction consistently", () => {
      const records: MixedRecordOrEvent[] = [
        { id: "old", status: "confirmed", confirmedAt: new Date("2026-01-01T00:00:00Z") },
        { id: "new", status: "confirmed", confirmedAt: new Date("2026-02-01T00:00:00Z") },
      ];
      const sorted = deterministicSortService.sort(records, "asc");
      expect(sorted.map((r) => r.id)).toEqual(["old", "new"]);
    });
  });

  describe("2. Deterministic Pagination & Cursors", () => {
    it("pages cleanly across a mixed dataset without skipping or duplicating items", () => {
      const records: MixedRecordOrEvent[] = Array.from({ length: 15 }, (_, i) => ({
        id: `item-${String(i).padStart(2, "0")}`,
        status: i % 2 === 0 ? "confirmed" : "pending",
        createdAt: new Date(1700000000000 + i * 1000),
        confirmedAt: i % 2 === 0 ? new Date(1700000000000 + i * 1000) : null,
      }));

      const pageSize = 4;
      const allFetched: MixedRecordOrEvent[] = [];
      let cursor: string | null | undefined = undefined;

      while (true) {
        const page = deterministicSortService.paginate(records, {
          limit: pageSize,
          cursor,
          direction: "desc",
        });

        allFetched.push(...page.items);
        if (!page.hasMore) {
          expect(page.nextCursor).toBeNull();
          break;
        }
        expect(page.nextCursor).not.toBeNull();
        cursor = page.nextCursor;
      }

      expect(allFetched).toHaveLength(15);
      const uniqueIds = new Set(allFetched.map((r) => r.id));
      expect(uniqueIds.size).toBe(15);

      // Verify the order matches full sort
      const expectedFull = deterministicSortService.sort(records, "desc");
      expect(allFetched.map((r) => r.id)).toEqual(expectedFull.map((r) => r.id));
    });

    it("encodes and decodes composite cursors losslessly", () => {
      const record: MixedRecordOrEvent = {
        id: "tx-456",
        status: "confirmed",
        confirmedAt: new Date("2026-03-01T15:30:00.123Z"),
        ledgerSequence: 987654,
      };

      const cursor = encodeSortCursor(record, {
        walletAddress: WALLET_ALICE,
        sortKey: "timeline_v1",
      });

      const decoded = decodeSortCursor(cursor, {
        walletAddress: WALLET_ALICE,
        sortKey: "timeline_v1",
      });

      expect(decoded.id).toBe("tx-456");
      expect(decoded.t).toBe(new Date("2026-03-01T15:30:00.123Z").getTime());
      expect(decoded.s).toBe(2); // confirmed rank
      expect(decoded.l).toBe(987654);
      expect(decoded.w).toBe(WALLET_ALICE);
      expect(decoded.k).toBe("timeline_v1");
    });
  });

  describe("3. Failure Paths & Input Validation", () => {
    it("rejects malformed base64url or non-JSON cursors with INVALID_CURSOR", () => {
      expect(() => decodeSortCursor("!!!not-base64-json!!!")).toThrowError(AppError);
      try {
        decodeSortCursor("bm90LWpzb24="); // base64 of 'not-json'
      } catch (err: any) {
        expect(err.code).toBe(ERROR_CODES.INVALID_CURSOR);
        expect(err.statusCode).toBe(400);
      }
    });

    it("rejects cursors with missing required schema fields", () => {
      const invalid = Buffer.from(JSON.stringify({ v: 2 })).toString("base64url");
      expect(() => decodeSortCursor(invalid)).toThrowError(AppError);
    });

    it("rejects cursor order mismatch when sort key differs with CURSOR_ORDER_MISMATCH", () => {
      const record: MixedRecordOrEvent = { id: "r1", createdAt: new Date() };
      const cursor = encodeSortCursor(record, { sortKey: "ledger_coords_v1" });

      try {
        decodeSortCursor(cursor, { sortKey: "created_at_v2" });
        expect.unreachable("should have thrown");
      } catch (err: any) {
        expect(err.code).toBe(ERROR_CODES.CURSOR_ORDER_MISMATCH);
        expect(err.statusCode).toBe(400);
      }
    });

    it("rejects records missing required ID for deterministic sorting", () => {
      const invalidRecord = { status: "pending", createdAt: new Date() } as any;
      expect(() => compareMixedStatus(invalidRecord, { id: "valid" } as any)).toThrowError(
        "record missing required unique id"
      );
    });

    it("rejects pagination with non-positive limit", () => {
      expect(() =>
        deterministicSortService.paginate([], { limit: 0 })
      ).toThrowError("limit must be greater than 0");
    });
  });

  describe("4. Multi-Tenant Authorization Path", () => {
    it("enforces wallet scope isolation on cursors", () => {
      const record: MixedRecordOrEvent = {
        id: "private-tx-1",
        status: "confirmed",
        confirmedAt: new Date(),
      };

      // Alice generates a cursor scoped to her wallet
      const aliceCursor = encodeSortCursor(record, { walletAddress: WALLET_ALICE });

      // Alice can use her own cursor
      expect(() =>
        decodeSortCursor(aliceCursor, { walletAddress: WALLET_ALICE })
      ).not.toThrow();

      // Bob cannot use Alice's cursor
      expect(() =>
        decodeSortCursor(aliceCursor, { walletAddress: WALLET_BOB })
      ).toThrowError("cursor belongs to a different wallet scope");
    });
  });

  describe("5. Retry, Replay & Concurrency Paths", () => {
    it("is strictly idempotent and reproducible on repeated sort passes", () => {
      const records: MixedRecordOrEvent[] = Array.from({ length: 30 }, (_, i) => ({
        id: `id-${(i * 37) % 30}`,
        status: ["pending", "submitted", "confirmed", "failed"][i % 4],
        createdAt: new Date(1700000000000 + (i % 5) * 1000),
        updatedAt: new Date(1700000000000 + (i % 3) * 1000),
      }));

      const pass1 = deterministicSortService.sort(records, "desc");
      const pass2 = deterministicSortService.sort(records, "desc");
      const pass3 = deterministicSortService.sort(records, "desc");

      expect(pass1.map((r) => r.id)).toEqual(pass2.map((r) => r.id));
      expect(pass2.map((r) => r.id)).toEqual(pass3.map((r) => r.id));
    });

    it("maintains deterministic pagination resumption when cursor is past all items", () => {
      const records: MixedRecordOrEvent[] = [
        { id: "r1", createdAt: new Date("2026-03-01T10:00:00Z") },
      ];
      const pastRecord: MixedRecordOrEvent = {
        id: "r0",
        createdAt: new Date("2026-03-01T09:00:00Z"),
      };
      const pastCursor = encodeSortCursor(pastRecord);

      const res = deterministicSortService.paginate(records, {
        limit: 10,
        cursor: pastCursor,
        direction: "desc",
      });

      expect(res.items).toHaveLength(0);
      expect(res.hasMore).toBe(false);
      expect(res.nextCursor).toBeNull();
    });
  });
});
