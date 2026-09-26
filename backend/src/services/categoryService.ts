/**
 * Serves the (slowly-changing) list of vault/pool categories, backed by a
 * Redis read-through cache (issue #485). Cache misses fall back to
 * PostgreSQL and repopulate the cache with the configured TTL.
 */

import type { PrismaClient } from "@prisma/client";
import type { CacheService } from "./cacheService.js";

export const CATEGORIES_CACHE_KEY = "categories:list";

export type CategoryRecord = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export class CategoryService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly cacheService?: CacheService,
    private readonly cacheTtlSeconds = 3600
  ) {}

  /**
   * Returns all categories, ordered by name. Reads from Redis when available;
   * otherwise reads straight from PostgreSQL.
   */
  async listCategories(): Promise<CategoryRecord[]> {
    const fetchFromDb = () =>
      this.prisma.category.findMany({ orderBy: { name: "asc" } });

    if (!this.cacheService) {
      return fetchFromDb();
    }

    const cached = await this.cacheService.getOrSet(
      CATEGORIES_CACHE_KEY,
      this.cacheTtlSeconds,
      fetchFromDb
    );

    // Dates survive a real Redis round-trip as ISO strings; normalize them
    // back to Date instances so callers get a consistent shape regardless of
    // whether the value came from cache or the database.
    return cached.map((row) => ({
      ...row,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt)
    }));
  }

  /**
   * Invalidates the cached category list. Call after any write to the
   * `categories` table so the next read repopulates fresh data.
   */
  async invalidateCache(): Promise<void> {
    await this.cacheService?.invalidate(CATEGORIES_CACHE_KEY);
  }
}
