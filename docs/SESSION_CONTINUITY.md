# Cross-Device Session Continuity and Conflict Handling

This document describes the implementation of optimistic concurrency control and conflict resolution for VaultQuest to prevent silent overwrites when users work across tabs or devices.

## Overview

When users interact with VaultQuest across multiple browser tabs or devices, concurrent edits can lead to stale client state silently overwriting newer data. This implementation provides:

- **Optimistic concurrency control** using version tokens
- **Conflict detection** when stale data is used in mutations
- **User-facing conflict resolution** with clear recovery actions
- **Automatic retry logic** for transient conflicts

## Architecture

### Version Tokens

Version tokens combine timestamps with entity-specific metadata to create unique identifiers that change whenever an entity is modified:

```typescript
interface VersionToken {
  entityId: string;      // e.g., pool ID, wallet address
  entityType: string;    // e.g., 'saved_pool', 'user_position'
  version: number;        // last modification timestamp
  sequence?: number;     // optional sequence number
}
```

### Conflict Detection Flow

1. **Read**: Client fetches data and captures the version token
2. **Write**: Client sends the expected version token with the mutation
3. **Validate**: Server compares expected version with current version
4. **Conflict**: If versions don't match, operation is rejected with conflict error
5. **Resolve**: User is prompted to refresh data and retry

### Integration Points

#### 1. Saved Pools Hook

The `useSavedPools` hook now includes version token tracking:

```typescript
export interface SavedPoolsResource extends AsyncResource<SavedPoolEntry[]> {
  savePool: (pool: PoolSummary) => Promise<SavedPoolEntry>;
  unsavePool: (poolId: string) => Promise<number>;
  versionToken: VersionToken | null;  // NEW
}
```

Save/unsave operations now use version checking:

```typescript
const savePool = useCallback(
  async (pool: PoolSummary) => {
    const result = await executeWithVersionCheck(
      async () => {
        const saved = await api.savePool(walletAddress, pool);
        invalidateSavedPools();
        query.refetch();
        return saved;
      },
      versionToken,
      versionToken,
    );

    if (!result.success) {
      throw new Error(result.conflict.userMessage);
    }

    return result.data;
  },
  [api, invalidateSavedPools, query, walletAddress, versionToken],
);
```

#### 2. Conflict-Aware Operations Hook

The `useConflictAwareOperation` hook provides conflict state management:

```typescript
const { state, execute, resolveConflict, refresh } = useConflictAwareOperation(
  getVersion,
  onRefresh
);
```

#### 3. UI Components

Two UI components for conflict resolution:

- **ConflictResolutionUI**: Full-featured conflict banner with refresh/dismiss actions
- **ConflictBanner**: Minimal inline conflict banner

## API

### Core Functions

#### `createVersionToken(entityId, entityType, updatedAt, sequence?)`

Creates a version token from entity data.

#### `isVersionValid(currentVersion, expectedVersion)`

Checks if a version token is still valid (not stale).

#### `executeWithVersionCheck(operation, currentVersion, expectedVersion)`

Executes an operation with optimistic concurrency control.

#### `executeWithRetryOnConflict(operation, getVersion, maxRetries?)`

Wraps an operation with automatic retry on conflict.

#### `extractVersionToken(data, entityId, entityType)`

Extracts version token from common data structures.

### React Hooks

#### `useConflictAwareOperation(getVersion, onRefresh)`

Manages conflict state and operation execution.

### Components

#### `ConflictResolutionUI({ conflict, onResolve, onDismiss, isResolving })`

Full-featured conflict resolution UI.

#### `ConflictBanner({ conflict, onResolve, onDismiss })`

Minimal inline conflict banner.

## Usage Example

### Saving a Pool with Conflict Detection

```typescript
function PoolSaveButton({ pool }) {
  const { savePool, versionToken, refetch } = useSavedPools(walletAddress);
  const { state, execute, resolveConflict } = useConflictAwareOperation(
    () => versionToken,
    refetch
  );

  const handleSave = async () => {
    const result = await execute(() => savePool(pool));

    if (!result.success) {
      // Show conflict UI
      return;
    }

    // Success
  };

  return (
    <>
      <button onClick={handleSave}>Save Pool</button>
      {state.hasConflict && (
        <ConflictResolutionUI
          conflict={state.conflict}
          onResolve={resolveConflict}
          onDismiss={() => setState({ hasConflict: false })}
        />
      )}
    </>
  );
}
```

### Automatic Retry on Conflict

```typescript
const result = await executeWithRetryOnConflict(
  async (version) => {
    return await api.updatePool(poolId, data, version);
  },
  async () => {
    const pool = await api.getPool(poolId);
    return extractVersionToken(pool, poolId, "pool");
  },
  2 // max retries
);
```

## Conflict Categories

### Concurrent Modification

When data is modified in another tab/device between read and write:

- **Reason Code**: `VAULT_CONCURRENT_MODIFICATION`
- **User Message**: "This item was modified by another operation."
- **Recovery Hint**: "Refresh the page and try again."
- **Retryable**: true

### Stale Data

When client data is older than server data:

- **Reason Code**: `VAULT_STALE_POOL_DATA` or `VAULT_STALE_POSITION_DATA`
- **User Message**: "The pool data is out of date."
- **Recovery Hint**: "Refresh the page and try again."
- **Retryable**: true

## Testing

### Unit Tests

Run concurrency control tests:

```bash
pnpm test lib/concurrencyControl.test.ts
pnpm test lib/useConflictAwareOperation.test.ts
```

### Integration Tests

Test concurrent edit scenarios:

```bash
# Test stale writes
pnpm test lib/concurrencyControl.test.ts -- --grep "concurrent edit scenarios"

# Test retry logic
pnpm test lib/concurrencyControl.test.ts -- --grep "executeWithRetryOnConflict"
```

## Design Decisions

### Optimistic vs Pessimistic Locking

We chose optimistic locking (version tokens) over pessimistic locking because:

- **Better UX**: Users can read without blocking
- **Scalability**: No server-side lock management overhead
- **Web-friendly**: Works across tabs/devices without complex coordination
- **Conflict-aware**: Conflicts are detected and surfaced to users

### Version Token Structure

Version tokens include:
- `entityId`: Unique identifier for the entity
- `entityType`: Type of entity (for disambiguation)
- `version`: Timestamp (monotonic)
- `sequence`: Optional sequence number for additional ordering

This structure provides:
- Uniqueness across entity types
- Temporal ordering
- Extensibility for future requirements

### Retry Strategy

Automatic retry with exponential backoff:
- Max 2 retries by default
- Each retry fetches fresh version
- Fails with conflict error after retries exhausted

This balances:
- User experience (automatic recovery)
- System resources (limited retries)
- Data consistency (eventual success or clear failure)

### Integration with Existing Cross-Tab Consistency

The implementation builds on the existing cross-tab cache consistency layer (`consistency.ts`):

- Uses the same monotonic `updatedAt` ordering
- Integrates with existing `VaultQueryClient`
- Leverages existing BroadcastChannel/storage event fallback
- Maintains backward compatibility

## Migration Notes

### Adding Version Control to New Workflows

To add version control to a new workflow:

1. Add `versionToken` to the resource interface
2. Extract version token from data in the hook
3. Wrap operations with `executeWithVersionCheck`
4. Handle conflict errors in the UI

Example:

```typescript
// Before
export interface MyResource extends AsyncResource<MyData> {
  update: (data: MyData) => Promise<MyData>;
}

// After
export interface MyResource extends AsyncResource<MyData> {
  update: (data: MyData) => Promise<MyData>;
  versionToken: VersionToken | null;
}
```

### Backend Changes

Backend APIs need to:
- Return `updated_at` timestamps on all mutable entities
- Accept optional version tokens in mutation requests
- Return 409 Conflict when versions don't match
- Include current version in conflict response

Example conflict response:

```json
{
  "error": {
    "code": "VAULT_CONCURRENT_MODIFICATION",
    "category": "stale_state",
    "message": "This item was modified by another operation.",
    "retryable": true,
    "recovery": "Refresh the page and try again.",
    "current_version": {
      "entityId": "pool-123",
      "entityType": "saved_pool",
      "version": 1234567891
    }
  }
}
```

## Performance Considerations

### Version Token Overhead

- Version tokens are small (~50 bytes)
- Stored in-memory alongside cached data
- No additional network requests
- Minimal CPU overhead for comparison

### Conflict Rate

Expected conflict rate is low:
- Most users don't actively edit across tabs/devices
- Version checks are fast (simple comparison)
- Retry logic handles transient conflicts

### Storage Impact

Version tokens are already included in data:
- No additional storage required
- Uses existing `updated_at` fields
- Snapshot persistence includes version information

## Security Considerations

### Version Token Spoofing

Version tokens are client-provided but validated server-side:
- Server maintains authoritative version
- Client cannot force a write with stale version
- Version mismatches always rejected

### Information Disclosure

Version tokens reveal:
- Entity IDs (already exposed in UI)
- Entity types (already exposed in UI)
- Timestamps (already exposed in UI)

No sensitive information is exposed.

## Future Enhancements

### Potential Improvements

1. **Real-time Conflict Notification**: Push notifications when data changes
2. **Conflict Resolution Merge**: Automatic merge for non-conflicting changes
3. **Conflict History**: Track conflict frequency per user
4. **Smart Retry**: Adaptive retry strategy based on conflict patterns
5. **Offline Support**: Queue operations and resolve conflicts when online

### Extension Points

The implementation is designed for extension:
- New entity types can add their own version token extraction
- Custom conflict resolution strategies can be plugged in
- UI components can be customized per use case
