# Idempotent Event Ingestion Specification (#726)

## Overview

The Fastify Action-Ledger and Event Indexer process on-chain Soroban/Stellar events and reconcile them against off-chain intent records. Because distributed networks, RPC endpoints, and indexer worker retries may deliver the same event multiple times (e.g., connection drops, timeouts, replay runs), the ingestion pipeline provides database-enforced, atomic idempotency guarantees.

---

## 1. Natural Deduplication Keys

Every on-chain event processed by the ingestion engine is uniquely identified by its natural Soroban / Stellar event key:

| Event Source | Natural Key Format | Storage Identifier | Description |
|---|---|---|---|
| **Soroban RPC Event** | `<19-digit-TOID>-<10-digit-event-index>` | `ChainEvent.id` / `soroban_event_id` | Globally unique 64-bit ledger TOID + 32-bit intra-transaction event index emitted by Soroban. Monotonically increasing. |
| **Pending Event** | `tx_hash` / `soroban_event_id` | `PendingEvent.txHash` | Reconciled match target for incoming client intents. |
| **Client Action Intent** | `UUID` (deterministic or random) | `ActionLedger.idempotencyKey` | Enforced unique by database constraint `action_ledger.idempotency_key`. |
| **Quest Reward Grant** | `sha256(walletAddress + questId)` | `RewardGrant.idempotencyKey` | Deterministic key preventing duplicate reward distribution across backfills and sweeps. |

---

## 2. Storage-Layer Invariant Guarantees

Idempotency is enforced by database-level constraints and atomic transactions, not merely application-level checks:

1. **Append-Only Event Log (`ChainEvent`):**
   - Ingestion starts by appending raw events into `ChainEvent` using `createMany({ skipDuplicates: true })`.
   - The primary key `@id id` (`soroban_event_id`) guarantees that duplicate deliveries of the same event are safe, zero-cost no-ops at the database layer.

2. **Atomic Ingestion & Reconciliation (`LedgerService.reconcileEvent` / `reconcileEvents`):**
   - Uses PostgreSQL transactions (`prisma.$transaction`).
   - If an action is already in a terminal state (`confirmed` or `reverted`), the transaction immediately returns `{ matched: true }` without updating timestamps or re-firing callbacks.
   - For unmatched events, `pending_events` uses `createMany({ skipDuplicates: true })` or `upsert({ update: {} })`.

3. **Transactional Side-Effect Execution:**
   - Critical side-effects (e.g., `onActionConfirmedCallback`, reward grants, balance adjustments) are derived strictly from **newly transitioned rows**, and executed **post-commit**.
   - If a transaction rolls back or an event is redelivered to an already confirmed row, side-effects are never duplicated.

---

## 3. Crash-Safety & Failure Modes

| Failure Scenario | Ingestion Behavior | Recovery Guarantee |
|---|---|---|
| **Crash during RPC fetch** | Cursor is not updated. Next tick restarts from last saved cursor. | Zero events lost; no duplicate rows created. |
| **Crash after `ChainEvent` write, before reconciliation** | `ChainEvent` records already committed; indexer restarts and retries batch. | `createMany(skipDuplicates)` safely skips `ChainEvent` rows and completes reconciliation. |
| **Concurrent duplicate delivery from N workers** | All workers enter transaction. First worker confirms row; remaining workers find row in terminal state and safely no-op. | Exactly 1 confirmation; side-effect callback executes exactly once. |

---

## 4. Verification

Test suite `backend/tests/idempotent-ingestion.spec.ts` validates:
- Concurrent ingestion across multiple workers asserting single execution.
- Idempotent batch replay.
- Multi-event transactions with distinct event IDs.
- Clean recovery from mid-processing worker crashes.
