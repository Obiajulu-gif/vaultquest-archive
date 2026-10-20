# Idempotency and Replay Protection for High-Risk Write Operations

## Overview

This document describes the idempotency and replay protection system for VaultQuest high-risk write operations. The system ensures that operations can be safely retried by clients, workers, webhooks, or wallets without creating duplicate records, settlements, notifications, or user-facing side effects.

## Architecture

### Components

1. **IdempotencyService** (`backend/src/services/idempotencyService.ts`)
   - Core service for idempotency key management
   - Handles key validation, creation, and expiration
   - Caches operation outcomes for consistent responses
   - Provides deterministic key generation

2. **IdempotencyKey Model** (`backend/prisma/schema.prisma`)
   - Database model for storing idempotency keys
   - Tracks operation status and cached responses
   - Supports expiration and cleanup

3. **Integration Points**
   - `SavedPoolsService` - Idempotency for pool save operations
   - `NotificationService` - Idempotency for notification creation
   - `LedgerService` - Existing idempotency for actions (via ActionLedger.idempotencyKey)

### Data Flow

```
Client Request → API Route → Service → IdempotencyService → Check Key
                                                    ↓
                                              Key Exists?
                                                    ↓
                                        ┌───────────┴───────────┐
                                        ↓                       ↓
                                    Yes (Valid)            No / Expired
                                        ↓                       ↓
                                Return Cached          Create Key
                                Response                    ↓
                                                            Execute
                                                            Operation
                                                                ↓
                                                        Cache Result
                                                                ↓
                                                        Return Response
```

## Idempotency Keys

### Key Format

Idempotency keys are UUIDs that uniquely identify an operation. Clients can either:

1. **Provide their own UUID** - Recommended for client-generated keys
2. **Use deterministic generation** - For server-side idempotency

```typescript
// Client-generated (recommended)
const idempotencyKey = crypto.randomUUID();

// Deterministic (server-side)
const idempotencyKey = IdempotencyService.generateKey("saved_pool", {
  walletAddress: "wallet-1",
  poolId: "pool-1"
});
```

### Key Lifecycle

1. **Pending** - Key created, operation in progress
2. **Completed** - Operation succeeded, response cached
3. **Failed** - Operation failed, error details cached
4. **Expired** - Key TTL expired, can be reused

### TTL Configuration

| Setting | Value | Description |
|---------|-------|-------------|
| Default TTL | 24 hours | Standard TTL for most operations |
| Minimum TTL | 1 minute | Lower bound for short-lived operations |
| Maximum TTL | 30 days | Upper bound for long-lived operations |

## Operation Types

### Supported Operations

| Operation Type | Description | Integration Status |
|----------------|-------------|-------------------|
| `action` | Deposit, withdraw, claim actions | ✅ Existing (ActionLedger.idempotencyKey) |
| `settlement` | Vault settlement operations | ⏳ Future |
| `saved_pool` | Save/unsave pool operations | ✅ Implemented |
| `notification` | Notification creation | ✅ Implemented |
| `vault_settlement` | Vault-specific settlements | ⏳ Future |

## API Integration

### POST /saved-pools

Add idempotency key to request body:

```json
{
  "wallet_address": "GD...",
  "pool": {
    "pool_id": "pool-1",
    "pool_name": "Pool 1",
    "status": "open",
    "tvl": "5000.00",
    "asset": "USDC",
    "participant_count": 10,
    "expected_yield": "5.0%",
    "prize": "100.00",
    "opens_at": "2024-01-01T00:00:00Z",
    "locks_at": "2024-01-01T12:00:00Z",
    "draws_at": "2024-01-01T18:00:00Z"
  },
  "idempotency_key": "550e8400-e29b-41d4-a716-446655440000"
}
```

**Response Codes:**
- `201` - Pool saved (new)
- `200` - Pool updated (existing) or duplicate returned from cache
- `409` - Operation in progress with this key
- `400` - Invalid idempotency key format

### POST /actions

Existing idempotency via `Idempotency-Key` header:

```
POST /actions
Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000
```

## Service Integration

### SavedPoolsService

```typescript
const savedPoolsService = new SavedPoolsService(
  prisma,
  cacheService,
  categoriesCacheTtlSeconds,
  idempotencyService
);

const result = await savedPoolsService.savePool({
  walletAddress: "wallet-1",
  pool: { /* ... */ },
  idempotencyKey: "550e8400-e29b-41d4-a716-446655440000"
});
```

### NotificationService

```typescript
const notificationService = new NotificationService(
  prisma,
  leadHours,
  idempotencyService
);

// Internal use within generateReminders
await notificationService.createIfMissing(
  { /* notification data */ },
  idempotencyKey
);
```

### Direct IdempotencyService Usage

```typescript
const idempotencyService = new IdempotencyService(prisma);

const result = await idempotencyService.executeWithIdempotency(
  {
    key: "550e8400-e29b-41d4-a716-446655440000",
    operationType: "settlement",
    walletAddress: "wallet-1",
    ttlSeconds: 3600 // 1 hour
  },
  async () => {
    // Perform the operation
    return await executeSettlement(params);
  }
);

console.log(result.wasDuplicate); // true if key was reused
console.log(result.fromCache); // true if response was cached
console.log(result.data); // operation result
```

## Error Handling

### Duplicate Key Errors

When a client retries with the same key:

**Status: Completed**
```json
{
  "data": { /* cached response */ }
}
```
HTTP Status: `200` (or `201` for initial creation)

**Status: Failed**
```json
{
  "error": {
    "code": "IDEMPOTENCY_FAILED",
    "message": "Operation previously failed: VALIDATION_ERROR - Invalid input"
  }
}
```
HTTP Status: `400`

**Status: Pending**
```json
{
  "error": {
    "code": "IDEMPOTENCY_PENDING",
    "message": "Operation is already in progress with this idempotency key"
  }
}
```
HTTP Status: `409`

### Expired Key Errors

Expired keys are automatically deleted and the operation proceeds as new. No error is returned to the client.

### Invalid Key Format

```json
{
  "error": {
    "code": "INVALID_IDEMPOTENCY_KEY",
    "message": "Idempotency-Key header must be a UUID"
  }
}
```
HTTP Status: `400`

## Key Collision Cases

### Same Key, Different Parameters

If a client reuses the same key with different parameters:

1. **If original operation completed**: Returns cached response (ignores new parameters)
2. **If original operation failed**: Returns error (prevents retry with different params)
3. **If original operation pending**: Returns conflict error

**Best Practice**: Use unique keys for unique operations. Include operation parameters in key generation if using deterministic keys.

### Same Key, Different Wallet

Keys are scoped to the operation type and optionally wallet address. Cross-wallet key reuse is prevented by the service:

```typescript
// These are different keys
IdempotencyService.generateKey("saved_pool", { walletAddress: "wallet-1", poolId: "pool-1" });
IdempotencyService.generateKey("saved_pool", { walletAddress: "wallet-2", poolId: "pool-1" });
```

## Testing

### Test Scenarios

1. **Retry after success** - Verify cached response returned
2. **Retry after failure** - Verify error returned
3. **Key collision** - Verify conflict detection
4. **Expired key** - Verify key deletion and new execution
5. **Concurrent requests** - Verify pending status handling

### Running Tests

```bash
# Run idempotency service tests
pnpm test backend/src/services/idempotencyService.test.ts

# Run with coverage
pnpm test --coverage backend/src/services/idempotencyService.test.ts
```

### Test Coverage

Tests cover:
- ✅ Key creation and validation
- ✅ Duplicate request handling
- ✅ Expired key handling
- ✅ Key collision cases
- ✅ Response caching
- ✅ Error handling
- ✅ TTL clamping
- ✅ Deterministic key generation

## Maintenance

### Cleanup Job

Expired keys should be cleaned up periodically to prevent table bloat:

```typescript
// Run daily via cron
const idempotencyService = new IdempotencyService(prisma);
const deletedCount = await idempotencyService.cleanupExpired();
console.log(`Cleaned up ${deletedCount} expired keys`);
```

### Monitoring

Monitor:
- Idempotency key creation rate
- Cache hit rate (should be high for retried operations)
- Expired key cleanup count
- Failed operation rate per key

## Design Decisions and Tradeoffs

### Centralized Service vs. Per-Service Idempotency

**Decision**: Centralized `IdempotencyService` for consistency
**Rationale**: Single source of truth for idempotency logic, easier to maintain and test
**Tradeoff**: Additional service dependency, but minor overhead

### UUID vs Deterministic Keys

**Decision**: Support both UUID and deterministic keys
**Rationale**: Flexibility for different use cases (client-generated vs server-generated)
**Tradeoff**: Slightly more complex key generation logic

### Response Caching

**Decision**: Cache successful responses only
**Rationale**: Failed operations should be retried with potentially different parameters
**Tradeoff**: Failed operations can't be cached, but this is intentional

### TTL Configuration

**Decision**: Configurable TTL with min/max bounds
**Rationale**: Balance between safety (long TTL) and storage (short TTL)
**Tradeoff**: Additional complexity in TTL validation

### Key Scope

**Decision**: Keys scoped to operation type and optionally wallet
**Rationale**: Prevents cross-operation and cross-wallet key reuse
**Tradeoff**: Slightly more complex key checking logic

## Migration Notes

### Database Migration

To add the idempotency keys table:

```bash
# Generate migration
npx prisma migrate dev --name add_idempotency_keys

# Or use the provided migration file
npx prisma migrate deploy
```

### Service Constructor Changes

Services now accept an optional `IdempotencyService` parameter:

```typescript
// Before
const savedPoolsService = new SavedPoolsService(prisma);

// After (backward compatible)
const savedPoolsService = new SavedPoolsService(prisma, cacheService, categoriesCacheTtlSeconds, idempotencyService);
```

### No Breaking Changes

This implementation:
- Does not modify existing API contracts
- IdempotencyService is optional in service constructors
- Existing action idempotency continues to work
- Adds new functionality only when idempotency key is provided

## Future Enhancements

### Potential Improvements

1. **Redis-based caching** - For high-throughput scenarios
2. **Key versioning** - To support API contract changes
3. **Batch key checking** - For multiple operations
4. **Key metadata** - Store additional context with keys
5. **Automatic TTL adjustment** - Based on operation type

### Additional Operation Types

- `settlement` - Vault settlement operations
- `vault_settlement` - Vault-specific settlements
- `prize_distribution` - Prize distribution operations
- `user_quest` - User quest completion operations

## Troubleshooting

### Common Issues

**Issue:** Duplicate operations still creating records
- **Cause:** Idempotency key not provided or service not initialized
- **Solution:** Ensure idempotency key is in request body and service has IdempotencyService

**Issue:** Operation always returns pending
- **Cause:** Previous operation stuck in pending state
- **Solution:** Check for long-running operations, consider manual key cleanup

**Issue:** Key rejected as invalid
- **Cause:** Non-UUID format provided
- **Solution:** Ensure key is valid UUID v4 format

**Issue:** High memory usage from cached responses
- **Cause:** Large responses cached with long TTL
- **Solution:** Reduce TTL or implement response size limits

## Security Considerations

### Key Privacy

- Idempotency keys are not secrets
- Keys do not authorize operations independently
- Authentication/authorization still required
- Keys can be safely logged for debugging

### Key Guessing

- UUID v4 keys have 122 bits of randomness
- Practical impossibility of collision/guessing
- Deterministic keys use SHA-256 (cryptographically secure)

### Key Leakage

- Keys in logs are not security-sensitive
- Keys in URLs are safe (no auth bypass)
- Consider key rotation if leaked in unusual circumstances

## References

- Related issue: [VaultQuest: Add idempotency and replay protection for high-risk write operations](https://github.com/Obiajulu-gif/vaultquest-archive/issues/XXX)
- Related documentation:
  - [REJECTION_REASONS.md](./REJECTION_REASONS.md)
  - [SESSION_CONTINUITY.md](./SESSION_CONTINUITY.md)
  - [HISTORICAL_TRENDS.md](./HISTORICAL_TRENDS.md)
- Related services:
  - `backend/src/services/ledger.ts` (existing action idempotency)
  - `backend/src/services/savedPools.ts`
  - `backend/src/services/notificationService.ts`
