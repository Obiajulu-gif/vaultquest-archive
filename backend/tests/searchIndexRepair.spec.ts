import { describe, it, expect, beforeEach } from "vitest";
import { SearchIndexService } from "../src/services/search/searchIndexService.js";
import {
  SearchIndexRepairService,
  type SearchSourceLoader,
} from "../src/services/search/searchIndexRepairService.js";
import {
  vaultToSearchDocument,
  savedPoolToSearchDocument,
} from "../src/services/search/searchIndexHooks.js";

describe("SearchIndexRepairService", () => {
  let indexService: SearchIndexService;
  let mockSourceLoader: SearchSourceLoader;
  let repairService: SearchIndexRepairService;

  let currentVaults: any[];
  let currentSavedPools: any[];
  let currentQuests: any[];
  let currentSettlements: any[];

  beforeEach(() => {
    indexService = new SearchIndexService();

    currentVaults = [
      {
        id: "v1",
        name: "USDC Stable Pool",
        poolAddress: "CPOOL1",
        asset: "USDC",
        active: true,
        version: 1,
        updatedAt: new Date("2026-09-01"),
      },
      {
        id: "v2",
        name: "XLM Drip Vault",
        poolAddress: "CPOOL2",
        asset: "XLM",
        active: false, // Inactive -> maintainer_only
        version: 1,
        updatedAt: new Date("2026-09-01"),
      },
    ];

    currentSavedPools = [
      {
        id: "sp1",
        walletAddress: "GUSER1",
        poolId: "v1",
        poolName: "My USDC",
        asset: "USDC",
        status: "active",
        tvl: "1000",
        version: 1,
        updatedAt: new Date("2026-09-01"),
      },
    ];

    currentQuests = [];
    currentSettlements = [];

    mockSourceLoader = {
      loadVaults: async () => currentVaults,
      loadSavedPools: async () => currentSavedPools,
      loadQuests: async () => currentQuests,
      loadSettlements: async () => currentSettlements,
    };

    repairService = new SearchIndexRepairService(mockSourceLoader, indexService);
  });

  describe("Anomaly Detection", () => {
    it("does not let an older projection overwrite a newer indexed version", async () => {
      const currentDoc = vaultToSearchDocument({
        ...currentVaults[0],
        version: 3,
        updatedAt: new Date("2026-09-03T00:00:00.000Z"),
      });
      const olderDoc = vaultToSearchDocument({
        ...currentVaults[0],
        name: "Older indexed snapshot",
        version: 2,
        updatedAt: new Date("2026-09-02T00:00:00.000Z"),
      });

      await indexService.indexDocument(currentDoc);
      await indexService.indexDocument(olderDoc);

      expect((await indexService.getDocument("vault", "v1"))?.title).toBe(currentDoc.title);
    });

    it("does not purge an orphan snapshot if the index entry changed after detection", async () => {
      const latest = vaultToSearchDocument({
        ...currentVaults[0],
        version: 2,
        updatedAt: new Date("2026-09-02T00:00:00.000Z"),
      });
      await indexService.indexDocument(latest);

      const removed = await indexService.removeDocumentIfUnchanged(
        "vault",
        "v1",
        1,
        new Date("2026-09-01T00:00:00.000Z"),
      );

      expect(removed).toBe(false);
      expect(await indexService.getDocument("vault", "v1")).not.toBeNull();
    });

    it("identifies missing records when index is completely empty", async () => {
      const anomalies = await repairService.detectAnomalies();
      expect(anomalies.length).toBe(3); // 2 vaults + 1 saved pool

      const missingTypes = anomalies.map((a) => a.anomalyType);
      expect(missingTypes.every((t) => t === "missing")).toBe(true);
    });

    it("identifies visibility mismatch when source changes from active to inactive", async () => {
      // Index v1 as active and public
      await indexService.indexDocument(vaultToSearchDocument(currentVaults[0]));
      // Index v2 as public in error (simulating stale index where v2 was deactivated on-chain/DB)
      const staleV2 = vaultToSearchDocument({ ...currentVaults[1], active: true });
      await indexService.indexDocument(staleV2);
      // Index saved pool
      await indexService.indexDocument(savedPoolToSearchDocument(currentSavedPools[0]));

      const anomalies = await repairService.detectAnomalies();
      expect(anomalies).toMatchObject([
        {
          recordId: "v2",
          anomalyType: "visibility_mismatch",
          expectedVisibility: "maintainer_only",
          actualVisibility: "public",
        },
      ]);
    });

    it("identifies stale records when title or content changed in source of truth", async () => {
      // Pre-index v1 with old name
      const oldDoc = vaultToSearchDocument({
        ...currentVaults[0],
        name: "Old Name Pool",
        version: 0,
      });
      await indexService.indexDocument(oldDoc);

      const anomalies = await repairService.detectAnomalies();
      const staleAnomaly = anomalies.find(
        (a) => a.recordId === "v1" && a.anomalyType === "stale",
      );
      expect(staleAnomaly).toBeDefined();
    });

    it("detects projection metadata drift and recommends rebuilding from the source", async () => {
      await indexService.indexDocument(vaultToSearchDocument({
        ...currentVaults[0],
        tvl: "100",
      }));
      currentVaults[0] = { ...currentVaults[0], tvl: "250" };

      const anomaly = (await repairService.detectAnomalies()).find(
        (item) => item.recordId === "v1",
      );

      expect(anomaly).toMatchObject({
        anomalyType: "stale",
        recommendation: "rebuild_from_source",
      });
    });

    it("does not classify unscanned index records as orphaned in a bounded preview", async () => {
      for (const vault of currentVaults) {
        await indexService.indexDocument(vaultToSearchDocument(vault));
      }

      const anomalies = await repairService.detectAnomalies({
        recordType: "vault",
        limit: 1,
      });

      expect(anomalies).toHaveLength(0);
    });

    it("identifies orphaned entries that exist in index but were deleted in database", async () => {
      // Add an orphan to the index
      await indexService.indexDocument({
        id: "vault:v_deleted",
        recordType: "vault",
        recordId: "v_deleted",
        title: "Deleted Vault",
        visibility: "public",
        searchableText: "",
        version: 1,
        sourceUpdatedAt: new Date(),
        indexedAt: new Date(),
      });

      const anomalies = await repairService.detectAnomalies();
      const orphan = anomalies.find(
        (a) => a.recordId === "v_deleted" && a.anomalyType === "orphaned",
      );
      expect(orphan).toBeDefined();
      expect(orphan?.anomalyType).toBe("orphaned");
    });
  });

  describe("Repair Execution & Idempotency", () => {
    it("repairs all anomalies (inserts missing, updates stale, deletes orphaned)", async () => {
      // 1. Pre-index with anomalies:
      // - v1 is stale (title & version)
      const staleV1 = vaultToSearchDocument({
        ...currentVaults[0],
        name: "Outdated USDC Name",
        version: 0,
      });
      await indexService.indexDocument(staleV1);

      // - v2 has visibility mismatch (public in index, maintainer_only in DB)
      const mismatchedV2 = vaultToSearchDocument({
        ...currentVaults[1],
        active: true, // index thinks it is active
      });
      await indexService.indexDocument(mismatchedV2);

      // - An orphaned vault that was deleted from source
      await indexService.indexDocument({
        id: "vault:v_ghost",
        recordType: "vault",
        recordId: "v_ghost",
        title: "Ghost Pool",
        visibility: "public",
        searchableText: "",
        version: 1,
        sourceUpdatedAt: new Date(),
        indexedAt: new Date(),
      });

      // - saved_pool sp1 is missing from index

      // 2. Run Repair
      const report = await repairService.runRepair();

      expect(report.scannedSources).toBe(3);
      expect(report.repairedCount).toBe(4);
      expect(report.anomaliesDetected.missing).toBe(1); // sp1
      expect(report.anomaliesDetected.stale).toBe(1); // v1
      expect(report.anomaliesDetected.visibilityMismatch).toBe(1); // v2
      expect(report.anomaliesDetected.orphaned).toBe(1); // v_ghost

      // 3. Verify repaired index state
      // v1 is updated with new title
      const repairedV1 = await indexService.getDocument("vault", "v1");
      expect(repairedV1?.title).toBe("USDC Stable Pool");

      // v2 visibility mismatch is corrected
      const repairedV2 = await indexService.getDocument("vault", "v2");
      expect(repairedV2?.visibility).toBe("maintainer_only");

      // sp1 is inserted
      const insertedSp1 = await indexService.getDocument("saved_pool", "guser1:v1");
      expect(insertedSp1).toBeDefined();
      expect(insertedSp1?.ownerWallet).toBe("GUSER1");

      // v_ghost is deleted
      const ghost = await indexService.getDocument("vault", "v_ghost");
      expect(ghost).toBeNull();

      // 4. Verify Idempotency: Second run has 0 anomalies
      const secondAnomalies = await repairService.detectAnomalies();
      expect(secondAnomalies.length).toBe(0);

      const secondReport = await repairService.runRepair();
      expect(secondReport.repairedCount).toBe(0);
      expect(secondReport.anomaliesDetected.missing).toBe(0);
      expect(secondReport.anomaliesDetected.stale).toBe(0);
      expect(secondReport.anomaliesDetected.visibilityMismatch).toBe(0);
      expect(secondReport.anomaliesDetected.orphaned).toBe(0);
    });
  });
});
