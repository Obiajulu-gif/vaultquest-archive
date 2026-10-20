import { describe, it, expect, beforeEach } from "vitest";
import { SearchIndexService } from "../src/services/search/searchIndexService.js";
import type { SearchIndexDocument } from "../src/services/search/types.js";

describe("SearchIndexService", () => {
  let service: SearchIndexService;

  const mockPublicVault: SearchIndexDocument = {
    id: "vault:v1",
    recordType: "vault",
    recordId: "v1",
    title: "USDC Stable Yield Vault",
    description: "Low-risk yield pool for USDC savers",
    asset: "USDC",
    network: "Stellar",
    status: "active",
    ownerWallet: "GADMIN111",
    visibility: "public",
    searchableText: "",
    version: 1,
    sourceUpdatedAt: new Date("2026-09-01"),
    indexedAt: new Date(),
  };

  const mockInactiveVault: SearchIndexDocument = {
    id: "vault:v2",
    recordType: "vault",
    recordId: "v2",
    title: "Deprecated XLM Vault",
    description: "Quarantined pool pending settlement",
    asset: "XLM",
    network: "Stellar",
    status: "inactive",
    ownerWallet: "GADMIN111",
    visibility: "maintainer_only",
    requiredRoles: ["maintainer"],
    searchableText: "",
    version: 1,
    sourceUpdatedAt: new Date("2026-09-02"),
    indexedAt: new Date(),
  };

  const mockUnlistedVault: SearchIndexDocument = {
    id: "vault:v3",
    recordType: "vault",
    recordId: "v3",
    title: "Secret VIP Pool",
    description: "Unlisted test pool",
    asset: "USDC",
    network: "Stellar",
    status: "active",
    ownerWallet: "GADMIN111",
    visibility: "unlisted",
    searchableText: "",
    version: 1,
    sourceUpdatedAt: new Date("2026-09-03"),
    indexedAt: new Date(),
  };

  const mockUserSavedPool: SearchIndexDocument = {
    id: "saved_pool:guser1:p1",
    recordType: "saved_pool",
    recordId: "guser1:p1",
    title: "My Favorite USDC Pool",
    asset: "USDC",
    status: "active",
    ownerWallet: "GUSER1",
    visibility: "owner_only",
    searchableText: "",
    version: 1,
    sourceUpdatedAt: new Date("2026-09-04"),
    indexedAt: new Date(),
  };

  const mockOtherUserSavedPool: SearchIndexDocument = {
    id: "saved_pool:guser2:p2",
    recordType: "saved_pool",
    recordId: "guser2:p2",
    title: "Secret Portfolio",
    asset: "XLM",
    status: "active",
    ownerWallet: "GUSER2",
    visibility: "owner_only",
    searchableText: "",
    version: 1,
    sourceUpdatedAt: new Date("2026-09-05"),
    indexedAt: new Date(),
  };

  const mockPermissionScopedDoc: SearchIndexDocument = {
    id: "settlement:s1",
    recordType: "settlement",
    recordId: "s1",
    title: "Internal Audit Settlement Ledger",
    description: "Requires audit read permission",
    visibility: "permission_scoped",
    requiredPermissions: ["admin.audit.read"],
    searchableText: "",
    version: 1,
    sourceUpdatedAt: new Date("2026-09-06"),
    indexedAt: new Date(),
  };

  beforeEach(async () => {
    service = new SearchIndexService();
    await service.indexDocuments([
      mockPublicVault,
      mockInactiveVault,
      mockUnlistedVault,
      mockUserSavedPool,
      mockOtherUserSavedPool,
      mockPermissionScopedDoc,
    ]);
  });

  describe("Visibility & Permission Scoping Constraints", () => {
    it("allows anonymous callers to search only public records", async () => {
      const res = await service.search({});
      const ids = res.items.map((i) => i.id);

      expect(ids).toContain("vault:v1");
      expect(ids).not.toContain("vault:v2"); // maintainer_only
      expect(ids).not.toContain("vault:v3"); // unlisted
      expect(ids).not.toContain("saved_pool:guser1:p1"); // owner_only
      expect(ids).not.toContain("saved_pool:guser2:p2"); // owner_only
      expect(ids).not.toContain("settlement:s1"); // permission_scoped
    });

    it("allows wallet owner to discover only their own owner_only records", async () => {
      const res = await service.search({}, { walletAddress: "GUSER1" });
      const ids = res.items.map((i) => i.id);

      expect(ids).toContain("vault:v1"); // public
      expect(ids).toContain("saved_pool:guser1:p1"); // GUSER1's record
      expect(ids).not.toContain("saved_pool:guser2:p2"); // GUSER2's record (never leaks!)
      expect(ids).not.toContain("vault:v2"); // maintainer_only
    });

    it("matches walletAddress case-insensitively for ownership", async () => {
      const res = await service.search({}, { walletAddress: "guser1" });
      const ids = res.items.map((i) => i.id);

      expect(ids).toContain("saved_pool:guser1:p1");
    });

    it("allows maintainers full visibility across all records", async () => {
      const res = await service.search(
        {},
        {
          walletAddress: "GMAINTAINER",
          roles: ["maintainer"],
          permissions: ["admin.audit.read", "admin.export.any"],
        },
      );
      const ids = res.items.map((i) => i.id);

      expect(ids).toContain("vault:v1");
      expect(ids).toContain("vault:v2");
      expect(ids).toContain("vault:v3");
      expect(ids).toContain("saved_pool:guser1:p1");
      expect(ids).toContain("saved_pool:guser2:p2");
      expect(ids).toContain("settlement:s1");
    });

    it("allows users with specific permission to access permission_scoped records", async () => {
      const withoutPerm = await service.search(
        {},
        { walletAddress: "GUSER1", permissions: ["own.data.read"] },
      );
      expect(withoutPerm.items.map((i) => i.id)).not.toContain("settlement:s1");

      const withPerm = await service.search(
        {},
        { walletAddress: "GUSER1", permissions: ["admin.audit.read"] },
      );
      expect(withPerm.items.map((i) => i.id)).toContain("settlement:s1");
    });

    it("hides unlisted records unless includeUnlisted is requested by an authenticated user", async () => {
      const resWithoutFlag = await service.search(
        {},
        { walletAddress: "GUSER1" },
      );
      expect(resWithoutFlag.items.map((i) => i.id)).not.toContain("vault:v3");

      const resWithFlag = await service.search(
        { includeUnlisted: true },
        { walletAddress: "GUSER1" },
      );
      expect(resWithFlag.items.map((i) => i.id)).toContain("vault:v3");
    });

    it("excludes soft-deleted records from all search queries", async () => {
      await service.markDeleted("vault", "v1");
      const res = await service.search({});
      expect(res.items.map((i) => i.id)).not.toContain("vault:v1");
    });
  });

  describe("Query Filtering & Ranking", () => {
    it("filters by text query in title or description", async () => {
      const res = await service.search({ q: "Stable" });
      expect(res.items.length).toBe(1);
      expect(res.items[0].id).toBe("vault:v1");
    });

    it("filters by asset", async () => {
      const res = await service.search(
        { asset: "XLM" },
        { roles: ["maintainer"] },
      );
      for (const item of res.items) {
        expect(item.asset).toBe("XLM");
      }
    });

    it("filters by recordType", async () => {
      const res = await service.search(
        { recordType: "vault" },
        { roles: ["maintainer"] },
      );
      for (const item of res.items) {
        expect(item.recordType).toBe("vault");
      }
    });

    it("supports pagination with offset and limit", async () => {
      const page1 = await service.search({ limit: 1, offset: 0 });
      expect(page1.items.length).toBe(1);
      expect(page1.total).toBeGreaterThanOrEqual(1);

      const page2 = await service.search({ limit: 1, offset: 1 });
      expect(page2.items.length).toBe(0); // Only 1 public record indexed
    });
  });

  describe("Statistics & Lifecycle", () => {
    it("calculates accurate total and breakdown stats", async () => {
      const stats = await service.getStats();
      expect(stats.total).toBe(6);
      expect(stats.byType.vault).toBe(3);
      expect(stats.byType.saved_pool).toBe(2);
      expect(stats.byType.settlement).toBe(1);
      expect(stats.byVisibility.public).toBe(1);
      expect(stats.byVisibility.owner_only).toBe(2);
      expect(stats.byVisibility.maintainer_only).toBe(1);
    });

    it("removes documents completely from index", async () => {
      const removed = await service.removeDocument("vault", "v1");
      expect(removed).toBe(true);

      const doc = await service.getDocument("vault", "v1");
      expect(doc).toBeNull();
    });

    it("clears all index documents", async () => {
      await service.clear();
      const stats = await service.getStats();
      expect(stats.total).toBe(0);
    });
  });
});
