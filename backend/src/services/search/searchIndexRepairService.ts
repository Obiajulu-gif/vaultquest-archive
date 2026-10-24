import type { PrismaClient } from "@prisma/client";
import type { Logger } from "pino";
import type {
  RepairAnomaly,
  RepairReport,
  SearchIndexDocument,
} from "./types.js";
import { canonicalJson } from "../../utils/canonicalJson.js";
import { normalizeSearchText, type SearchIndexService } from "./searchIndexService.js";
import {
  type QuestHookInput,
  type SavedPoolHookInput,
  type SettlementHookInput,
  type VaultInput,
  questToSearchDocument,
  savedPoolToSearchDocument,
  settlementToSearchDocument,
  vaultToSearchDocument,
} from "./searchIndexHooks.js";

export interface SearchSourceLoader {
  loadVaults(limit?: number): Promise<VaultInput[]>;
  loadSavedPools(limit?: number): Promise<SavedPoolHookInput[]>;
  loadQuests(limit?: number): Promise<QuestHookInput[]>;
  loadSettlements(limit?: number): Promise<SettlementHookInput[]>;
}

export class PrismaSearchSourceLoader implements SearchSourceLoader {
  constructor(private readonly prisma: PrismaClient) {}

  public async loadVaults(limit?: number): Promise<VaultInput[]> {
    const rows = await this.prisma.poolRegistry.findMany({
      orderBy: { id: "asc" },
      ...(limit === undefined ? {} : { take: limit }),
    });
    return rows.map((r) => ({
      id: r.id,
      name: `Pool ${r.poolAddress.slice(0, 8)}`,
      poolAddress: r.poolAddress,
      admin: r.admin,
      asset: r.asset,
      active: r.active,
      updatedAt: r.updatedAt,
    }));
  }

  public async loadSavedPools(limit?: number): Promise<SavedPoolHookInput[]> {
    const rows = await this.prisma.savedPool.findMany({
      orderBy: { id: "asc" },
      ...(limit === undefined ? {} : { take: limit }),
    });
    return rows.map((r) => ({
      id: r.id,
      walletAddress: r.walletAddress,
      poolId: r.poolId,
      poolName: r.poolName,
      status: r.status,
      asset: r.asset,
      tvl: r.tvl,
      updatedAt: r.updatedAt,
    }));
  }

  public async loadQuests(limit?: number): Promise<QuestHookInput[]> {
    const rows = await this.prisma.userQuest.findMany({
      orderBy: { id: "asc" },
      ...(limit === undefined ? {} : { take: limit }),
    });
    return rows.map((r) => ({
      id: r.id,
      walletAddress: r.walletAddress,
      questId: r.questId,
      status: r.status,
      progress: r.progress,
      target: r.target,
      updatedAt: r.updatedAt,
    }));
  }

  public async loadSettlements(limit?: number): Promise<SettlementHookInput[]> {
    const rows = await this.prisma.vaultSettlement.findMany({
      orderBy: { id: "asc" },
      ...(limit === undefined ? {} : { take: limit }),
    });
    return rows.map((r) => ({
      id: r.id,
      vaultId: r.vaultId,
      state: r.state,
      settlementType: r.settlementType,
      recipient: r.recipient,
      amount: r.amount,
      txHash: r.txHash,
      updatedAt: r.updatedAt,
    }));
  }
}

export class SearchIndexRepairService {
  private readonly loader: SearchSourceLoader;

  constructor(
    prismaOrLoader: PrismaClient | SearchSourceLoader,
    private readonly indexService: SearchIndexService,
    private readonly logger?: Logger,
  ) {
    if ("loadVaults" in prismaOrLoader) {
      this.loader = prismaOrLoader;
    } else {
      this.loader = new PrismaSearchSourceLoader(prismaOrLoader);
    }
  }

  public async detectAnomalies(options: {
    limit?: number;
    recordType?: RepairAnomaly["recordType"];
  } = {}): Promise<RepairAnomaly[]> {
    const sourceDocs = await this.loadSourceDocuments(options.limit, options.recordType);
    const allIndexDocs = await this.indexService.listAllDocuments();
    const currentIndexDocs = options.recordType
      ? allIndexDocs.filter((doc) => doc.recordType === options.recordType)
      : allIndexDocs;
    const anomalies = this.findAnomalies(
      sourceDocs,
      currentIndexDocs,
      options.limit === undefined,
    );
    const scoped = options.recordType
      ? anomalies.filter((anomaly) => anomaly.recordType === options.recordType)
      : anomalies;
    return options.limit === undefined ? scoped : scoped.slice(0, options.limit);
  }

  private findAnomalies(
    sourceDocs: Map<string, SearchIndexDocument>,
    currentIndexDocs: SearchIndexDocument[],
    includeOrphans = true,
  ): RepairAnomaly[] {
    const anomalies: RepairAnomaly[] = [];
    const indexDocsMap = new Map(currentIndexDocs.map((d) => [d.id, d]));

    // 1. Check for missing, stale, or visibility-mismatched records
    for (const [id, expectedDoc] of sourceDocs.entries()) {
      const indexedDoc = indexDocsMap.get(id);

      if (!indexedDoc || indexedDoc.deletedAt) {
        anomalies.push({
          recordType: expectedDoc.recordType,
          recordId: expectedDoc.recordId,
          anomalyType: "missing",
          reason: `Record ${id} exists in primary source but is absent from search index`,
          recommendation: "rebuild_from_source",
          sourceVersion: expectedDoc.version,
          expectedVisibility: expectedDoc.visibility,
        });
        continue;
      }

      if (indexedDoc.visibility !== expectedDoc.visibility) {
        anomalies.push({
          recordType: expectedDoc.recordType,
          recordId: expectedDoc.recordId,
          anomalyType: "visibility_mismatch",
          reason: `Visibility mismatch for ${id}: index has '${indexedDoc.visibility}', source expected '${expectedDoc.visibility}'`,
          recommendation:
            indexedDoc.visibility === "public" && expectedDoc.visibility !== "public"
              ? "restrict_visibility"
              : "refresh_visibility",
          sourceVersion: expectedDoc.version,
          indexVersion: indexedDoc.version,
          indexSourceUpdatedAt: indexedDoc.sourceUpdatedAt,
          expectedVisibility: expectedDoc.visibility,
          actualVisibility: indexedDoc.visibility,
        });
        continue;
      }

      const isTitleStale = indexedDoc.title !== expectedDoc.title;
      const isStatusStale = indexedDoc.status !== expectedDoc.status;
      const isAssetStale = (indexedDoc.asset || "") !== (expectedDoc.asset || "");
      const isOwnerStale =
        (indexedDoc.ownerWallet || "").toLowerCase() !==
        (expectedDoc.ownerWallet || "").toLowerCase();
      const isVersionStale = indexedDoc.version < expectedDoc.version;
      const isSourceTimestampStale =
        indexedDoc.sourceUpdatedAt.getTime() < expectedDoc.sourceUpdatedAt.getTime();
      const expectedSearchableText = normalizeSearchText(
        [
          expectedDoc.title,
          expectedDoc.description || "",
          expectedDoc.asset || "",
          expectedDoc.network || "",
          expectedDoc.status || "",
          expectedDoc.ownerWallet || "",
        ].join(" "),
      );
      const isProjectionStale =
        indexedDoc.description !== expectedDoc.description ||
        indexedDoc.network !== expectedDoc.network ||
        indexedDoc.searchableText !== expectedSearchableText ||
        canonicalJson(indexedDoc.metadata ?? null) !== canonicalJson(expectedDoc.metadata ?? null) ||
        canonicalJson(indexedDoc.requiredRoles ?? null) !== canonicalJson(expectedDoc.requiredRoles ?? null) ||
        canonicalJson(indexedDoc.requiredPermissions ?? null) !== canonicalJson(expectedDoc.requiredPermissions ?? null);

      if (
        isTitleStale ||
        isStatusStale ||
        isAssetStale ||
        isOwnerStale ||
        isVersionStale ||
        isSourceTimestampStale ||
        isProjectionStale
      ) {
        anomalies.push({
          recordType: expectedDoc.recordType,
          recordId: expectedDoc.recordId,
          anomalyType: "stale",
          reason: `Stale content in index for ${id}`,
          recommendation: "rebuild_from_source",
          sourceVersion: expectedDoc.version,
          indexVersion: indexedDoc.version,
          indexSourceUpdatedAt: indexedDoc.sourceUpdatedAt,
        });
      }
    }

    // 2. Check for orphaned index entries (exist in index, but no longer in source)
    if (includeOrphans) {
      for (const [id, indexedDoc] of indexDocsMap.entries()) {
        if (indexedDoc.deletedAt) continue;
        if (!sourceDocs.has(id)) {
          anomalies.push({
            recordType: indexedDoc.recordType,
            recordId: indexedDoc.recordId,
            anomalyType: "orphaned",
            reason: `Entry ${id} exists in search index but was deleted or revoked from source of truth`,
            recommendation: "purge_or_review",
            indexVersion: indexedDoc.version,
            indexSourceUpdatedAt: indexedDoc.sourceUpdatedAt,
            actualVisibility: indexedDoc.visibility,
          });
        }
      }
    }

    return anomalies;
  }

  private async loadSourceDocuments(
    limit?: number,
    recordType?: RepairAnomaly["recordType"],
  ): Promise<Map<string, SearchIndexDocument>> {
    const [vaults, savedPools, quests, settlements] = await Promise.all([
      recordType && recordType !== "vault" ? [] : this.loader.loadVaults(limit),
      recordType && recordType !== "saved_pool" ? [] : this.loader.loadSavedPools(limit),
      recordType && recordType !== "quest" ? [] : this.loader.loadQuests(limit),
      recordType && recordType !== "settlement" ? [] : this.loader.loadSettlements(limit),
    ]);
    const sourceDocs = new Map<string, SearchIndexDocument>();
    for (const source of vaults) {
      const doc = vaultToSearchDocument(source);
      sourceDocs.set(doc.id, doc);
    }
    for (const source of savedPools) {
      const doc = savedPoolToSearchDocument(source);
      sourceDocs.set(doc.id, doc);
    }
    for (const source of quests) {
      const doc = questToSearchDocument(source);
      sourceDocs.set(doc.id, doc);
    }
    for (const source of settlements) {
      const doc = settlementToSearchDocument(source);
      sourceDocs.set(doc.id, doc);
    }
    return sourceDocs;
  }

  public async runRepair(): Promise<RepairReport> {
    const startedAt = new Date();
    const startMs = performance.now();

    const sourceDocs = await this.loadSourceDocuments();
    const currentIndexDocs = await this.indexService.listAllDocuments();
    const anomalies = this.findAnomalies(sourceDocs, currentIndexDocs);

    const counts = {
      missing: 0,
      stale: 0,
      visibilityMismatch: 0,
      orphaned: 0,
    };

    const details: RepairReport["details"] = [];

    for (const anomaly of anomalies) {
      const compositeId = `${anomaly.recordType}:${anomaly.recordId.toLowerCase()}`;
      if (anomaly.anomalyType === "missing") {
        counts.missing++;
        const expected = sourceDocs.get(compositeId);
        if (expected) {
          await this.indexService.indexDocument(expected);
          const current = await this.indexService.getDocument(
            anomaly.recordType,
            anomaly.recordId,
          );
          details.push({
            recordType: anomaly.recordType,
            recordId: anomaly.recordId,
            anomalyType: "missing",
            recommendation: anomaly.recommendation,
            actionTaken:
              current?.version === expected.version &&
              current.sourceUpdatedAt.getTime() === expected.sourceUpdatedAt.getTime()
                ? "inserted"
                : "skipped_changed",
          });
        }
      } else if (
        anomaly.anomalyType === "stale" ||
        anomaly.anomalyType === "visibility_mismatch"
      ) {
        if (anomaly.anomalyType === "stale") counts.stale++;
        if (anomaly.anomalyType === "visibility_mismatch") counts.visibilityMismatch++;

        const expected = sourceDocs.get(compositeId);
        if (expected) {
          await this.indexService.indexDocument(expected);
          const current = await this.indexService.getDocument(
            anomaly.recordType,
            anomaly.recordId,
          );
          details.push({
            recordType: anomaly.recordType,
            recordId: anomaly.recordId,
            anomalyType: anomaly.anomalyType,
            recommendation: anomaly.recommendation,
            actionTaken:
              current?.version === expected.version &&
              current.sourceUpdatedAt.getTime() === expected.sourceUpdatedAt.getTime()
                ? "updated"
                : "skipped_changed",
          });
        }
      } else if (anomaly.anomalyType === "orphaned") {
        counts.orphaned++;
        const removed =
          anomaly.indexVersion !== undefined && anomaly.indexSourceUpdatedAt !== undefined
            ? await this.indexService.removeDocumentIfUnchanged(
                anomaly.recordType,
                anomaly.recordId,
                anomaly.indexVersion,
                anomaly.indexSourceUpdatedAt,
              )
            : await this.indexService.removeDocument(
                anomaly.recordType,
                anomaly.recordId,
              );
        details.push({
          recordType: anomaly.recordType,
          recordId: anomaly.recordId,
          anomalyType: "orphaned",
          recommendation: anomaly.recommendation,
          actionTaken: removed ? "deleted" : "skipped_changed",
        });
      }
    }

    const completedAt = new Date();
    const durationMs = Math.round((performance.now() - startMs) * 100) / 100;

    const report: RepairReport = {
      scannedSources: sourceDocs.size,
      scannedIndexEntries: currentIndexDocs.length,
      anomaliesDetected: counts,
      repairedCount: details.filter((detail) => detail.actionTaken !== "skipped_changed").length,
      details,
      startedAt,
      completedAt,
      durationMs,
    };

    if (this.logger) {
      this.logger.info(
        {
          event: "search_index_repair_completed",
          scannedSources: report.scannedSources,
          scannedIndexEntries: report.scannedIndexEntries,
          repairedCount: report.repairedCount,
          anomalies: report.anomaliesDetected,
          durationMs: report.durationMs,
        },
        `Search index repair job completed: repaired ${report.repairedCount} anomalies in ${report.durationMs}ms`,
      );
    }

    return report;
  }
}
