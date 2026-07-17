# VaultQuest Soroban event schema

This document is the canonical snapshot for events currently emitted by the
`contracts/drip-pool` contract. Contract, backend indexer, and frontend changes
that rename a topic, reorder a payload value, or change a value type must update
this document and the contract schema tests in the same pull request.

## Current envelope (`contract-v1`)

The deployed contract currently emits two topic values:

| Topic | Meaning |
|---|---|
| `0` | domain (`pool`) |
| `1` | action (`created`, `joined`, `deposit`, `claimed`, `withdrawn`, `payout`) |

The payload is a Soroban value or tuple. Tuple positions are part of the public
contract because the backend decoder and analytics consumers depend on them.
The normalized event names below are the names consumers should use after
combining the two topics.

## Required emitted events

| Normalized event | Soroban topics | Payload positions | Consumer impact |
|---|---|---|---|
| `pool_created` | `pool`, `created` | `admin` | pool bootstrap and admin ownership |
| `pool_joined` | `pool`, `joined` | `wallet` | participant refresh |
| `drip_deposited` | `pool`, `deposit` | `wallet`, `amount`, `total_deposited` | balance, TVL, and confirmation refresh |
| `reward_claimed` | `pool`, `claimed` | `wallet`, `amount` | reward history refresh |
| `withdrawn` | `pool`, `withdrawn` | `wallet`, `amount` | position and balance refresh |
| `payout_selected` | `pool`, `payout` | `winner`, `amount` | winner and prize refresh |

Amounts are signed Soroban `i128` base-unit values. Wallet/admin/winner values
are Soroban `Address` values.

## Machine-readable snapshot

The Rust contract tests parse the JSON between the markers below. Keep it valid
JSON and update it only alongside intentional schema changes.

<!-- EVENT_SCHEMA_SNAPSHOT_START -->
```json
{
  "schema": "contract-v1",
  "topics": ["domain", "action"],
  "events": [
    { "name": "pool_created", "topics": ["pool", "created"], "payload": ["admin"] },
    { "name": "pool_joined", "topics": ["pool", "joined"], "payload": ["wallet"] },
    { "name": "drip_deposited", "topics": ["pool", "deposit"], "payload": ["wallet", "amount", "total_deposited"] },
    { "name": "reward_claimed", "topics": ["pool", "claimed"], "payload": ["wallet", "amount"] },
    { "name": "withdrawn", "topics": ["pool", "withdrawn"], "payload": ["wallet", "amount"] },
    { "name": "payout_selected", "topics": ["pool", "payout"], "payload": ["winner", "amount"] }
  ],
  "non_emitting_admin_actions": ["add_admin", "remove_admin", "propose", "approve"],
  "errors": {
    "emitted": false,
    "reason": "Soroban transaction errors revert state and events; consumers use the transaction result/error code."
  }
}
```
<!-- EVENT_SCHEMA_SNAPSHOT_END -->

## Admin actions and errors

Successful admin mutations do not emit persistent events in `contract-v1`.
The schema test makes that limitation explicit so adding an admin event becomes
an intentional, reviewed schema change rather than an accidental indexer break.
Failed calls also emit no persistent event because Soroban rolls the transaction
back; consumers must inspect the transaction result and contract error code.

## Backend indexer compatibility

`backend/src/services/stellarIndexer.ts` is the consumer boundary. Its decoder
must preserve both contract topics and normalize them to the names in this
snapshot before downstream analytics rely on an event type. Any decoder change
must add or update backend indexer tests using these exact topic/action pairs.

## Versioning

Additive optional metadata may remain under `contract-v1` only when tuple
positions and existing types do not change. Renamed topics, reordered tuple
values, changed units, or newly persistent admin/error events require a new
schema identifier and a migration note here.
