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

- `stellar-wallet-connect/src/vault/data/queryClient.test.ts` — G1/G2/G3:
  stale-fetch drops, failure suppression after newer commits, monotonic
  external updates, rehydration, emit gating.
- `stellar-wallet-connect/src/vault/data/consistency.test.ts` — G4/G5/G6:
  fan-out, no-echo, out-of-order drop, last-writer-wins, storage fallback,
  snapshot version/scope validation, silent degradation.

## Non-goals / current limits

- Values carry no authoritative on-chain timestamp from the backend, so a
  *sequential* (non-overlapping) refetch whose response is indexer-lagged
  cannot be detected by the client alone; once a later, non-overlapping
  response commits newer data it is authoritative. Overlapping/out-of-order
  regressions (the reported bugs) are fully prevented by G1–G2.