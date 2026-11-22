# Multi-Actor Concurrency Harness (Issue #4)

## Overview

Test framework for simulating concurrent actors racing on critical mutations. Verifies idempotency, compare-and-swap logic, and conflict resolution under duplicate submissions, stale versions, and retry storms.

## Architecture

### runConcurrentRaces

Orchestrates N concurrent actors attempting the same operation:

```typescript
await runConcurrentRaces(
  scenario,
  async (actorId) => {
    // Each actor attempts the same operation
    return await ledger.createAction({ idempotencyKey: "shared-key" });
  },
  async (results) => {
    // Verify exact