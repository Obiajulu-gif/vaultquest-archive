# Safe ownership transfer

Issue #999. `lib/ownership-transfer.ts` is the single source of truth for handing
ownership of a resource (a saved pool, an export bundle, a maintainer-owned
record) from one party to another. Ownership moves only when the named
recipient **accepts** an outstanding offer, and an offer that is not accepted in
time **expires** rather than transferring. This is a two-phase handover: the
sender proposes, the recipient confirms, and the resource is never left
ownerless or double-owned.

The module is pure and dependency-free (the same rule `lib/pool-lifecycle.ts`
and `lib/rbac.ts` follow), so the backend can import it across the workspace and
the Next bundler can bundle it unchanged.

## Precedent: OpenZeppelin Soroban `Ownable`

This is the same two-step model the OpenZeppelin **Stellar/Soroban** `Ownable`
module uses on-chain, which is strong evidence the shape is correct for
VaultQuest's Stellar context:

- The current owner calls `transfer_ownership(new_owner, live_until_ledger)` —
  naming the recipient **and an expiry** — and the new owner must call
  `accept_ownership()` to complete it. Until acceptance, the current owner keeps
  full control.
- A pending transfer is cancelled by starting a new one or by using
  `live_until_ledger = 0`.
- `renounce_ownership()` (giving ownership up entirely) is explicitly **out of
  scope** here — this module only moves ownership between two parties.

The mapping to this module: `initiate` ≙ `transfer_ownership`, `accept` ≙
`accept_ownership`, `expiresAt` ≙ `live_until_ledger`. The on-chain module
measures expiry in **ledger sequence numbers**; this module governs *off-chain*
resources (saved pools, export bundles) and so uses a monotonic wall-clock
deadline. The injected clock (`ctx.now`) keeps the unit explicit and testable.
`decline` and an explicit `cancel` are off-chain conveniences the on-chain module
does not have (there, non-acceptance simply lapses). See `implementation.md` for
sources.

## States

| State | Meaning | Terminal |
|---|---|---|
| `pending` | Offer created, awaiting the recipient's decision. | no |
| `accepted` | Recipient accepted; ownership moved to `to`. | **yes** |
| `declined` | Recipient declined; ownership stays with `from`. | **yes** |
| `cancelled` | Initiator revoked the offer; ownership stays with `from`. | **yes** |
| `expired` | Window elapsed before acceptance; ownership stays with `from`. | **yes** |

`pending` is the only non-terminal state. All four terminal states are sinks.

## Transition table

| From | Action | To | Who may act |
|---|---|---|---|
| `pending` | accept | `accepted` | the named recipient (`to`) only |
| `pending` | decline | `declined` | the named recipient (`to`) only |
| `pending` | cancel | `cancelled` | the initiator (`from`) only |
| `pending` | expire | `expired` | system (clock-driven sweep) |

## Authorization model

Three distinct checks, each with a stable reason code:

- **Initiate** — only the resource's *current owner* may offer it
  (`OWNERSHIP_NOT_OWNER`), and never to themselves (`OWNERSHIP_SELF_TRANSFER`).
- **Accept / decline** — only the *named recipient* may respond
  (`OWNERSHIP_FORBIDDEN_ACCEPTOR`). Nobody else, including the initiator.
- **Cancel** — only the *initiator* may revoke a pending offer
  (`OWNERSHIP_FORBIDDEN_INITIATOR`).

Ownership is settled by `OwnershipTransferRegistry.accept` **after** the pure
machine accepts the action, so a rejected accept never moves ownership.

## Expiry semantics

Expiry is evaluated against an **injectable clock** (`ctx.now`), never a hidden
`Date.now()`. A `pending` offer whose `expiresAt` has elapsed is *read* as
`expired` by `effectiveTransferState` before it is ever formally swept, so a late
`accept` can never win a race against the clock — it is rejected with
`OWNERSHIP_EXPIRED` (retryable: re-initiate a fresh offer). The window is bounded
to `[1ms, 30 days]` (`OWNERSHIP_INVALID_DURATION`), matching
`lib/access-grants.ts`.

A formal `expireOwnershipTransfer` attributes the expiry to the real deadline
(`expiresAt`), not the later sweep time, so the audit trail reflects when the
offer actually lapsed. It is idempotent: sweeping an already-terminal offer, or a
still-pending offer before its deadline, is a no-op.

## Reason codes (stable contract)

These are part of the API/log contract and must not change without a migration
plan (the same rule as `lib/rejectionReasons.ts`):

`OWNERSHIP_INVALID_PARTICIPANT`, `OWNERSHIP_INVALID_DURATION`,
`OWNERSHIP_SELF_TRANSFER`, `OWNERSHIP_NOT_OWNER`, `OWNERSHIP_DUPLICATE_PENDING`,
`OWNERSHIP_NOT_FOUND`, `OWNERSHIP_NOT_PENDING`, `OWNERSHIP_EXPIRED`,
`OWNERSHIP_FORBIDDEN_ACCEPTOR`, `OWNERSHIP_FORBIDDEN_INITIATOR`.

Each `OwnershipTransferError` also carries a `retryable` hint (only `EXPIRED` is
retryable — by starting a new offer).

## Audit events

Every accepted action emits exactly one `OwnershipTransferEvent` through the
optional `ctx.onEvent` sink (the module performs no I/O itself, mirroring
`transitionPool`'s `onTransition`):

`ownership.transfer_initiated`, `ownership.transfer_accepted`,
`ownership.transfer_declined`, `ownership.transfer_cancelled`,
`ownership.transfer_expired`.

Callers wire persistence/notifications to this sink. The event carries `from`,
`to`, the resolved `owner` (or `null`), the `actor`, and the timestamp.

## Operational edge cases

| Case | Behaviour |
|---|---|
| Accept after expiry | Rejected `OWNERSHIP_EXPIRED` (retryable); ownership unchanged. |
| Double-accept / act on terminal offer | Rejected `OWNERSHIP_NOT_PENDING`. |
| Two offers for one resource | Rejected `OWNERSHIP_DUPLICATE_PENDING`; one pending offer per resource at a time. |
| Re-initiate after decline/cancel/expiry | **Allowed** — the retry path. The prior elapsed offer is swept first, then a fresh offer is created. |
| Recipient never responds | A cron sweep (`sweepExpired`) expires the offer; ownership stays with `from`. |
| Unknown transfer id | Rejected `OWNERSHIP_NOT_FOUND`. |

## Recovery / rollback

An **accepted** transfer is undone by a **reverse transfer**: the new owner
initiates a fresh offer back to the previous owner, who accepts. Because every
offer records both `from` and `to`, the prior owner is always recoverable from
the audit trail, and the two-phase rule still holds (the previous owner must
accept the hand-back). There is no silent force-revert — rollback is itself a
safe, audited transfer. `OwnershipTransferRegistry.sweepExpired` is the recovery
path for abandoned offers.

## Migration plan (wiring to persistence)

`lib/ownership-transfer.ts` and `OwnershipTransferRegistry` are an in-memory
reference implementation; they preserve existing contracts (no schema change,
nothing removed). The registry keeps a `pendingByResource` index so the
single-pending-offer check, the per-resource sweep, and `listPending` are O(1)
/ O(p) rather than O(n) over all historical transfers (full analysis in
`implementation.md`). To persist them, mirror the pattern used by other
backend-owned state:

1. **Table** — add a migration (e.g.
   `backend/prisma/migrations/<ts>_ownership_transfers/`) with an
   `ownership_transfers` table keyed by `id`, plus columns for
   `resource_type`, `resource_id`, `from`, `to`, `state`, `created_at`,
   `expires_at`, `resolved_at`, `resolved_by`, `note`, and a **partial unique
   index** on `(resource_type, resource_id)` where `state = 'pending'` to
   enforce the single-pending-offer invariant at the database level.
2. **Service** — a `backend/src/services/ownershipTransferService.ts` that loads
   a row, calls the pure helpers (`acceptOwnershipTransfer`, …), and persists the
   returned record plus the audit event in one transaction.
3. **Routes** — `POST /ownership/transfers` (initiate),
   `POST /ownership/transfers/:id/accept`, `.../decline`, `.../cancel`, each
   re-checking authorization server-side; map `OwnershipTransferError.reasonCode`
   onto Problem Details via the existing error taxonomy.
4. **Sweep** — add an expiry sweep to `backend/src/cron.ts` that calls the
   service's batch equivalent of `sweepExpired` on an interval.
5. **RBAC** — ownership checks are resource-ownership based (owner-of), not
   role-based, so no new `lib/rbac.ts` permission is required for the owner path;
   a maintainer override, if ever needed, would add an `admin.ownership.write`
   permission there.

Until wired, the module is consumed directly in tests and any in-process caller.

## Tests

`lib/ownership-transfer.test.ts` (run with `pnpm test`) covers the normal,
failure, retry, and authorization paths, expiry races, idempotent sweeps,
rollback via reverse transfer, and the registry invariants.
