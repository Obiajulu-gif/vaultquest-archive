# Saved pools wallet scoping and cache invariants

Saved pools are user-specific watchlist records. The backend treats the wallet
address as the ownership scope for every saved-pool operation.

## Persistence boundary

- The database identity is the composite `(walletAddress, poolId)` key.
- A pool id alone is never sufficient to read, update, or delete a saved record.
- Two wallets may save the same pool without sharing or overwriting metadata.
- List operations always filter by the normalized wallet address.
- Delete operations require both the normalized wallet address and pool id. A
  request made with a different wallet returns a deleted count of zero.

## Cache boundary

Saved-pool list entries use this key shape:

```text
saved-pools:<wallet-address>
```

The wallet component is mandatory. Cache entries must never be keyed only by a
pool id because pool ids intentionally overlap across users.

A successful save or delete invalidates only the requesting wallet's list. It
must not clear another wallet's entry. A failed cross-wallet delete does not
evict either owner's cached list.

The in-memory cache applies a per-wallet TTL and deterministic least-recently-used
eviction. Expiry or capacity eviction removes one wallet entry at a time and
must not flush unrelated users.

## Authorization assumption

The current HTTP routes receive the wallet address in the request body or query
string. The service enforces data isolation by applying that wallet to every
persistence selector and cache key; it does not independently prove wallet
ownership.

When signed sessions, wallet challenges, or another authenticated principal are
introduced, routes must derive the wallet scope from the verified principal and
reject a conflicting body/query wallet before calling `SavedPoolsService`.
The service-level composite selectors and wallet-qualified cache keys should
remain as defense in depth.

## Regression requirements

Changes to saved pools must keep tests for:

1. two wallets saving overlapping and unique pool ids;
2. wallet A being unable to list or delete wallet B's records;
3. wallet-local mutation invalidation;
4. deterministic TTL and LRU eviction without cross-wallet cache loss;
5. metadata refreshes remaining confined to the composite owner key.
