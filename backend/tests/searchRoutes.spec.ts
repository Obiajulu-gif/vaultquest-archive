import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { searchRoutes } from "../src/routes/search.js";
import { SearchIndexService } from "../src/services/search/searchIndexService.js";
import { SearchIndexRepairService, type SearchSourceLoader } from "../src/services/search/searchIndexRepairService.js";
import type { Principal, PrincipalResolver } from "../src/middleware/rbac.js";

describe("Search API Routes (/api/search)", () => {
  let app: FastifyInstance;
  let searchService: SearchIndexService;
  let repairService: SearchIndexRepairService;
  let activePrincipal: Principal | null = null;

  const mockLoader: SearchSourceLoader = {
    loadVaults: async () => [
      {
        id: "v1",
        name: "USDC Prize Pool",
        poolAddress: "CPOOL1",
        asset: "USDC",
        active: true,
      },
      {
        id: "v2",
        name: "Restricted Vault",
        poolAddress: "CPOOL2",
        asset: "XLM",
        active: false,
      },
    ],
    loadSavedPools: async () => [
      {
        id: "sp1",
        walletAddress: "GUSER1",
        poolId: "v1",
        poolName: "My USDC Favorite",
        asset: "USDC",
        status: "active",
        tvl: "1000",
      },
      {
        id: "sp2",
        walletAddress: "GUSER2",
        poolId: "v2",
        poolName: "Secret XLM Pool",
        asset: "XLM",
        status: "active",
        tvl: "2000",
      },
    ],
    loadQuests: async () => [],
    loadSettlements: async () => [],
  };

  const testResolver: PrincipalResolver = async () => activePrincipal;

  beforeEach(async () => {
    activePrincipal = null;
    searchService = new SearchIndexService();
    repairService = new SearchIndexRepairService(mockLoader, searchService);

    // Initial repair sync to populate index
    await repairService.runRepair();

    app = Fastify();
    await app.register(
      searchRoutes(
        searchService,
        repairService,
        [testResolver],
        async (req, reply) => {
          if (activePrincipal?.role !== "maintainer" && activePrincipal?.role !== "service") {
            reply.status(403).send({ error: { code: "FORBIDDEN", message: "Forbidden" } });
          }
        },
      ),
    );
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  describe("GET /api/search", () => {
    it("returns only public records for anonymous requests", async () => {
      activePrincipal = null;
      const res = await app.inject({
        method: "GET",
        url: "/api/search?q=pool",
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload);
      expect(json.data.items).toBeDefined();

      const ids = json.data.items.map((i: any) => i.id);
      expect(ids).toContain("vault:v1"); // Public
      expect(ids).not.toContain("vault:v2"); // Inactive -> maintainer_only
      expect(ids).not.toContain("saved_pool:guser1:v1"); // Owner only
      expect(ids).not.toContain("saved_pool:guser2:v2"); // Owner only
    });

    it("returns public records plus caller's own owner_only records", async () => {
      activePrincipal = {
        role: "user",
        subject: "GUSER1",
        walletAddress: "GUSER1",
      };

      const res = await app.inject({
        method: "GET",
        url: "/api/search",
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload);
      const ids = json.data.items.map((i: any) => i.id);

      expect(ids).toContain("vault:v1"); // Public
      expect(ids).toContain("saved_pool:guser1:v1"); // Owned by GUSER1
      expect(ids).not.toContain("saved_pool:guser2:v2"); // Owned by GUSER2 (must NOT leak!)
      expect(ids).not.toContain("vault:v2"); // Inactive
    });

    it("returns all records for maintainers", async () => {
      activePrincipal = {
        role: "maintainer",
        subject: "GADMIN",
        walletAddress: "GADMIN",
      };

      const res = await app.inject({
        method: "GET",
        url: "/api/search",
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload);
      const ids = json.data.items.map((i: any) => i.id);

      expect(ids).toContain("vault:v1");
      expect(ids).toContain("vault:v2");
      expect(ids).toContain("saved_pool:guser1:v1");
      expect(ids).toContain("saved_pool:guser2:v2");
    });

    it("filters results by asset query parameter", async () => {
      activePrincipal = {
        role: "maintainer",
        subject: "GADMIN",
        walletAddress: "GADMIN",
      };

      const res = await app.inject({
        method: "GET",
        url: "/api/search?asset=XLM",
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload);
      for (const item of json.data.items) {
        expect(item.asset).toBe("XLM");
      }
    });
  });

  describe("POST /api/search/repair", () => {
    it("rejects unauthorized repair trigger with 403", async () => {
      activePrincipal = {
        role: "user",
        subject: "GUSER1",
        walletAddress: "GUSER1",
      };

      const res = await app.inject({
        method: "POST",
        url: "/api/search/repair",
      });

      expect(res.statusCode).toBe(403);
    });

    it("allows maintainers to trigger repair job and returns report", async () => {
      activePrincipal = {
        role: "maintainer",
        subject: "GADMIN",
        walletAddress: "GADMIN",
      };

      const res = await app.inject({
        method: "POST",
        url: "/api/search/repair",
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload);
      expect(json.data.scannedSources).toBe(4);
      expect(json.data.repairedCount).toBeDefined();
      expect(json.data.anomaliesDetected).toBeDefined();
    });
  });

  describe("GET /api/search/repair/preview", () => {
    it("requires maintainer permission and returns a bounded recommendation report", async () => {
      activePrincipal = {
        role: "user",
        subject: "GUSER1",
        walletAddress: "GUSER1",
      };
      const unauthorized = await app.inject({
        method: "GET",
        url: "/api/search/repair/preview?type=vault&limit=1",
      });
      expect(unauthorized.statusCode).toBe(403);

      activePrincipal = {
        role: "maintainer",
        subject: "GADMIN",
        walletAddress: "GADMIN",
      };
      const preview = await app.inject({
        method: "GET",
        url: "/api/search/repair/preview?type=vault&limit=1",
      });

      expect(preview.statusCode).toBe(200);
      const report = JSON.parse(preview.payload).data;
      expect(report.dryRun).toBe(true);
      expect(report.complete).toBe(false);
      expect(report.anomalies.length).toBeLessThanOrEqual(1);
      expect(report.count).toBe(report.anomalies.length);
      for (const anomaly of report.anomalies) {
        expect(anomaly.recommendation).toBeTruthy();
      }
    });

    it("identifies stale projection content and recommends a source rebuild", async () => {
      activePrincipal = {
        role: "maintainer",
        subject: "GADMIN",
        walletAddress: "GADMIN",
      };
      const staleVault = {
        id: "vault:v1",
        recordType: "vault" as const,
        recordId: "v1",
        title: "Old title",
        asset: "USDC",
        network: "Stellar",
        status: "active",
        visibility: "public" as const,
        searchableText: "",
        version: 0,
        sourceUpdatedAt: new Date("2020-01-01T00:00:00.000Z"),
        indexedAt: new Date(),
      };
      await searchService.indexDocument(staleVault);

      const preview = await app.inject({
        method: "GET",
        url: "/api/search/repair/preview?type=vault",
      });

      expect(preview.statusCode).toBe(200);
      const anomalies = JSON.parse(preview.payload).data.anomalies;
      expect(anomalies).toContainEqual(
        expect.objectContaining({
          recordId: "v1",
          anomalyType: "stale",
          recommendation: "rebuild_from_source",
        }),
      );
    });
  });

  describe("GET /api/search/stats", () => {
    it("returns total indexed counts and breakdowns", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/search/stats",
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload);
      expect(json.data.total).toBe(4);
      expect(json.data.byType.vault).toBe(2);
      expect(json.data.byType.saved_pool).toBe(2);
      expect(json.data.byVisibility.public).toBe(1);
      expect(json.data.byVisibility.maintainer_only).toBe(1);
      expect(json.data.byVisibility.owner_only).toBe(2);
    });
  });
});
