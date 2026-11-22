import { describe, expect, it, vi } from "vitest";
import { AppError } from "../src/errors.js";
import { ERROR_CODES } from "../src/constants.js";
import type { Principal } from "../src/middleware/rbac.js";
import {
  DataImportService,
  type ImportTarget,
  type SavedPoolRecord,
} from "../src/services/dataImport.js";
import {
  DataExportService,
  type ExportSource,
} from "../src/services/dataExport.js";
import { ImportService } from "../src/services/importService.js";

const ALICE = "GALICE" + "A".repeat(50);
const BOB = "GBOB" + "B".repeat(52);
const MAINTAINER_WALLET = "GADMIN" + "C".repeat(49);

const alicePrincipal: Principal = { role: "user", subject: ALICE, walletAddress: ALICE };
const bobPrincipal: Principal = { role: "user", subject: BOB, walletAddress: BOB };
const maintainerPrincipal: Principal = {
  role: "maintainer",
  subject: MAINTAINER_WALLET,
  walletAddress: MAINTAINER_WALLET,
  permissions: new Set(["admin.export.any"]),
};

function createImportRow(id: string, over: Record<string, unknown> = {}) {
  return {
    pool_id: id,
    pool_name: `Pool ${id}`,
    status: "open",
    tvl: "100",
    asset: "USDC",
    participant_count: 3,
    expected_yield: "4%",
    prize: null,
    opens_at: null,
    locks_at: null,
    draws_at: "2026-03-01T00:00:00.000Z",
    ...over,
  };
}

function createStoredPool(id: string, wallet = ALICE): SavedPoolRecord {
  return {
    id: `row-${id}`,
    walletAddress: wallet,
    poolId: id,
    poolName: `Pool ${id}`,
    status: "open",
    tvl: "100",
    asset: "USDC",
    participantCount: 3,
    expectedYield: "4%",
    prize: null,
    opensAt: null,
    locksAt: null,
    drawsAt: new Date("2026-03-01T00:00:00.000Z"),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function createMockImportTarget(initial: SavedPoolRecord[] = []) {
  const store = new Map<string, SavedPoolRecord>(initial.map((r) => [r.poolId, r]));
  return {
    store,
    writes: 0,
    findByPoolIds: vi.fn(async (_wallet: string, ids: string[]) =>
      ids.flatMap((id) => (store.has(id) ? [store.get(id)!] : []))
    ),
    savePool: vi.fn(async (input: { wallet: string; pool: any }) => {
      const created = !store.has(input.pool.poolId);
      const record = { ...createStoredPool(input.pool.poolId, input.wallet), ...input.pool };
      store.set(input.pool.poolId, record);
      return { record, created };
    }),
  };
}

function createMockExportSource(actions: any[], pools: any[]) {
  return {
    listActions: vi.fn(async () => ({ items: actions, nextCursor: null })),
    listSavedPools: vi.fn(async () => ({ items: pools, nextCursor: null })),
  };
}

describe("Safe Cancellation for Imports and Exports (#987)", () => {
  describe("DataImportService cancellation", () => {
    it("completes normally when cancellation is not triggered", async () => {
      const target = createMockImportTarget();
      const service = new DataImportService(target);

      const records = [createImportRow("p1"), createImportRow("p2")];
      const report = await service.run({
        wallet: ALICE,
        records,
        dryRun: false,
      });

      expect(report.cancelled).toBe(false);
      expect(report.summary.create).toBe(2);
      expect(report.summary.skip).toBe(0);
      expect(target.store.size).toBe(2);
      expect(report.rollback?.delete_pool_ids).toEqual(["p1", "p2"]);
    });

    it("stops processing subsequent rows when signal is aborted mid-run", async () => {
      const target = createMockImportTarget();
      const service = new DataImportService(target);
      const controller = new AbortController();

      // Trigger abort after saving the first pool
      const origSave = target.savePool;
      target.savePool = vi.fn(async (arg) => {
        const res = await origSave(arg);
        if (arg.pool.poolId === "p1") {
          controller.abort();
        }
        return res;
      });

      const records = [
        createImportRow("p1"),
        createImportRow("p2"),
        createImportRow("p3"),
      ];

      const report = await service.run({
        wallet: ALICE,
        records,
        dryRun: false,
        signal: controller.signal,
      });

      expect(report.cancelled).toBe(true);
      expect(report.cancellation_reason).toContain("cancelled");
      expect(report.summary.create).toBe(1);
      expect(report.summary.skip).toBe(2);

      // p1 was applied before abort
      expect(report.rows[0].action).toBe("create");
      expect(report.rows[0].pool_id).toBe("p1");

      // p2 and p3 were marked cancelled and skipped
      expect(report.rows[1].action).toBe("skip");
      expect(report.rows[1].reason).toBe("cancelled");
      expect(report.rows[2].action).toBe("skip");
      expect(report.rows[2].reason).toBe("cancelled");

      // Rollback correctly preserves only what was applied before cancellation
      expect(report.rollback?.delete_pool_ids).toEqual(["p1"]);
      expect(target.store.size).toBe(1);
      expect(target.store.has("p1")).toBe(true);
      expect(target.store.has("p2")).toBe(false);
    });

    it("handles pre-aborted signal safely without applying any rows", async () => {
      const target = createMockImportTarget();
      const service = new DataImportService(target);
      const controller = new AbortController();
      controller.abort();

      const records = [createImportRow("p1"), createImportRow("p2")];
      const report = await service.run({
        wallet: ALICE,
        records,
        dryRun: false,
        signal: controller.signal,
      });

      expect(report.cancelled).toBe(true);
      expect(report.summary.create).toBe(0);
      expect(report.summary.skip).toBe(2);
      expect(target.store.size).toBe(0);
      expect(report.rollback?.delete_pool_ids).toEqual([]);
    });

    it("registers and cancels active run controller via cancelActiveRun", () => {
      const target = createMockImportTarget();
      const service = new DataImportService(target);
      const batchId = "batch-123";
      const controller = new AbortController();

      service.registerActiveController(batchId, controller);
      expect(controller.signal.aborted).toBe(false);

      const cancelled = service.cancelActiveRun(batchId);
      expect(cancelled).toBe(true);
      expect(controller.signal.aborted).toBe(true);

      // Second call returns false (idempotent / already removed)
      expect(service.cancelActiveRun(batchId)).toBe(false);
    });

    it("supports safe rollback of partially applied rows after cancellation (Recovery Path)", async () => {
      const target = createMockImportTarget();
      const service = new DataImportService(target);
      const controller = new AbortController();

      target.savePool = vi.fn(async (arg) => {
        const record = { ...createStoredPool(arg.pool.poolId, arg.wallet), ...arg.pool };
        target.store.set(arg.pool.poolId, record);
        if (arg.pool.poolId === "p1") controller.abort();
        return { record, created: true };
      });

      const report = await service.run({
        wallet: ALICE,
        records: [createImportRow("p1"), createImportRow("p2")],
        dryRun: false,
        signal: controller.signal,
      });

      expect(target.store.has("p1")).toBe(true);

      // Rollback execution using report.rollback
      for (const poolId of report.rollback!.delete_pool_ids) {
        target.store.delete(poolId);
      }
      expect(target.store.size).toBe(0);
    });
  });

  describe("DataExportService cancellation & authorization", () => {
    it("completes export normally without cancellation", async () => {
      const actions = [{ id: "a1", actionType: "deposit", status: "confirmed", createdAt: new Date() }];
      const pools = [createStoredPool("p1")];
      const src = createMockExportSource(actions, pools);
      const service = new DataExportService(src);

      const res = await service.build({ wallet: ALICE, principal: alicePrincipal });
      expect(res.data.actions).toHaveLength(1);
      expect(res.data.saved_pools).toHaveLength(1);
    });

    it("aborts export and throws OPERATION_CANCELLED when signal is aborted", async () => {
      const actions = [{ id: "a1", actionType: "deposit", status: "confirmed", createdAt: new Date() }];
      const pools = [createStoredPool("p1")];
      const src = createMockExportSource(actions, pools);
      const service = new DataExportService(src);

      const controller = new AbortController();
      controller.abort();

      await expect(
        service.build({ wallet: ALICE, principal: alicePrincipal, signal: controller.signal })
      ).rejects.toThrowError(AppError);

      try {
        await service.build({ wallet: ALICE, principal: alicePrincipal, signal: controller.signal });
      } catch (err: any) {
        expect(err.statusCode).toBe(409);
        expect(err.code).toBe(ERROR_CODES.OPERATION_CANCELLED);
      }
    });

    it("registers and cancels active export with owner authorization", () => {
      const src = createMockExportSource([], []);
      const service = new DataExportService(src);
      const exportId = "exp-1";
      const controller = new AbortController();

      service.registerActiveExport(exportId, ALICE, controller);

      // Alice cancels her own export
      const result = service.cancelExport(exportId, alicePrincipal);
      expect(result.cancelled).toBe(true);
      expect(controller.signal.aborted).toBe(true);
    });

    it("rejects cancellation of another user's export by unauthorized caller", () => {
      const src = createMockExportSource([], []);
      const service = new DataExportService(src);
      const exportId = "exp-2";
      const controller = new AbortController();

      service.registerActiveExport(exportId, ALICE, controller);

      // Bob attempts to cancel Alice's export
      expect(() => service.cancelExport(exportId, bobPrincipal)).toThrowError(AppError);
      expect(controller.signal.aborted).toBe(false);
    });

    it("allows maintainer with admin.export.any to cancel any user's export", () => {
      const src = createMockExportSource([], []);
      const service = new DataExportService(src);
      const exportId = "exp-3";
      const controller = new AbortController();

      service.registerActiveExport(exportId, ALICE, controller);

      // Maintainer cancels Alice's export
      const result = service.cancelExport(exportId, maintainerPrincipal);
      expect(result.cancelled).toBe(true);
      expect(controller.signal.aborted).toBe(true);
    });

    it("returns cancelled: false for non-existent or already finished export", () => {
      const src = createMockExportSource([], []);
      const service = new DataExportService(src);
      const result = service.cancelExport("non-existent-id", alicePrincipal);
      expect(result.cancelled).toBe(false);
    });
  });

  describe("ImportService cancellation lifecycle", () => {
    function buildMockPrisma(initialBatch: any) {
      let currentBatch = { ...initialBatch };
      const rows: any[] = [...(initialBatch.rows ?? [])];

      const prisma = {
        importBatch: {
          findUnique: vi.fn(async ({ where }: any) => {
            if (where.id === currentBatch.id) {
              return { ...currentBatch, rows };
            }
            return null;
          }),
          update: vi.fn(async ({ where, data }: any) => {
            if (where.id === currentBatch.id) {
              currentBatch = { ...currentBatch, ...data };
              return { ...currentBatch, rows };
            }
            throw new Error("Batch not found");
          }),
        },
        importRow: {
          updateMany: vi.fn(async ({ where, data }: any) => {
            let count = 0;
            for (const r of rows) {
              if (r.batchId === where.batchId && where.status.in.includes(r.status)) {
                Object.assign(r, data);
                count++;
              }
            }
            return { count };
          }),
        },
        importAuditLog: {
          create: vi.fn(async () => ({})),
        },
      };

      return { prisma, getBatch: () => currentBatch, getRows: () => rows };
    }

    it("cancels a preview batch, quarantines unapplied rows, and updates status", async () => {
      const initial = {
        id: "batch-pending-1",
        target: "vault_winners",
        status: "preview",
        formatVersion: "1.0",
        filename: "import.csv",
        fileSizeBytes: 100,
        rowCount: 2,
        validRowCount: 2,
        quarantinedRowCount: 0,
        duplicateRowCount: 0,
        rolledBackRows: 0,
        createdBy: ALICE,
        createdAt: new Date(),
        updatedAt: new Date(),
        rows: [
          { id: "r1", batchId: "batch-pending-1", rowNumber: 1, status: "preview" },
          { id: "r2", batchId: "batch-pending-1", rowNumber: 2, status: "preview" },
        ],
      };

      const { prisma, getBatch, getRows } = buildMockPrisma(initial);
      const service = new ImportService(prisma as any);

      const res = await service.cancel("batch-pending-1", { walletAddress: ALICE, role: "user" });
      expect(res.alreadyCancelled).toBe(false);
      expect(res.batch.status).toBe("cancelled");

      expect(getBatch().status).toBe("cancelled");
      expect(getRows().every((r) => r.status === "quarantined")).toBe(true);
      expect(getRows()[0].quarantineReason).toBe("commit_failed");
    });

    it("rejects cancellation by unauthorized non-owner caller", async () => {
      const initial = {
        id: "batch-pending-2",
        status: "preview",
        createdBy: ALICE,
        rows: [],
      };
      const { prisma } = buildMockPrisma(initial);
      const service = new ImportService(prisma as any);

      await expect(
        service.cancel("batch-pending-2", { walletAddress: BOB, role: "user" })
      ).rejects.toThrowError("not authorized to cancel this import batch");
    });

    it("allows maintainer role to cancel another user's import batch", async () => {
      const initial = {
        id: "batch-pending-3",
        status: "accepted",
        createdBy: ALICE,
        rows: [{ id: "r1", batchId: "batch-pending-3", rowNumber: 1, status: "accepted" }],
      };
      const { prisma, getBatch } = buildMockPrisma(initial);
      const service = new ImportService(prisma as any);

      const res = await service.cancel("batch-pending-3", {
        walletAddress: MAINTAINER_WALLET,
        role: "maintainer",
      });
      expect(res.alreadyCancelled).toBe(false);
      expect(getBatch().status).toBe("cancelled");
    });

    it("is idempotent when cancelling an already cancelled batch", async () => {
      const initial = {
        id: "batch-cancelled-1",
        status: "cancelled",
        createdBy: ALICE,
        rows: [],
      };
      const { prisma } = buildMockPrisma(initial);
      const service = new ImportService(prisma as any);

      const res = await service.cancel("batch-cancelled-1", { walletAddress: ALICE, role: "user" });
      expect(res.alreadyCancelled).toBe(true);
      expect(res.batch.status).toBe("cancelled");
    });

    it("rejects cancellation on committed or terminal batches with 409 ILLEGAL_TRANSITION", async () => {
      for (const terminalStatus of ["committed", "rolled_back", "partially_rolled_back"]) {
        const initial = {
          id: `batch-${terminalStatus}`,
          status: terminalStatus,
          createdBy: ALICE,
          rows: [],
        };
        const { prisma } = buildMockPrisma(initial);
        const service = new ImportService(prisma as any);

        await expect(
          service.cancel(`batch-${terminalStatus}`, { walletAddress: ALICE, role: "user" })
        ).rejects.toThrowError(AppError);

        try {
          await service.cancel(`batch-${terminalStatus}`, { walletAddress: ALICE, role: "user" });
        } catch (err: any) {
          expect(err.statusCode).toBe(409);
          expect(err.code).toBe(ERROR_CODES.ILLEGAL_TRANSITION);
        }
      }
    });

    it("throws 404 when batch is not found", async () => {
      const { prisma } = buildMockPrisma({ id: "exists", status: "preview", createdBy: ALICE });
      const service = new ImportService(prisma as any);

      await expect(service.cancel("unknown-batch", { walletAddress: ALICE })).rejects.toThrowError(
        "import batch unknown-batch not found"
      );
    });
  });
});
