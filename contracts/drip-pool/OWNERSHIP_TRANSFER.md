# Ownership Transfer — Design Record

**Issues:** #1123 (implementation) · #1122 (rare-failure fixtures)

---

## Goal

Replace the implicit single-step admin reassignment (writing directly to
`DataKey::Admin`) with a two-phase commit that requires the new owner to
actively accept the transfer.  This prevents accidental transfers to wrong or
inactive addresses — a one-step transfer would leave the pool permanently
unmanageable if the target address cannot sign.

---

## State machine

```
      propose_ownership_transfer(admin, new_owner, ttl)
                        │
                        ▼
               ┌─────────────────┐
               │  PENDING        │  DataKey::PendingOwner exists
               │  proposed_owner │◄──── overwritable by a new propose()
               │  expires_at     │
               └────────┬────────┘
            ┌───────────┼───────────────┐
            │           │               │
   accept   │           │ cancel        │  ledger > expires_at
   (by new  │           │ (by admin)    │  (permissionless expire)
    owner,  │           │               │
    before  │           │               │
    expiry) │           │               │
            ▼           ▼               ▼
        ┌───────┐   ┌───────┐      ┌──────────┐
        │  DONE │   │  IDLE │      │  EXPIRED │
        │ admin │   │ no    │      │ record   │
        │ =new  │   │ pend. │      │ purged   │
        └───────┘   └───────┘      └──────────┘
```

**IDLE** and **EXPIRED** are equivalent at the storage level: both mean
`DataKey::PendingOwner` is absent.

---

## Storage

| Key | Type | Scope | Lifecycle |
|-----|------|-------|-----------|
| `DataKey::PendingOwner` | `PendingOwnershipTransfer` | instance | Created by `propose`; deleted by `accept`, `cancel`, or `expire` |

The existing `DataKey::Admin` and `Pool.admin` fields are updated atomically in
`accept_ownership_transfer` to keep both consistent.  No migration is required
for existing deployments; absence of `PendingOwner` means no transfer is pending.

---

## Entry points

| Function | Auth | Description |
|----------|------|-------------|
| `propose_ownership_transfer(caller, new_owner, ttl_ledgers)` | `Pool.admin` | Write a pending transfer record. Overwrites any existing pending proposal. TTL 0 → default (~7 days). |
| `accept_ownership_transfer(caller)` | `proposed_owner` | Accept before `expires_at`. Updates `Pool.admin` atomically. |
| `cancel_ownership_transfer(caller)` | `Pool.admin` | Delete the pending record at any time. |
| `expire_ownership_transfer()` | permissionless | Delete a stale record once `ledger.sequence() > expires_at`. |
| `pending_ownership_transfer()` | view | Returns `Option<PendingOwnershipTransfer>`. |

---

## Edge cases

### Expiry boundary semantics

- Acceptance is valid when `ledger.sequence() <= expires_at`.  The expiry
  instant itself is **inclusive** for accept and **exclusive** for expire.
- `expire_ownership_transfer` requires `ledger.sequence() > expires_at` to
  prevent racing with a valid late-but-on-time accept.

### Overwrite on double-propose

Calling `propose_ownership_transfer` a second time silently overwrites the
pending record.  This is intentional: the admin may need to redirect a proposal
(typo in target address, changed mind) without first cancelling.  No event is
emitted for the overwritten proposal — the new `ownership_proposed` event is
sufficient.

### Auto-purge on stale accept

When `accept_ownership_transfer` is called after expiry, the contract:
1. Detects `ledger.sequence() > expires_at`.
2. Deletes `DataKey::PendingOwner` before returning `OwnershipTransferExpired`.

This prevents storage leaks when the proposed owner calls late rather than
letting the record sit until someone calls `expire_ownership_transfer`.

### Emergency mode

Ownership transfer is not blocked during emergency mode.  Governance
continuity is more important than pausing administrative transitions.  The
new owner inherits the emergency state and must resolve it via the multisig
proposal flow.

### No-loss guarantee

Ownership transfer touches only `DataKey::Admin`, `DataKey::Pool`, and
`DataKey::PendingOwner`.  It never reads or writes participant storage, yield
accounting, round state, or token balances.  The no-loss principal invariant
is unaffected.

---

## Failure modes and recovery

| Failure | Recovery |
|---------|----------|
| Proposed owner never responds | Admin cancels, or anyone expires after TTL |
| Admin proposes wrong address | Admin overwrites with a new propose, or cancels |
| New owner calls accept late (after expiry) | `OwnershipTransferExpired` returned; record auto-purged; admin may re-propose |
| Non-admin attempts to propose | `Unauthorized` |
| Wrong address attempts to accept | `Unauthorized`; existing record and `Pool.admin` unchanged |
| Self-transfer | `InvalidAction`; no record created |
| TTL > max (~90 days) | `InvalidAction`; no record created |

---

## TTL constants

| Constant | Value | Approximate duration |
|----------|-------|----------------------|
| `OWNERSHIP_TRANSFER_DEFAULT_TTL` | `17_280 * 7` = 120 960 | ~7 days at 5 s/ledger |
| `OWNERSHIP_TRANSFER_MAX_TTL` | `17_280 * 90` = 1 555 200 | ~90 days |

---

## Events

| Event | Topics | Data |
|-------|--------|------|
| `ownership_proposed` | `("ownership", "proposed")` | `(current_owner, new_owner, expires_at)` |
| `ownership_accepted` | `("ownership", "accepted")` | `(old_owner, new_owner)` |
| `ownership_cancelled` | `("ownership", "cancelled")` | `(current_owner, proposed_owner)` |
| `ownership_expired` | `("ownership", "expired")` | `(current_owner, proposed_owner, expires_at)` |

---

## Rare-failure fixture catalogue (Issue #1122)

See `golden-fixtures/ownership_transfer.json` for the full machine-readable
fixture set.  The table below is the human summary:

| Fixture | Scenario | Expected outcome |
|---------|----------|-----------------|
| `ownership_expiry_exact_boundary_success` | Accept at ledger == expires_at | ✅ Success |
| `ownership_expiry_one_past` | Accept at ledger == expires_at + 1 | ❌ `OwnershipTransferExpired` |
| `expire_before_deadline` | expire at ledger < expires_at | ❌ `InvalidAction` |
| `expire_at_exact_deadline` | expire at ledger == expires_at | ❌ `InvalidAction` |
| `expire_one_past_deadline` | expire at ledger == expires_at + 1 | ✅ Success |
| `accept_after_cancel` | accept after cancel | ❌ `OwnershipTransferNotFound` |
| `self_transfer_rejected` | propose to self | ❌ `InvalidAction` |
| `ttl_beyond_max` | ttl > 1 555 200 | ❌ `InvalidAction` |
| `accept_no_proposal` | accept with no pending record | ❌ `OwnershipTransferNotFound` |
| `cancel_no_proposal` | cancel with no pending record | ❌ `OwnershipTransferNotFound` |
| `non_admin_propose` | non-admin proposes | ❌ `Unauthorized` |
| `wrong_acceptor` | wrong address accepts | ❌ `Unauthorized` |
