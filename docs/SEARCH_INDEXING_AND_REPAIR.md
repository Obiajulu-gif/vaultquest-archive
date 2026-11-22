# Permission-Aware Search Indexing and Stale-Index Repair

## 1. Overview

VaultQuest provides prize vault savings, custom portfolios (saved pools), quests, and automated prize distribution settlements. As the platform evolves, discovery and search functionality must strictly reflect record visibility and privacy boundaries.

This system guarantees that:
1. **Restricted records never leak**: Private saved pools, in-progress user quests, unlisted pools, and internal settlement audits are invisible to unauthorized callers.
2. **Mutations keep the index current**: Creation, modification, deletion, deactivation, or revocation triggers corresponding index updates or evictions.
3. **Idempotent repair heals inconsistencies**: If any index entry becomes missing, stale, orphaned, or has a visibility mismatch (e.g. following network blips or ungraceful worker shutdowns), the repair job detects and repairs it.

---

## 2. Core Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Client / Caller                        │
│   (Anonymous, Connected Wallet User, or Maintainer)        │
└──────────────────────────────┬──────────────────────────────┘
                               │ GET /api/search
                               ▼
┌─────────────────────────────────────────────────────────────┐
│              Fastify Search Routes & RBAC Guard             │
│        (Resolves Principal: Wallet Address, Role, Perms)    │
└──────────────────────────────┬──────────────────────────────┘
                               │ SearchContext
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                    SearchIndexService                       │
│    - Evaluates record accessibility before returning results│
│    - Ranks and filters by query, asset, network, status     │
└──────────────────────────────▲──────────────────────────────┘
                               │
            ┌──────────────────┴──────────────────┐
            │ Mutation Hooks                      │ Repair Job
            │ (SearchIndexHooks)                  │ (SearchIndexRepairService)
            ▼                                     ▼
┌──────────────────────────────┐        ┌─────────────────────┐
│ Primary State Mutations      │        │ Primary Database    │
│ - PoolRegistry               │        │ - PoolRegistry      │
│ - SavedPool                  │        │ - SavedPool         │
│ - UserQuest                  │        │ - UserQuest         │
│ - VaultSettlement            │        │ - VaultSettlement   │
└──────────────────────────────┘        └─────────────────────┘
```

---

## 3. Indexable Fields and Visibility Constraints

### Index Document Schema

Each indexed item conforms to `SearchIndexDocument`:

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Unique composite key (`<recordType>:<recordId>`) |
| `recordType` | `RecordType` | Entity type: `vault`, `saved_pool`, `quest`, `settlement` |
| `recordId` | `string` | Primary key of the source record |
| `title` | `string` | Searchable title or pool name |
| `description` | `string?` | Sanitized description or strategy summary |
| `asset` | `string?` | Underlying asset code (`USDC`, `XLM`, `ETH`, etc.) |
| `network` | `string?` | Network name (`Stellar`, etc.) |
| `status` | `string?` | State (`active`, `inactive`, `Resolved`, etc.) |
| `ownerWallet` | `string?` | Wallet address for ownership-scoped records |
| `visibility` | `VisibilityLevel` | `public`, `unlisted`, `owner_only`, `maintainer_only`, `permission_scoped` |
| `requiredRoles` | `Role[]?` | Explicit role requirements (e.g. `maintainer`) |
| `requiredPermissions` | `Permission[]?` | RBAC permissions (e.g. `admin.audit.read`) |
| `searchableText` | `string` | Tokenized, normalized text string for fast matching |
| `version` | `number` | Monotonically increasing version counter |
| `sourceUpdatedAt` | `Date` | Timestamp from primary source of truth |
| `indexedAt` | `Date` | Timestamp when added/updated in the index |
| `deletedAt` | `Date?` | Tombstone timestamp for soft deletion |

### Sanitization and Security Guarantees
- Sensitive cryptographic parameters (`salt`, `wasmHash`), private session tokens, and raw ledger secrets are strictly excluded from the search index.
- Search queries normalize tokens with lowercasing and punctuation stripping to prevent regex or query injection.

### Visibility Rules Matrix

| Visibility Level | Anonymous User | Connected Wallet | Maintainer |
|---|---|---|---|
| `public` | ✅ Visible | ✅ Visible | ✅ Visible |
| `unlisted` | ❌ Hidden | ✅ Visible only with `include_unlisted=true` | ✅ Visible |
| `owner_only` | ❌ Hidden | ✅ Visible ONLY if `walletAddress === ownerWallet` | ✅ Visible |
| `maintainer_only`| ❌ Hidden | ❌ Hidden | ✅ Visible |
| `permission_scoped` | ❌ Hidden | ✅ Visible ONLY if user possesses required permission | ✅ Visible |

---

## 4. Mutation Lifecycle Hooks

The `SearchIndexHooks` class manages bidirectional synchronization when records are mutated:

- **Vaults**:
  - `onVaultCreated(vault)`: Indexes new vault. Active vaults default to `public`.
  - `onVaultUpdated(vault)`: Re-indexes modified attributes and increments version.
  - `onVaultDeleted(vaultId)`: Evicts vault from index.
  - `onVaultVisibilityChanged(vaultId, active, unlisted)`: Transitions visibility between `public`, `unlisted`, and `maintainer_only`.
- **Saved Pools**:
  - `onSavedPoolCreated(savedPool)`: Indexes pool with `owner_only` visibility and `ownerWallet = savedPool.walletAddress`.
  - `onSavedPoolDeleted(walletAddress, poolId)`: Evicts record so it immediately ceases to appear in searches.
- **User Quests**:
  - `onQuestUpdated(quest)`: Updates quest progress and status under `owner_only` visibility.
  - `onQuestRevoked(walletAddress, questId)`: Removes quest entry.
- **Settlements**:
  - `onSettlementUpdated(settlement)`: Resolved settlements become `public` for transparency, while unresolved/error settlements remain `maintainer_only`.

---

## 5. Stale-Index Detection and Repair Job

The `SearchIndexRepairService` acts as a background auditor that reconciles the search index against PostgreSQL / Prisma models.

### Anomaly Classification

1. **`missing`**: Record exists in source-of-truth tables but is missing from the search index.
   - *Action*: Inserts the document with sanitized fields and appropriate visibility.
2. **`stale`**: Record exists in search index, but title, asset, status, or version lags behind the primary record.
   - *Action*: Overwrites index document with fresh data from source.
3. **`visibility_mismatch`**: Critical security anomaly where index visibility differs from primary record state (e.g. vault was deactivated in DB, but index doc was still `public`).
   - *Action*: Updates visibility level and restricted roles immediately.
4. **`orphaned`**: Index document exists, but source record was deleted or purged.
   - *Action*: Purges document from the search index.

Every finding includes a recommendation and source/index version evidence. The detector also compares the projected description, network, searchable text, metadata, role/permission requirements, and source timestamp; matching a version number alone does not establish freshness. Visibility mismatches are identified separately so operators can prioritize a stale public document that should now be restricted.

### Operator preview

Maintainers can request a bounded, read-only preview before applying repair:

```http
GET /api/search/repair/preview?type=vault&limit=100
```

The endpoint uses the same permission guard as the repair action. `type` is optional; `limit` is 1–500. The response includes each finding's reason, versions, visibility evidence, and recommendation. It reports `complete: false` because it is intentionally bounded; a zero count is not proof that the entire index is clean. The preview does not mutate the index.

`POST /api/search/repair` retains its existing behavior and permission contract. It rebuilds missing/stale documents from primary records, applies source visibility to visibility mismatches, and removes orphaned documents. The scheduled sweep also runs hourly.

### Idempotency
Running `detectAnomalies()` immediately after `runRepair()` yields `0` anomalies, verifying deterministic and idempotent behavior.

---

## 6. Scheduled Cron Execution

The repair job runs periodically via `startSearchIndexRepairCron` in `backend/src/cron.ts`:
- **Frequency**: Hourly by default (`0 * * * *`).
- The server hydrates the process-local index from primary records before accepting requests, then performs the hourly sweep.
- The search index is process-local memory, so each replica must run its own refresh; a distributed lease would leave replicas that did not acquire it stale. A sweep failure is logged and retried on the next schedule. Search authorization is still evaluated against the document visibility at read time.

### Cache inspection and repair

The Redis/in-memory cache exposes service-authenticated internal operations:

```http
GET /internal/cache/stale?kind=asset_metadata&limit=100
POST /internal/cache/repair
X-Internal-Secret: <internal service secret>
Content-Type: application/json

{"dry_run":true,"kind":"asset_metadata","limit":100}
```

Repair is dry-run by default. Findings include the cache key, kind, reason, source/cache version when known, and a recommendation. A repair invalidates the cache entry so the next ordinary read repopulates it from its source; it does not edit the action ledger or chain state. `kind` and exact `keys` can scope an apply. Limits are clamped to 500 findings. Responses include `scanned` (entries inspected) separately from the findings count. `complete: false` means the bounded Redis scan has not completed a full cursor cycle or the findings limit was exceeded; use subsequent scans to cover remaining pages. Malformed payloads requiring review are reported as failures and are not automatically invalidated. Redis scan failures fail the inspection rather than returning a success-shaped partial report.

Indexer checkpoint comparisons use PostgreSQL as the persisted source and compare ledger, event cursor, and indexer version. A Redis checkpoint marked dirty is intentionally omitted until write-behind synchronization completes. Checkpoint writes and the dirty marker are updated atomically; repair atomically checks the marker before invalidating, deferring if a write-behind update raced with the scan. The next read after invalidation falls back to PostgreSQL.

Production starts a five-minute cache repair sweep on every backend process. Each tick advances one bounded Redis index page and repairs local in-memory stale entries; invalidation is idempotent across replicas. Cache repair runs are recorded in `cache_repair_runs`, including dry-run plans and incomplete runs (a missing `completed_at` means the process stopped before recording completion). Apply the additive migration with `pnpm --filter backend exec prisma migrate deploy` before deploying code that uses the audit table.

### Failure handling, rollback, and recovery

- A stale-cache eviction is reversible by normal cache repopulation. If a source loader is unavailable, repair may cause a cache miss/read-through failure; restore source availability and retry. No database or on-chain values are changed by cache repair.
- The projection migration only adds `derived_cache` and `cache_repair_runs`. For application rollback, redeploy the previous backend; leave the additive tables in place. Do not drop either table while run evidence is needed. If the migration fails, inspect Prisma migration status and database logs, correct the underlying cause, then rerun `prisma migrate deploy`; do not manually mark a failed migration applied.
- To inspect incomplete or recent cache repair attempts, query `cache_repair_runs` by `job_name` and `started_at`; compare `plan_json`, `applied_json`, `failed_count`, and `completed_at`. A failed audit write blocks a manual repair request; if the process stops after invalidation but before the final update, the initial plan row remains for investigation.
- A search-index repair is rebuilt from primary records. If its output is incorrect, correct the source record and rerun repair; do not restore an old index snapshot as it can restore stale visibility or private data.
- If an operator suspects a false positive caused by indexer lag, inspect indexer health and chain-event evidence first. Do not mutate confirmed vault deposits, prize outcomes, wallet flows, or quest rewards based only on a projection finding.
- A failed or interrupted repair is safe to retry: cache invalidation is idempotent and search documents are regenerated from the source. Review per-entry failures and rerun a scoped dry-run before applying again.
- Cache and search previews expose operational identifiers only behind their service/maintainer guards. Do not copy findings or wallet-scoped identifiers into public issue reports or logs.

---

## 7. HTTP API Contracts

### `GET /api/search`
Searches discovery records conforming to the caller's authorization context.

- **Query Parameters**:
  - `q`: Search string (optional)
  - `type`: `vault` \| `saved_pool` \| `quest` \| `settlement` (optional)
  - `asset`: Filter by asset code (optional)
  - `network`: Filter by network (optional)
  - `status`: Filter by status (optional)
  - `limit`: Number of results (1–200, default 50)
  - `offset`: Offset for pagination (default 0)
  - `include_unlisted`: Boolean (requires authenticated caller)

- **Response**:
```json
{
  "data": {
    "items": [
      {
        "id": "vault:v1",
        "recordType": "vault",
        "recordId": "v1",
        "title": "USDC Stable Yield Vault",
        "asset": "USDC",
        "network": "Stellar",
        "status": "active",
        "visibility": "public",
        "metadata": { "poolAddress": "CPOOL..." }
      }
    ],
    "total": 1,
    "limit": 50,
    "offset": 0,
    "executionMs": 1.45
  }
}
```

### `POST /api/search/repair`
Manually triggers the stale-index repair job. Requires `maintainer` role or `admin.audit.write` permission.

- **Response**:
```json
{
  "data": {
    "scannedSources": 150,
    "scannedIndexEntries": 148,
    "anomaliesDetected": {
      "missing": 2,
      "stale": 1,
      "visibilityMismatch": 1,
      "orphaned": 1
    },
    "repairedCount": 5,
    "durationMs": 12.3,
    "startedAt": "2026-09-30T12:00:00.000Z",
    "completedAt": "2026-09-30T12:00:00.012Z"
  }
}
```

### `GET /api/search/stats`
Returns index cardinality and distribution across record types and visibility levels.

---

## 8. Verification and Test Suite

Run all automated unit and integration tests:

```bash
pnpm --filter backend test search
```

Output:
```text
 ✓ tests/searchIndexService.spec.ts (14 tests)
 ✓ tests/searchIndexHooks.spec.ts (10 tests)
 ✓ tests/searchIndexRepair.spec.ts (5 tests)
 ✓ tests/searchRoutes.spec.ts (7 tests)

 Test Files  4 passed (4)
      Tests  36 passed (36)
```
