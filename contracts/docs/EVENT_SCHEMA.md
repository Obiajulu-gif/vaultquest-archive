# VaultQuest Soroban event schema

This document is the canonical contract between the Drip Pool Soroban contract,
the backend indexer, and frontend transaction reconciliation. Any intentional
change to an event topic, payload order, or payload type must update this file,
`EVENT_SCHEMA_V1.snapshot`, and the contract regression tests in the same pull
request.

## Event identity and indexer assumptions

Soroban events are identified by the emitting contract plus their ledger,
transaction hash, and event index. The Drip Pool contract does not include a
separate pool identifier in event data: **the emitting contract address is the
pool identifier**.

Indexers should therefore persist an event identity equivalent to:

```text
contract_id:ledger:tx_hash:event_index
```

Reprocessing must upsert by that identity. Action reconciliation should also
retain the transaction hash and the backend action ledger's idempotency key when
one exists. The idempotency key is backend metadata and is not currently emitted
by the contract.

## Version 1 envelope

Version 1 uses two ordered topics:

| Topic | Meaning |
|---|---|
| `0` | namespace, currently `pool` |
| `1` | event action |

Payloads are positional Soroban values. Amounts use signed `i128` contract base
units. Changing topic order, action names, payload order, or payload types is a
breaking schema change and requires a new snapshot/version.

## Emitted lifecycle events

| Schema key | Topics | Payload positions |
|---|---|---|
| `pool.created` | `pool`, `created` | `0: Address admin` |
| `pool.joined` | `pool`, `joined` | `0: Address wallet` |
| `pool.deposit` | `pool`, `deposit` | `0: Address wallet`, `1: i128 amount`, `2: i128 total_deposited` |
| `pool.claimed` | `pool`, `claimed` | `0: Address wallet`, `1: i128 amount` |
| `pool.withdrawn` | `pool`, `withdrawn` | `0: Address wallet`, `1: i128 amount` |
| `pool.payout` | `pool`, `payout` | `0: Address winner`, `1: i128 prize` |

The tests decode every payload into these exact Rust types, so a removed field,
reordered field, changed topic, or incompatible type fails the contract test
suite.

## Explicit non-emission behavior

The following successful admin operations currently mutate contract storage but
do not emit an event:

- `add_admin`
- `remove_admin`
- `propose`
- `approve`

The indexer must not infer these changes from a lifecycle event. Consumers that
need admin history must read contract state or the backend action ledger until a
versioned admin event is introduced.

Failed invocations do not produce a durable success event. In particular,
invalid amounts and unauthorized draw attempts are regression-tested to leave
the event stream unchanged. Error details come from the Soroban contract error,
not from an emitted error event.

## Machine-readable snapshot

The block below is intentionally duplicated in `EVENT_SCHEMA_V1.snapshot`.
Contract tests compare both copies byte-for-byte (after trimming) before checking
emitted events.

<!-- EVENT_SCHEMA_V1_START -->
pool.created|pool,created|Address(admin)
pool.joined|pool,joined|Address(wallet)
pool.deposit|pool,deposit|(Address(wallet),i128(amount),i128(total_deposited))
pool.claimed|pool,claimed|(Address(wallet),i128(amount))
pool.withdrawn|pool,withdrawn|(Address(wallet),i128(amount))
pool.payout|pool,payout|(Address(winner),i128(prize))
admin.add_admin|none|none
admin.remove_admin|none|none
admin.propose|none|none
admin.approve|none|none
error.invalid_amount|none|none
error.unauthorized|none|none
<!-- EVENT_SCHEMA_V1_END -->

## Change policy

Additive metadata cannot be appended to an existing positional payload without
breaking decoders. Introduce a new event action or a new documented schema
version instead. Every intentional schema change must include:

1. updated contract emission code;
2. updated regression fixtures and payload decoding tests;
3. this document and the machine-readable snapshot;
4. a migration note for backend/indexer and frontend consumers;
5. `cargo fmt --manifest-path contracts/Cargo.toml --all` and the contract tests.
