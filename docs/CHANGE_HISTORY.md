# Change history for critical records (#787)

`updatedAt` is mutable, so it cannot answer "who changed this record, when, and
from what" after the fact — nor prove the answer has not since been edited. This
is the change log for every record whose mutation affects **ownership, money,
permissions, or user access**.

## Which records are critical

`CRITICAL_RECORD_TYPES` in
[`backend/src/services/changeHistoryService.ts`](../backend/src/services/changeHistoryService.ts):

| Record | Why it is critical |
| --- | --- |
| `user` | Ownership and access |
| `action_ledger` | Money in flight (deposits, withdrawals, draws) |
| `vault_settlement` | Settlement state and payouts |
| `user_quest` | Prize eligibility and claim rights |
| `reward_grant` | Value handed out |
| `pool_registry` | Pool configuration and ownership |
| `invitation` | Role/permission grants (see [RBAC.md](RBAC.md)) |
| `escrow` | Held funds and dispute state |

## Chain shape

Entries are appended per record. Each entry commits to its predecessor's hash:

```
entry N   { id, record_type, record_id, sequence, action, actor, reason,
            before, after, timestamp, prev_hash, entry_hash }

entry_hash = sha256(canonical_json(entry_without_entry_hash))
prev_hash  = entry_hash of entry N-1   (entry 1 uses GENESIS_HASH = "0"×64)
```

`canonical_json` is the existing `stableStringify` from
[`ledger.ts`](../backend/src/services/ledger.ts), so hashing is independent of
key order — re-serialising a row with different key order does not look like
tampering.

`sequence` is part of the hashed payload *and* strictly increasing per record, so
reordering is detectable independently of content edits.

## What verification catches

```ts
const service = new ChangeHistoryService(store);
const result = await service.verify("vault_settlement", "vault_123");
```

| Code | Meaning |
| --- | --- |
| `ALTERED` | An entry's contents no longer match its hash — the row was edited after the fact |
| `MISSING` / `BROKEN_LINK` | `prev_hash` does not match the preceding entry — an entry was deleted or a chain was spliced |
| `OUT_OF_ORDER` | `sequence` is not `index + 1` — entries were reordered or one was removed from the middle |
| `GENESIS_MISMATCH` | The chain does not start at `GENESIS_HASH` — the beginning was rewritten |

A clean result means nothing has been altered, removed, reordered or spliced
since the entry was written. `verifyAll()` sweeps a set of records for a
maintenance job or validation script.

## What is rejected outright

`append()` refuses to record a change rather than write a misleading entry:

- no `actor`, no `recordId`;
- no `reason` for `DELETE`, `ROLE_CHANGE`, `SETTLEMENT`, `REVOKE` — the
  money- and access-touching actions always carry a justification;
- `CREATE` that carries a previous state, or `DELETE` that carries a new state;
- a rejected append leaves the chain untouched, so a failed call cannot leave a
  gap that later looks like tampering.

Concurrent appends to the same record are serialised in-process, so two writers
cannot read the same `prev_hash` and fork the chain.

## Storage

Table `record_change_history`, added by
`20260927000000_add_record_change_history` (see
[`backend/prisma/migrations/`](../backend/prisma/migrations/)) and registered in
`MANIFEST.json`. It carries a `UNIQUE (record_type, record_id, sequence)`
constraint, so the database itself refuses a duplicate sequence.

`ChangeHistoryService` is written against the `ChangeHistoryStore` interface:

- `InMemoryChangeHistoryStore` — used by the tests and any caller without a
  database;
- a production store writes the rows above. The hash chain is computed in the
  service, so the database never has to be trusted for integrity.

Preview the table before applying the migration — see
[MIGRATION_SAFETY.md](MIGRATION_SAFETY.md).

## Tests

[`backend/tests/change-history.spec.ts`](../backend/tests/change-history.spec.ts)
covers normal updates (including concurrent appends and key-order-independent
hashing), rejected updates, and each verification failure mode.

Run locally:

```bash
pnpm --filter backend test -- change-history
```
