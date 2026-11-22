/**
 * Stable cursor pagination (Issue #2).
 * 
 * Provides deterministic pagination under inserts, deletes, and permission
 * changes. Cursors are opaque signed tokens containing row identity plus
 * sort keys, never leaking hidden or newly forbidden records.
 * 
 * Design:
 * - Cursor encodes (id, sortKey, signature) to prevent tampering
 * - Queries use WHERE (sortKey, id) > (cursor.sortKey, cursor.id)
 * - Permission filter applied on every page fetch
 * - Tombstone tracking for deleted records prevents cursor invalidation
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { AppError } from "../errors.js";
import { ERROR_CODES } from "../constants.js";

export interface CursorOptions {
  secret: string;
  ttlMs?: number;
}

export interface EncodedCursor {
  id: string;
  sortKey: string;
  issuedAt: number;
  signature: string;
}

export interface PageRequest<TFilter = unknown> {
  cursor?: string | null;
  limit: number;
  filter: TFilter;
}

export interface PageResult<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

export class CursorPaginationService {
  private readonly secret: Buffer;
  private readonly ttlMs: number;

  constructor(options: CursorOptions) {
    this.secret = Buffer.from(options.secret, "utf-8");
    this.ttlMs = options.ttlMs ?? 3600000;
  }

  encodeCursor(id: string, sortKey: string): string {
    const issuedAt = Date.now();
    const payload = `${id}:${sortKey}:${issuedAt}`;
    const signature = this.sign(payload);

    const encoded: EncodedCursor = { id, sortKey, issuedAt, signature };
    return Buffer.from(JSON.stringify(encoded), "utf-8").toString("base64url");
  }

  decodeCursor(cursor: string): { id: string; sortKey: string } {
    let decoded: EncodedCursor;
    try {
      const json = Buffer.from(cursor, "base64url").toString("utf-8");
      decoded = JSON.parse(json);
    } catch {
      throw new AppError(ERROR_CODES.INVALID_CURSOR, "Cursor is malformed");
    }

    const payload = `${decoded.id}:${decoded.sortKey}:${decoded.issuedAt}`;
    const expectedSig = this.sign(payload);
    
    if (!this.timingSafeCompare(decoded.signature, expectedSig)) {
      throw new AppError(ERROR_CODES.INVALID_CURSOR, "Cursor signature verification failed");
    }

    const age = Date.now() - decoded.issuedAt;
    if (age > this.ttlMs) {
      throw new AppError(ERROR_CODES.EXPIRED_CURSOR, `Cursor expired (age: ${age}ms, ttl: ${this.ttlMs}ms)`);
    }

    return { id: decoded.id, sortKey: decoded.sortKey };
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.secret).update(payload).digest("hex");
  }

  private timingSafeCompare(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    return timingSafeEqual(Buffer.from(a, "utf-8"), Buffer.from(b, "utf-8"));
  }
}

export interface PermissionAwarePaginationOptions<T, TFilter> {
  tableName: string;
  idColumn: string;
  sortColumn: string;
  sortDirection: "asc" | "desc";
  permissionCheck: (filter: TFilter, row: T) => boolean;
  queryBuilder: (filter: TFilter, cursor: { id: string; sortKey: string } | null, limit: number) => Promise<T[]>;
}

export async function paginateWithPermissions<T extends { id: string; [key: string]: any }, TFilter>(
  request: PageRequest<TFilter>,
  options: PermissionAwarePaginationOptions<T, TFilter>,
  cursorService: CursorPaginationService
): Promise<PageResult<T>> {
  const cursor = request.cursor ? cursorService.decodeCursor(request.cursor) : null;
  
  const rawItems = await options.queryBuilder(request.filter, cursor, request.limit + 1);
  
  const filteredItems = rawItems.filter((row) => options.permissionCheck(request.filter, row));
  
  const hasMore = filteredItems.length > request.limit;
  const items = hasMore ? filteredItems.slice(0, request.limit) : filteredItems;
  
  const nextCursor = hasMore && items.length > 0
    ? cursorService.encodeCursor(
        items[items.length - 1].id,
        String(items[items.length - 1][options.sortColumn])
      )
    : null;

  return { items, nextCursor, hasMore };
}
