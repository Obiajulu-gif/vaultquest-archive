import { describe, it, expect, beforeEach } from "vitest";
import { SearchIndexService } from "../src/services/search/searchIndexService.js";
import {
  SearchIndexHooks,
  vaultToSearchDocument,
  savedPoolToSearchDocument,
  questToSearchDocument,
  settlementToSearchDocument,
} from "../src/services/search/searchIndexHooks.js";

describe("SearchIndexHooks & Document Mapping", () => {
  let service: SearchIndexService;
  let hooks: SearchIndexHooks;

  beforeEach(() => {
    service = new SearchIndexService();
    hooks = new SearchIndexHooks(service);
  });

  describe("Model to Document Mapping", () => {
    it("maps an active vault to a public search document without leaking sensitive fields", () => {
      const doc = vaultToSearchDocument({
        id: "v123",
        name: "Drip Savings Vault",
        poolAddress: "CDRIPPOOL12345678",
        admin: "GADMINWALLET",
        asset: "USDC",
        active: true,
        strategy: "Weekly Prize Draw",
        tvl: "500000",
      });

      expect(doc.id).toBe("vault:v123");
      expect(doc.recordType).toBe("vault");
      expect(doc.title).toBe("Drip Savings Vault");
      expect(doc.visibility).toBe("public");
      expect(doc.status).toBe("active");
      expect(doc.asset).toBe("USDC");
      expect(doc.ownerWallet).toBe("GADMINWALLET");
      // Sensitive internal salts and wasm hashes should not be present
      expect((doc as any).salt).toBeUndefined();
      expect((doc as any).wasmHash).toBeUndefined();
    });

    it("maps inactive or unlisted vaults to restricted visibility", () => {
      const inactiveDoc = vaultToSearchDocument({
        id: "v_inactive",
        poolAddress: "CPOOLINACTIVE",
        asset: "XLM",
        active: false,
      });
      expect(inactiveDoc.visibility).toBe("maintainer_only");
      expect(inactiveDoc.requiredRoles).toContain("maintainer");

      const unlistedDoc = vaultToSearchDocument({
        id: "v_unlisted",
        poolAddress: "CPOOLUNLISTED",
        asset: "XLM",
        active: true,
        unlisted: true,
      });
      expect(unlistedDoc.visibility).toBe("unlisted");
    });

    it("maps saved pool to owner_only scoped document", () => {
      const doc = savedPoolToSearchDocument({
        id: "sp1",
        walletAddress: "GUSER123",
        poolId: "p99",
        poolName: "My High Yield Pool",
        status: "active",
        asset: "USDC",
        tvl: "10000",
      });

      expect(doc.id).toBe("saved_pool:guser123:p99");
      expect(doc.visibility).toBe("owner_only");
      expect(doc.ownerWallet).toBe("GUSER123");
    });

    it("maps quest to owner_only scoped document", () => {
      const doc = questToSearchDocument({
        id: "q1",
        walletAddress: "GUSER123",
        questId: "quest_early_saver",
        status: "in_progress",
        progress: 50,
        target: 100,
      });

      expect(doc.id).toBe("quest:guser123:quest_early_saver");
      expect(doc.visibility).toBe("owner_only");
      expect(doc.ownerWallet).toBe("GUSER123");
    });

    it("maps settlement based on resolution state", () => {
      const unresolvedDoc = settlementToSearchDocument({
        id: "s1",
        vaultId: "v1",
        state: "Unresolved",
        settlementType: "emergency_refund",
      });
      expect(unresolvedDoc.visibility).toBe("maintainer_only");

      const resolvedDoc = settlementToSearchDocument({
        id: "s2",
        vaultId: "v2",
        state: "Resolved",
        settlementType: "prize_draw_distribution",
        recipient: "GWINNER",
      });
      expect(resolvedDoc.visibility).toBe("public");
    });
  });

  describe("Mutation Lifecycle Hooks", () => {
    it("handles onVaultCreated and indexes document", async () => {
      await hooks.onVaultCreated({
        id: "v_new",
        name: "New Pool",
        poolAddress: "CPOOLNEW",
        asset: "USDC",
        active: true,
      });

      const doc = await service.getDocument("vault", "v_new");
      expect(doc).not.toBeNull();
      expect(doc?.title).toBe("New Pool");
      expect(doc?.visibility).toBe("public");
    });

    it("handles onVaultDeleted by removing document from index", async () => {
      await hooks.onVaultCreated({
        id: "v_del",
        name: "Temporary Pool",
        poolAddress: "CPOOLDEL",
        asset: "USDC",
        active: true,
      });

      await hooks.onVaultDeleted("v_del");
      const doc = await service.getDocument("vault", "v_del");
      expect(doc).toBeNull();
    });

    it("handles onVaultVisibilityChanged when vault is deactivated or unlisted", async () => {
      await hooks.onVaultCreated({
        id: "v_toggle",
        name: "Toggle Pool",
        poolAddress: "CPOOLTOGGLE",
        asset: "USDC",
        active: true,
      });

      await hooks.onVaultVisibilityChanged("v_toggle", false);
      let doc = await service.getDocument("vault", "v_toggle");
      expect(doc?.visibility).toBe("maintainer_only");
      expect(doc?.status).toBe("inactive");

      await hooks.onVaultVisibilityChanged("v_toggle", true, true);
      doc = await service.getDocument("vault", "v_toggle");
      expect(doc?.visibility).toBe("unlisted");
    });

    it("handles onSavedPoolCreated and onSavedPoolDeleted", async () => {
      await hooks.onSavedPoolCreated({
        id: "sp_test",
        walletAddress: "GUSER_A",
        poolId: "pool_42",
        poolName: "Alpha Pool",
        status: "active",
        asset: "USDC",
        tvl: "5000",
      });

      const docId = "guser_a:pool_42";
      let doc = await service.getDocument("saved_pool", docId);
      expect(doc).not.toBeNull();
      expect(doc?.visibility).toBe("owner_only");

      await hooks.onSavedPoolDeleted("GUSER_A", "pool_42");
      doc = await service.getDocument("saved_pool", docId);
      expect(doc).toBeNull();
    });

    it("handles onQuestRevoked and onSettlementUpdated", async () => {
      await hooks.onQuestUpdated({
        id: "q_test",
        walletAddress: "GUSER_B",
        questId: "streak_7_days",
        status: "completed",
        progress: 7,
        target: 7,
      });

      const questDocId = "guser_b:streak_7_days";
      let questDoc = await service.getDocument("quest", questDocId);
      expect(questDoc?.status).toBe("completed");

      await hooks.onQuestRevoked("GUSER_B", "streak_7_days");
      questDoc = await service.getDocument("quest", questDocId);
      expect(questDoc).toBeNull();

      await hooks.onSettlementUpdated({
        id: "settle_1",
        vaultId: "vault_alpha",
        state: "Resolved",
        settlementType: "prize_draw",
        recipient: "GWINNER",
      });

      const settleDoc = await service.getDocument("settlement", "vault_alpha");
      expect(settleDoc?.visibility).toBe("public");
    });
  });
});
