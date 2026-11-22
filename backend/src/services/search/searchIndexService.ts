import type {
  RecordType,
  SearchContext,
  SearchIndexDocument,
  SearchQueryOptions,
  SearchResult,
  VisibilityLevel,
} from "./types.js";

export function normalizeSearchText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export class SearchIndexService {
  private documents: Map<string, SearchIndexDocument> = new Map();

  private makeKey(recordType: RecordType, recordId: string): string {
    return `${recordType}:${recordId.toLowerCase()}`;
  }

  public async indexDocument(doc: SearchIndexDocument): Promise<void> {
    const key = this.makeKey(doc.recordType, doc.recordId);
    const existing = this.documents.get(key);
    if (
      existing &&
      (existing.sourceUpdatedAt.getTime() > doc.sourceUpdatedAt.getTime() ||
        (existing.sourceUpdatedAt.getTime() === doc.sourceUpdatedAt.getTime() &&
          existing.version > doc.version))
    ) {
      return;
    }
    const normalizedTokens = normalizeSearchText(
      [
        doc.title,
        doc.description || "",
        doc.asset || "",
        doc.network || "",
        doc.status || "",
        doc.ownerWallet || "",
      ].join(" "),
    );

    this.documents.set(key, {
      ...doc,
      id: key,
      searchableText: normalizedTokens,
      indexedAt: new Date(),
    });
  }

  public async indexDocuments(docs: SearchIndexDocument[]): Promise<void> {
    for (const doc of docs) {
      await this.indexDocument(doc);
    }
  }

  public async removeDocument(
    recordType: RecordType,
    recordId: string,
  ): Promise<boolean> {
    const key = this.makeKey(recordType, recordId);
    return this.documents.delete(key);
  }

  public async removeDocumentIfUnchanged(
    recordType: RecordType,
    recordId: string,
    version: number,
    sourceUpdatedAt: Date,
  ): Promise<boolean> {
    const key = this.makeKey(recordType, recordId);
    const current = this.documents.get(key);
    if (
      !current ||
      current.version !== version ||
      current.sourceUpdatedAt.getTime() !== sourceUpdatedAt.getTime()
    ) {
      return false;
    }
    return this.documents.delete(key);
  }

  public async markDeleted(
    recordType: RecordType,
    recordId: string,
    deletedAt: Date = new Date(),
  ): Promise<boolean> {
    const key = this.makeKey(recordType, recordId);
    const doc = this.documents.get(key);
    if (!doc) return false;
    doc.deletedAt = deletedAt;
    doc.indexedAt = new Date();
    this.documents.set(key, doc);
    return true;
  }

  public async getDocument(
    recordType: RecordType,
    recordId: string,
  ): Promise<SearchIndexDocument | null> {
    const key = this.makeKey(recordType, recordId);
    const doc = this.documents.get(key);
    if (!doc || doc.deletedAt) return null;
    return doc;
  }

  public async listAllDocuments(): Promise<SearchIndexDocument[]> {
    return Array.from(this.documents.values());
  }

  public isAccessible(
    doc: SearchIndexDocument,
    context?: SearchContext,
    includeUnlisted = false,
  ): boolean {
    if (doc.deletedAt) {
      return false;
    }

    const isMaintainer =
      context?.roles?.includes("maintainer") ||
      context?.permissions?.includes("admin.audit.read") ||
      context?.permissions?.includes("admin.export.any");

    // Maintainers have unrestricted operational visibility across all records
    if (isMaintainer) {
      return true;
    }

    switch (doc.visibility) {
      case "public":
        return true;

      case "unlisted":
        return includeUnlisted && Boolean(context?.walletAddress);

      case "maintainer_only":
        return false;

      case "owner_only": {
        if (!context?.walletAddress || !doc.ownerWallet) {
          return false;
        }
        return (
          context.walletAddress.trim().toLowerCase() ===
          doc.ownerWallet.trim().toLowerCase()
        );
      }

      case "permission_scoped": {
        if (!doc.requiredPermissions || doc.requiredPermissions.length === 0) {
          return false;
        }
        const userPerms = context?.permissions || [];
        return doc.requiredPermissions.some((p) => userPerms.includes(p));
      }

      default:
        return false;
    }
  }

  public async search(
    options: SearchQueryOptions,
    context?: SearchContext,
  ): Promise<SearchResult> {
    const start = performance.now();
    const query = (options.q || "").trim().toLowerCase();
    const queryTerms = query ? query.split(/\s+/).filter(Boolean) : [];

    const allowedTypes = options.recordType
      ? Array.isArray(options.recordType)
        ? options.recordType
        : [options.recordType]
      : null;

    const matched: Array<{ doc: SearchIndexDocument; score: number }> = [];

    for (const doc of this.documents.values()) {
      if (!this.isAccessible(doc, context, options.includeUnlisted)) {
        continue;
      }

      if (allowedTypes && !allowedTypes.includes(doc.recordType)) {
        continue;
      }

      if (
        options.asset &&
        doc.asset?.toLowerCase() !== options.asset.toLowerCase()
      ) {
        continue;
      }

      if (
        options.network &&
        doc.network?.toLowerCase() !== options.network.toLowerCase()
      ) {
        continue;
      }

      if (
        options.status &&
        doc.status?.toLowerCase() !== options.status.toLowerCase()
      ) {
        continue;
      }

      let score = 0;
      if (queryTerms.length > 0) {
        const titleLower = doc.title.toLowerCase();
        const fullText = doc.searchableText;

        const allTermsMatch = queryTerms.every((term) =>
          fullText.includes(term),
        );
        if (!allTermsMatch) {
          continue;
        }

        // Relevance scoring
        if (titleLower === query) {
          score += 100;
        } else if (titleLower.startsWith(query)) {
          score += 50;
        } else if (titleLower.includes(query)) {
          score += 25;
        }

        for (const term of queryTerms) {
          if (titleLower.includes(term)) score += 10;
          if (doc.asset?.toLowerCase() === term) score += 15;
          if (doc.status?.toLowerCase() === term) score += 5;
        }
      } else {
        score = 1;
      }

      matched.push({ doc, score });
    }

    matched.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.doc.sourceUpdatedAt.getTime() - a.doc.sourceUpdatedAt.getTime();
    });

    const offset = Math.max(0, options.offset ?? 0);
    const limit = Math.min(200, Math.max(1, options.limit ?? 50));
    const paged = matched.slice(offset, offset + limit).map((m) => m.doc);
    const executionMs = Math.round((performance.now() - start) * 100) / 100;

    return {
      items: paged,
      total: matched.length,
      limit,
      offset,
      executionMs,
    };
  }

  public async getStats(): Promise<{
    total: number;
    byType: Record<RecordType, number>;
    byVisibility: Record<VisibilityLevel, number>;
  }> {
    const byType: Record<RecordType, number> = {
      vault: 0,
      saved_pool: 0,
      quest: 0,
      settlement: 0,
    };

    const byVisibility: Record<VisibilityLevel, number> = {
      public: 0,
      unlisted: 0,
      owner_only: 0,
      maintainer_only: 0,
      permission_scoped: 0,
    };

    let total = 0;
    for (const doc of this.documents.values()) {
      if (doc.deletedAt) continue;
      total++;
      if (byType[doc.recordType] !== undefined) {
        byType[doc.recordType]++;
      }
      if (byVisibility[doc.visibility] !== undefined) {
        byVisibility[doc.visibility]++;
      }
    }

    return { total, byType, byVisibility };
  }

  public async clear(): Promise<void> {
    this.documents.clear();
  }
}
