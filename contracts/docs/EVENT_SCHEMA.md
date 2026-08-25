# VaultQuest Soroban event schema

This document is the canonical event contract for pool lifecycle and user
actions. Contract, backend, and frontend changes that add or rename fields must
update this file in the same PR.

## Envelope

Every event uses these topic positions:

| Topic | Value |
|---|---|
| `0` | `"vaultquest"` |
| `1` | schema version, currently `"v1"` |
| `2` | event name |
| `3` | pool id when available, otherwise admin/config scope |

The payload is a Soroban map. Field names below are snake_case in indexer JSON.
Amounts are contract base units encoded as strings.

Indexers should identify an event by `ledger:tx_hash:event_index`. If an event
is reprocessed, upsert by that identity. For action reconciliation, also keep
`tx_hash` and the optional frontend `idempotency_key` from the backend action
ledger when available.

## Required events

| Event | Required for | Payload fields |
|---|---|---|
| `pool_created` | backend indexing, frontend pool list refresh | `pool_id`, `creator`, `asset`, `target_amount`, `opens_at`, `locks_at`, `draws_at`, `admin`, `idempotency_key?` |
| `pool_joined` | backend indexing, frontend position refresh | `pool_id`, `wallet`, `amount`, `shares`, `participant_count`, `idempotency_key?` |
| `drip_deposited` | backend indexing, frontend balance/TVL refresh | `pool_id`, `wallet`, `amount`, `shares_delta`, `total_deposited`, `tvl`, `idempotency_key?` |
| `reward_claimed` | backend indexing, frontend reward history refresh | `pool_id`, `wallet`, `amount`, `asset`, `cycle`, `idempotency_key?` |
| `withdrawn` | backend indexing, frontend position refresh | `pool_id`, `wallet`, `amount`, `shares_burned`, `remaining_shares`, `idempotency_key?` |
| `payout_selected` | backend indexing, frontend winner/reward refresh | `pool_id`, `winner`, `amount`, `asset`, `cycle`, `randomness_ref?` |
| `paused` | backend operations, frontend disabled states | `scope`, `admin`, `reason`, `paused_at` |
| `recovered` | backend operations, frontend disabled states | `scope`, `admin`, `recovered_at` |
| `config_changed` | backend indexing, frontend config refresh | `scope`, `admin`, `key`, `old_value?`, `new_value`, `effective_at` |
| `withdrawal_queued` | backend indexing, frontend queue-position display | `pool_id`, `wallet`, `amount`, `request_id` |
| `withdrawal_fulfilled` | backend indexing, frontend queue/balance refresh | `pool_id`, `queue_head`, `amount_paid` |
| `withdrawal_cancelled` | backend indexing, frontend queue refresh | `pool_id`, `request_id`, `amount_refunded` |
| `governance_epoch_changed` | backend operations, frontend proposal invalidation | `pool_id`, `admin`, `epoch` |
| `proxy_upgrade_proposed` | backend operations, frontend upgrade tracker | `pool_id`, `upgrade_id`, `new_logic`, `breaking`, `ready_at`, `expires_at` |
| `proxy_upgrade_executed` | backend operations, frontend upgrade tracker | `pool_id`, `upgrade_id`, `new_logic`, `executed_at` |

## Normalized indexer examples

```json
{
  "event_id": "12345:tx_abcd:2",
  "tx_hash": "tx_abcd",
  "contract_id": "CD...",
  "name": "pool_joined",
  "version": "v1",
  "pool_id": "pool_2026_05_week_4",
  "payload": {
    "wallet": "G...",
    "amount": "10000000",
    "shares": "10000000",
    "participant_count": 18,
    "idempotency_key": "8d4f4bd3-..."
  }
}
```

```json
{
  "event_id": "12346:tx_efgh:0",
  "tx_hash": "tx_efgh",
  "contract_id": "CD...",
  "name": "config_changed",
  "version": "v1",
  "pool_id": null,
  "payload": {
    "scope": "global",
    "admin": "G...",
    "key": "fee_bps",
    "old_value": "25",
    "new_value": "30",
    "effective_at": 1780012800
  }
}
```

## Versioning

Additive optional fields may ship under the same version. Required field
changes, renamed events, changed topic order, or changed units require a new
schema topic such as `"v2"`. Indexers must continue accepting all supported
versions until a migration note removes the old version from this document.
