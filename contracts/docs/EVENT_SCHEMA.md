# VaultQuest Soroban event schema

This document is the canonical event contract for pool lifecycle and user
actions. Contract, backend, and frontend changes that add or rename fields must
update this file in the same PR.

## Envelope

Every event uses these topic positions:

| Topic | Value |
|---|---|
| `0` | event scope, currently `"pool"` |
| `1` | event name |

The current contract payloads are Soroban values or tuples. The backend indexer
normalizes these positional values into the named fields documented below.

## Required events

| Event | Topics | Contract payload | Normalized fields |
|---|---|---|---|
| `created` | `pool`, `created` | `admin` | `admin` |
| `joined` | `pool`, `joined` | `wallet` | `wallet` |
| `deposit` | `pool`, `deposit` | `(wallet, amount, total_deposited)` | `wallet`, `amount`, `total_deposited` |
| `claimed` | `pool`, `claimed` | `(wallet, amount)` | `wallet`, `amount` |
| `withdrawn` | `pool`, `withdrawn` | `(wallet, amount)` | `wallet`, `amount` |
| `payout` | `pool`, `payout` | `(winner, amount)` | `winner`, `amount` |

Errors are represented by Soroban contract error codes and are not emitted as
ledger events. Admin signer mutations currently do not emit events; adding
those events requires updating this document and the snapshot in the same PR.

## Machine-readable snapshot

The validator at `contracts/scripts/validate_event_schema.py` compares this
snapshot with every `env.events().publish(...)` declaration. Topic names and
payload arity are deliberately explicit so accidental changes fail validation.

<!-- EVENT_SCHEMA_SNAPSHOT
[
  {"name":"created","topics":["pool","created"],"payload_arity":1},
  {"name":"joined","topics":["pool","joined"],"payload_arity":1},
  {"name":"deposit","topics":["pool","deposit"],"payload_arity":3},
  {"name":"claimed","topics":["pool","claimed"],"payload_arity":2},
  {"name":"withdrawn","topics":["pool","withdrawn"],"payload_arity":2},
  {"name":"payout","topics":["pool","payout"],"payload_arity":2}
]
EVENT_SCHEMA_SNAPSHOT -->

Run the validation locally with:

```bash
python3 contracts/scripts/validate_event_schema.py
```

## Indexer assumptions

Indexers should identify an event by `ledger:tx_hash:event_index` and upsert by
that identity. The indexer must decode the tuple positions exactly as listed
above. A topic rename, topic reorder, payload field reorder, or payload arity
change is breaking and must be coordinated with backend and frontend consumers.

## Versioning

Additive normalization metadata may be documented without changing emitted
topics. Renamed events, changed topic order, changed tuple order, changed units,
or changed payload arity require an explicit migration note and corresponding
indexer update. Intentional changes must update both the human-readable table
and the machine-readable snapshot in the same pull request.
