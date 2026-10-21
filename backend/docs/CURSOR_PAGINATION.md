# Cursor Pagination Guide (Issue #2)

## Overview

Stable cursor pagination that remains deterministic under inserts, deletes, and permission changes. Cursors are signed opaque tokens that never leak hidden or forbidden records.

## Architecture

### CursorPaginationService

Encodes/decodes cursors with cryptographic signature:

```typescript
const service = new CursorPaginationService({
  secret: process.env.CURSOR_SECRET,
  ttlMs: 3600000 // 1 hour
});

const cursor = service.encodeCursor(lastRow.id, lastRow.createdAt.toISOString());
const { id, sortKey } = service.decodeCursor(cursor);
```

### Cursor Structure

```json
{
  "id": "action-uuid",
  "sortKey": "2026-10-19T12:00:00.000Z",
  "issuedAt": 1729342800000,
  "signature": "hmac-sha256-hex"
}
```

Encoded as base64url, signed with HMAC-SHA256.

### Permission-Aware Pagination

```typescript
await paginateWithPermissions(
  { filter: { walletAddress: "GUSER..." }, limit: 20, cursor },
  {
    tableName: "action_ledger",
    idColumn: "id",
    sortColumn: "createdAt",
    sortDirection: "desc",
    permissionCheck: (filter, row) => row.walletAddress === filter.walletAddress,
    queryBuilder: async (filter, cursor, limit) => {
      const where = {
        walletAddress: filter.walletAddress,
        ...(cursor && {
          OR: [
            { createdAt: { lt: cursor.sortKey } },
            { createdAt: cursor.sortKey, id: { lt: cursor.id } }
          ]
        })
      };
      return prisma.actionLedger.findMany({ where, orderBy: { createdAt: "desc" }, take: limit });
    }
  },
  service
);
```

## Query Pattern

### Keyset Pagination

Use composite key (sortKey, id) for stable ordering:

```sql
WHERE (created_at, id) < ($cursor_created_at, $cursor_id)
ORDER BY created_at DESC, id DESC
LIMIT $limit + 1
```

Fetch `limit + 1` rows to detect `hasMore`.

### Index Requirements

Composite index on (sortColumn, id):

```sql
CREATE INDEX action_ledger_pagination_idx 
ON action_ledger(wallet_address, created_at DESC, id DESC);
```

## Security

### Signature Verification

Cursors are signed with HMAC-SHA256. Tampering is detected:

```typescript
const payload = `${id}:${sortKey}:${issuedAt}`;
const signature = createHmac("sha256", secret).update(payload).digest("hex");
```

Timing-safe comparison prevents timing attacks.

### TTL Enforcement

Cursors expire after TTL (default 1 hour):

```typescript
if (Date.now() - decoded.issuedAt > ttlMs) {
  throw new AppError(ERROR_CODES.EXPIRED_CURSOR);
}
```

### Permission Filtering

Permission checks applied on **every page fetch**, not just cursor issuance:

```typescript
const filteredItems = rawItems.filter((row) => 
  options.permissionCheck(request.filter, row)
);
```

## Handling Changes

### Concurrent Inserts

New rows inserted between pages are **not visible** to current cursor:

- Query uses `(sortKey, id) > cursor` condition
- New rows before cursor are excluded
- Stable iteration regardless of inserts

### Concurrent Deletes

Deleted rows are skipped:

- Cursor points to last seen row (may be deleted)
- Query continues from that position
- No cursor invalidation

### Permission Revocations

Newly forbidden rows are filtered out:

- Permission check runs on every page
- Revoked access → row not returned
- No data leakage

## Edge Cases

### Empty Pages

If all rows on page fail permission check:

```typescript
{ items: [], nextCursor: null, hasMore: false }
```

Cursor not advanced (no visible rows).

### Last Page Detection

```typescript
const hasMore = filteredItems.length > request.limit;
const items = hasMore ? filteredItems.slice(0, request.limit) : filteredItems;
```

Fetch `limit + 1`, truncate if more exist.

### Cursor Position After Deletes

If cursor row is deleted, query continues from next available row:

```sql
WHERE (created_at, id) < ('2026-10-19T12:00:00Z', 'deleted-row-id')
```

Next row satisfying condition is returned.

## Error Handling

| Error | Code | Recovery |
|-------|------|----------|
| Malformed cursor | `INVALID_CURSOR` | Re-fetch from beginning |
| Tampered cursor | `INVALID_CURSOR` | Re-fetch from beginning |
| Expired cursor | `EXPIRED_CURSOR` | Re-fetch from beginning |

All errors return 400 Bad Request with error code.

## Performance

### Query Cost

- **Best case**: Index-only scan (covered index)
- **Typical**: Index scan + table lookup
- **Worst case**: Full table scan (missing index)

### Optimization Checklist

- [ ] Composite index on (sortColumn, id)
- [ ] Partial index for filtered queries
- [ ] Query plan shows Index Scan (not Seq Scan)
- [ ] Pagination limit reasonable (≤100)

## Migration from Offset Pagination

### Before (Offset)

```typescript
const actions = await prisma.actionLedger.findMany({
  where: { walletAddress },
  orderBy: { createdAt: "desc" },
  skip: page * limit,
  take: limit
});
```

**Problem**: Skip is O(n), unstable under inserts/deletes.

### After (Cursor)

```typescript
const result = await paginateWithPermissions(
  { filter: { walletAddress }, limit: 20, cursor },
  options,
  cursorService
);
```

**Benefit**: O(1) cursor, stable under changes.

## Testing

```bash
npm test -- tests/pagination/cursor-pagination.spec.ts
```

Tests cover:
- Encode/decode round-trip
- Signature tampering detection
- TTL expiration
- Permission filtering on every page
- Deleted record handling
- Concurrent insert isolation

## API Example

```http
GET /api/actions?wallet_address=GUSER&limit=20&cursor=eyJpZCI6...
Authorization: Bearer <token>
```

Response:

```json
{
  "items": [...],
  "next_cursor": "eyJpZCI6ImFjdGlvbi0xMjMiLCJ...",
  "has_more": true
}
```

Client passes `next_cursor` to fetch next page.
