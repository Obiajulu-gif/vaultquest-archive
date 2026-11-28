# Dashboard Consistency Guarantees

Scope: the vault dashboard (portfolio / account / pool / prizes widgets) that
reads through the shared `VaultQueryClient`
(`stellar-wallet-connect/src/vault/data/queryClient.ts`).

Two defect reports drove this work:

- **#748 — stale/out-of-order balance flicker**: an older in-flight request
  (or a stale response) resolving *after* a newer one could temporarily roll
  the dashboard back to older balances, and every background refetch flashed a
  "stale" indicator even while data was current.
- **#749 — cross-tab/cross-device consistency**: editing or viewing the
  dashboard in two tabs (or two devices sharing a browser profile's storage)
  could show divergent portfolios, with no shared ordering when writes raced.

## Guarantees

### G1. Monotonic commits (cache never goes backward)

Every commit to a cache key carries an intrinsic observation time
(`updatedAt`). A value is only committed when it is *newer* than the currently
committed value for that key (see `setQueryDataAt` in
`stellar-wallet-connect/src/vault/data/queryClient.ts:186`). Any update whose
`updatedAt` is older than the committed value — whether it comes from a
background refetch, an older in-flight request, another tab, or another device —
is **dropped**, never applied.

### G2. Total commit ordering (older operations cannot clobber newer ones)

Commits are totally ordered by a global operation sequence
(`globalOpSeq`). A fetch snapshots the sequence when it *starts*; when it
resolves, it only commits if no newer operation committed in the meantime
(#748, `fetchQuery` at
`stellar-wallet-connect/src/vault/data/queryClient.ts:120`). Consequences:

- A slow, older fetch resolving late is silently dropped (its result is still
  returned to the caller, but never committed).
- An older in-flight **failure** is also suppressed once a newer commit exists,
  so the dashboard never swaps good data for an error banner.
- A failed first load still surfaces the error (`partialError` vs `error` is
  preserved for background refetches while prior data remains usable).

### G3. Stale is about data, not about refetching

`useVaultQuery` reports `stale` from the committed data's age, independent of
whether a background refetch is in flight. Refreshing no longer flashes a
"stale" badge or a flickering widget while the current value is within the
stale window (#748, `stellar-wallet-connect/src/vault/data/queryClient.ts:254`).

### G4. Cross-tab / cross-device fan-out (last-writer-wins)

When any tab/device commits data to the vault cache, the update is broadcast to
peer tabs/devices via a `BroadcastChannel`
(`CACHE_SYNC_CHANNEL`) and persisted to a `localStorage` snapshot
(`CACHE_SNAPSHOT_STORAGE_KEY`), so:

- **Monotonicity across writers** — receivers apply an update only if its
  `updatedAt` is newer than their committed value (G1), so an out-of-order or
  stale broadcast can never regress a peer.
- **Deterministic winner** — when two writers race, the greater `updatedAt`
  wins everywhere.
- **No echo loops** — an update that a writer merely *received* is applied
  locally with `emit: false` and is never re-broadcast.

### G5. Fresh-tab / fresh-device convergence

A newly opened tab rehydrates from the persisted snapshot *before* firing its
own queries (`createVaultCacheSync`, `consistency.ts`), so it starts from the
latest known dashboard state instead of flashing a blank or older baseline.
Rehydration is monotonic (G1), so an *old* persisted snapshot can never regress
live data.

### G6. Silent degradation

If `BroadcastChannel`, `localStorage`, or JSON serialization is unavailable
(privacy mode, quota exceeded, unsupported browser), `ensureVaultCacheSync`
logs nothing and throws nothing; the app keeps working with plain in-tab
caching. All timing-sensitive stale/out-of-order protections (G1–G3) remain
active because they are enforced inside the query client itself.

### G7. Invalidation wins over older in-flight fetches (#1129)

`invalidateQueries` stamps the key with the global operation sequence. A fetch
is joined, committed, or allowed to surface an error only if it started after
both the latest commit and the latest invalidation. So after a deposit or
withdraw invalidates `account` / `pool` keys:

- **Normal:** a refetch starts a new request instead of joining the one that
  was already running with pre-transaction data, and only the new response
  clears `stale`.
- **Failure:** a pre-invalidation request that fails afterwards is ignored; a
  failure of the fresh request shows as `partialError` (or `error` on a first
  load) and the key stays stale.
- **Retry:** the next fetch after a failure runs normally; its success clears
  both the error and `stale`.
- **Wallet scope:** keys carry the wallet address, so invalidating one wallet's
  keys never marks another wallet's data stale.
- **Polling:** `refetch()` (and `refetchIntervalMs` polling, e.g. transaction
  status) joins a request that is already running instead of invalidating it,
  so a poll interval shorter than the response time still saves each answer.

Edge case: if the pre-invalidation request was the first load, the view keeps
showing its loading state until the fresh request lands, rather than flashing
pre-transaction data.

### G8. Bounded memory and storage (#1129)

- `VaultQueryClient` keeps at most `DEFAULT_MAX_QUERY_ENTRIES` (200) keys. When a
  new key arrives it evicts the oldest entries that have no subscribers and no
  fetch in flight. Evicted keys refetch the next time a view reads them. If
  every entry is in use, the cache grows past the cap until some are released.
- The persisted snapshot keeps the newest `CACHE_SNAPSHOT_MAX_ENTRIES` (100)
  keys by `updatedAt`. Without the cap it kept every key ever committed, and
  once it outgrew the storage quota every later write failed silently.
- Rehydrated entries keep their original `updatedAt`, so old snapshot data is
  reported stale and refetched (G5 still holds).

Rollback: reverting `queryClient.ts` and `consistency.ts` restores the old
behaviour. Nothing is migrated; the snapshot format and key are unchanged, so
existing snapshots load as before and are trimmed on the next write.

## Where it's wired

- `components/providers/Providers.jsx` calls `ensureVaultCacheSync()` once on
  app boot (idempotent, no-op during SSR).
- `stellar-wallet-connect/src/vault/data/consistency.ts` — cross-tab/device
  layer (channel, snapshot, rehydration, echo suppression).
- `stellar-wallet-connect/src/vault/data/queryClient.ts` — commit ordering,
  monotonic `setQueryDataAt`, `onDataCommitted` commit fan-out hook.
- `stellar-wallet-connect/src/vault/data/queryKeys.ts` —
  `serializeQueryKey` (stable key identity for snapshots/broadcasts).

## Enforced by tests

- `stellar-wallet-connect/src/vault/data/queryClient.test.ts` — G1/G2/G3/G7/G8:
  stale-fetch drops, failure suppression after newer commits, monotonic
  external updates, rehydration, emit gating, invalidation races, eviction.
- `stellar-wallet-connect/src/vault/data/consistency.test.ts` — G4/G5/G6/G8:
  fan-out, no-echo, out-of-order drop, last-writer-wins, storage fallback,
  snapshot version/scope validation, silent degradation, snapshot cap.

## Non-goals / current limits

- Values carry no authoritative on-chain timestamp from the backend, so a
  *sequential* (non-overlapping) refetch whose response is indexer-lagged
  cannot be detected by the client alone; once a later, non-overlapping
  response commits newer data it is authoritative. Overlapping/out-of-order
  regressions (the reported bugs) are fully prevented by G1–G2.