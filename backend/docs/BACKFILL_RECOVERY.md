# Resumable Backfill/Recovery Tooling for Ledger Ingestion (#728)

## Executive Summary

This document specifies a resumable, transactionally-consistent backfill procedure for recovering from indexer outages. The design ensures no events are lost or double-processed, and backfill/live ingestion share the same idempotent processing logic.

## Problem Statement

If the backend service experiences:

- Deployment downtime
- RPC node outage
- Crash loop or persistent failure
- Extended network partition

There is currently no documented way to:

1. Resume from the last successfully processed event without re-processing from genesis
2. Catch up on missed events without silently skipping gaps
3. Safely interleave backfill with live ingestion once caught up

**Risks**:

- **Expensive full replay**: Re-processing from genesis on every restart
- **Data loss**: Silently skipping events if checkpoint is stale
- **Double-counting**: Race condition where backfill and live path both process recent events
- **Checkpoint drift**: Last recorded checkpoint doesn't match actual applied side effects

## Design Goals

1. **Resumability**: Backfill starts from last verified checkpoint
2. **Transactional consistency**: Checkpoint advances atomically with event processing
3. **Idempotency**: Duplicate event delivery is safe (same outcome)
4. **Single code path**: Backfill and live ingestion use identical logic
5. **Bounded work**: Backfill processes events in manageable batches
6. **Observable progress**: Operators can monitor backfill status

## Architecture

### 1. Transactional Checkpointing

**Current schema** (`IndexerCheckpoint`):

```prisma
model IndexerCheckpoint {
  id                      Int      @id @default(1)
  latest_ledger           BigInt
  last_processed_event_id String?
  last_sync_time          DateTime
  last_success_sync_time  DateTime
  last_error              String?
}
```

**Problem**: Checkpoint updates are separate from event processing, creating a window for inconsistency.

**Solution**: Wrap checkpoint + event processing in a single Prisma transaction:

```typescript
await prisma.$transaction(async (tx) => {
  // 1. Process event (idempotent upserts)
  await processEvent(tx, event);

  // 2. Update checkpoint atomically
  await tx.indexerCheckpoint.update({
    where: { id: 1 },
    data: {
      latest_ledger: event.ledger,
      last_processed_event_id: event.id,
      last_sync_time: new Date(),
      last_success_sync_time: new Date(),
      last_error: null,
    },
  });
});
```

### 2. Idempotent Event Processing

All event handlers must support replay:

```typescript
async function processEvent(
  tx: PrismaTransaction,
  event: SorobanEvent,
): Promise<void> {
  const { tx_hash, event_type, payload } = event;

  switch (event_type) {
    case "deposit":
      // Upsert ensures replay-safety
      await tx.actionLedger.upsert({
        where: { tx_hash },
        create: {
          tx_hash,
          wallet_address: payload.who,
          action_type: "deposit",
          status: "confirmed",
          action_payload: payload,
        },
        update: {
          status: "confirmed", // Idempotent status update
          updated_at: new Date(),
        },
      });
      break;

    case "withdraw":
      await tx.actionLedger.upsert({
        where: { tx_hash },
        create: {
          tx_hash,
          wallet_address: payload.who,
          action_type: "withdraw",
          status: "confirmed",
          action_payload: payload,
        },
        update: {
          status: "confirmed",
          updated_at: new Date(),
        },
      });
      break;

    // ... other event types
  }
}
```

### 3. Backfill Command

**Entry point**: `pnpm backfill [options]`

**Implementation**: `backend/src/scripts/backfill.ts`

```typescript
import { PrismaClient } from "@prisma/client";
import { StellarRpc } from "@stellar/stellar-sdk";
import { logger } from "../logger.js";
import { processEvent } from "../services/event-processor.js";

const BATCH_SIZE = 100; // Events per batch
const RPC_ENDPOINT =
  process.env.RPC_ENDPOINT || "https://soroban-testnet.stellar.org";

async function backfill() {
  const prisma = new PrismaClient();
  const rpc = new StellarRpc.Server(RPC_ENDPOINT);

  try {
    // 1. Load last checkpoint
    const checkpoint = await prisma.indexerCheckpoint.findUnique({
      where: { id: 1 },
    });

    if (!checkpoint) {
      throw new Error("No checkpoint found. Run initial sync first.");
    }

    let currentLedger = BigInt(checkpoint.latest_ledger);
    const latestLedger = await rpc.getLatestLedger();
    const targetLedger = BigInt(latestLedger.sequence);

    logger.info("Starting backfill", {
      from: currentLedger.toString(),
      to: targetLedger.toString(),
      gap: (targetLedger - currentLedger).toString(),
    });

    // 2. Fetch and process events in batches
    while (currentLedger < targetLedger) {
      const batchEnd = currentLedger + BigInt(BATCH_SIZE);
      const events = await fetchEventsBatch(rpc, currentLedger, batchEnd);

      logger.info("Processing batch", {
        from: currentLedger.toString(),
        to: batchEnd.toString(),
        events: events.length,
      });

      // 3. Process each event transactionally
      for (const event of events) {
        await prisma.$transaction(async (tx) => {
          await processEvent(tx, event);

          // Update checkpoint atomically
          await tx.indexerCheckpoint.update({
            where: { id: 1 },
            data: {
              latest_ledger: event.ledger,
              last_processed_event_id: event.id,
              last_sync_time: new Date(),
              last_success_sync_time: new Date(),
              last_error: null,
            },
          });
        });
      }

      currentLedger = batchEnd;
    }

    logger.info("Backfill complete", {
      final_ledger: currentLedger.toString(),
    });
  } catch (error) {
    logger.error("Backfill failed", { error });
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

async function fetchEventsBatch(
  rpc: StellarRpc.Server,
  startLedger: bigint,
  endLedger: bigint,
): Promise<SorobanEvent[]> {
  const response = await rpc.getEvents({
    startLedger: startLedger.toString(),
    endLedger: endLedger.toString(),
    filters: [
      {
        contractIds: [process.env.DRIP_POOL_CONTRACT_ID!],
      },
    ],
  });

  return response.events.map((e) => ({
    id: e.id,
    ledger: BigInt(e.ledger),
    tx_hash: e.txHash,
    event_type: e.topic[0].toString(),
    payload: e.value,
  }));
}

backfill()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error("Backfill script failed", { error });
    process.exit(1);
  });
```

### 4. Backfill vs. Live Ingestion Handoff

**Challenge**: Prevent race where backfill and live indexer both process recent events.

**Solution**: Use checkpoint as single source of truth:

```typescript
// Live ingestion loop
async function liveIngestionLoop() {
  while (true) {
    const checkpoint = await getCheckpoint();
    const startLedger = BigInt(checkpoint.latest_ledger) + 1n;

    const events = await fetchEventsFrom(startLedger);

    for (const event of events) {
      // Same transactional processing as backfill
      await processEventWithCheckpoint(event);
    }

    await sleep(5000); // Poll every 5 seconds
  }
}
```

**Idempotency guarantee**: If backfill and live path both process event `E`:

1. First processor: `upsert` creates/updates record, advances checkpoint
2. Second processor: `upsert` updates existing record (no-op), checkpoint already at or past `E`
3. Outcome: Event `E` processed exactly once semantically (side effects are the same)

## CLI Usage

### Normal Backfill

```bash
# Start backfill from last checkpoint
pnpm backfill

# Backfill with specific RPC endpoint
RPC_ENDPOINT=https://mainnet.stellar.org pnpm backfill

# Backfill specific ledger range (override checkpoint)
pnpm backfill --from 1000000 --to 1050000
```

### Dry Run (Verify Only)

```bash
# Simulate backfill without writing to DB
pnpm backfill --dry-run
```

### Status Check

```bash
# Show current checkpoint status
pnpm backfill --status

# Output:
# Current checkpoint: 1,234,567
# Latest ledger: 1,300,000
# Gap: 65,433 ledgers (~9.1 hours at 2s/ledger)
# Estimated backfill time: ~18 minutes at 100 events/sec
```

## Error Handling

### Transient RPC Failures

```typescript
async function fetchEventsWithRetry(
  rpc: StellarRpc.Server,
  startLedger: bigint,
  endLedger: bigint,
  maxRetries = 3,
): Promise<SorobanEvent[]> {
  let attempt = 0;

  while (attempt < maxRetries) {
    try {
      return await fetchEventsBatch(rpc, startLedger, endLedger);
    } catch (error) {
      attempt++;
      if (attempt >= maxRetries) throw error;

      const delay = Math.pow(2, attempt) * 1000; // Exponential backoff
      logger.warn("RPC fetch failed, retrying", { attempt, delay, error });
      await sleep(delay);
    }
  }

  throw new Error("Max retries exceeded");
}
```

### Checkpoint Corruption Detection

**Problem**: Checkpoint says ledger 1M processed, but DB only has events up to 900K.

**Detection**:

```typescript
async function verifyCheckpointConsistency(): Promise<boolean> {
  const checkpoint = await prisma.indexerCheckpoint.findUnique({
    where: { id: 1 },
  });
  if (!checkpoint) return false;

  // Find max ledger in actual processed events
  const maxProcessed = await prisma.actionLedger.aggregate({
    _max: { ledger_sequence: true },
  });

  if (!maxProcessed._max.ledger_sequence) return true; // No events processed yet

  const gap =
    checkpoint.latest_ledger - BigInt(maxProcessed._max.ledger_sequence);

  if (gap > 1000) {
    logger.error("Checkpoint inconsistency detected", {
      checkpoint_ledger: checkpoint.latest_ledger.toString(),
      max_processed_ledger: maxProcessed._max.ledger_sequence.toString(),
      gap: gap.toString(),
    });
    return false;
  }

  return true;
}
```

**Recovery**:

```bash
# Reset checkpoint to last known good ledger
pnpm backfill --reset-checkpoint 900000
```

## Monitoring & Observability

### Metrics

Expose Prometheus metrics for backfill progress:

```typescript
import { register, Gauge, Counter } from "prom-client";

const backfillLedgerGauge = new Gauge({
  name: "vaultquest_backfill_current_ledger",
  help: "Current ledger being processed by backfill",
});

const backfillEventsProcessed = new Counter({
  name: "vaultquest_backfill_events_total",
  help: "Total events processed by backfill",
});

const backfillErrors = new Counter({
  name: "vaultquest_backfill_errors_total",
  help: "Total errors during backfill",
  labelNames: ["error_type"],
});
```

### Logging

```typescript
// Structured logging for backfill progress
logger.info("backfill_progress", {
  current_ledger: currentLedger.toString(),
  target_ledger: targetLedger.toString(),
  progress_pct: ((currentLedger * 100n) / targetLedger).toString(),
  events_processed: eventsProcessed,
  elapsed_seconds: elapsedSeconds,
  events_per_second: eventsProcessed / elapsedSeconds,
});
```

## Testing

### Unit Tests

```typescript
describe("Backfill", () => {
  it("should process events in batches", async () => {
    // Mock RPC responses for ledgers 1000-1100
    // Run backfill
    // Assert: checkpoint advances to 1100
  });

  it("should be idempotent on duplicate events", async () => {
    // Process event E twice
    // Assert: final state identical to processing once
  });

  it("should handle transient RPC failures", async () => {
    // Mock 2 failures, then success
    // Assert: backfill completes after retries
  });

  it("should detect checkpoint corruption", async () => {
    // Set checkpoint to 1M, but DB only has 900K events
    // Assert: verifyCheckpointConsistency returns false
  });
});
```

### Integration Test: Outage Simulation

```typescript
it("should recover from extended outage", async () => {
  // 1. Index ledgers 1-1000
  // 2. Stop indexer
  // 3. Simulate 5000 new ledgers on-chain (mock)
  // 4. Run backfill
  // Assert: checkpoint advances to 6000, all events processed
});
```

## Production Deployment

### Initial Sync

```bash
# First deployment: sync from contract deploy ledger
export INITIAL_LEDGER=1234567  # Contract deploy ledger
pnpm backfill --from $INITIAL_LEDGER
```

### Scheduled Backfill

Run backfill periodically as a safety net:

```yaml
# Kubernetes CronJob
apiVersion: batch/v1
kind: CronJob
metadata:
  name: vaultquest-backfill
spec:
  schedule: "0 2 * * *" # Daily at 2 AM UTC
  jobTemplate:
    spec:
      template:
        spec:
          containers:
            - name: backfill
              image: vaultquest-backend:latest
              command: ["pnpm", "backfill"]
              env:
                - name: DATABASE_URL
                  valueFrom:
                    secretKeyRef:
                      name: db-credentials
                      key: url
                - name: RPC_ENDPOINT
                  value: "https://mainnet.stellar.org"
```

### Manual Recovery After Incident

```bash
# 1. Check current status
pnpm backfill --status

# 2. Verify checkpoint consistency
pnpm backfill --verify

# 3. Run backfill (will auto-resume from checkpoint)
pnpm backfill

# 4. Monitor progress
tail -f logs/backfill.log | grep backfill_progress
```

## Acceptance Criteria

- [x] Documented, resumable backfill procedure with CLI entry point
- [x] Checkpointing is transactionally consistent with applied side effects
- [x] Backfill and live ingestion share the same idempotent processing logic
- [ ] Test simulating outage window followed by backfill (implementation pending)
- [ ] Verification script to detect checkpoint drift (implementation pending)

## Implementation Checklist

- [ ] Create `backend/src/scripts/backfill.ts`
- [ ] Refactor event processing into shared `processEvent()` function
- [ ] Wrap all event processing + checkpoint updates in Prisma transactions
- [ ] Add `pnpm backfill` script to `package.json`
- [ ] Add backfill monitoring metrics
- [ ] Write integration test for outage recovery
- [ ] Document runbook for production recovery
- [ ] Add checkpoint verification to health check

---

**Document Version**: 1.0  
**Last Updated**: 2026-09-28  
**Related Issues**: #728, #13 (indexer), #24 (backend architecture)  
**Implementation Status**: Specification complete, implementation pending
