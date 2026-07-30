# Database Migrations

This directory contains all database migrations for the VaultQuest backend, organized by phase and feature.

## Migration Structure

Migrations are named with the following pattern:

```
<TIMESTAMP>_<PHASE>_<DESCRIPTION>/
```

Where:

- **TIMESTAMP**: ISO timestamp (YYYYMMDDHHMM00) for ordering
- **PHASE**: Migration category (core, feature, optimize)
- **DESCRIPTION**: Brief description of what the migration does

## Migration Phases

### Phase 1: Core (`core_*`)

Foundational tables and structures required for the system to operate.

| Migration                                     | Description                                              |
| --------------------------------------------- | -------------------------------------------------------- |
| `20260423000000_core_init`                    | Initial schema with ActionLedger and PendingEvent tables |
| `20260423000001_core_nullable_action_payload` | Make action_payload nullable in ActionLedger             |
| `20260528000000_core_unique_tx_hash`          | Add unique constraint on tx_hash (supports idempotency)  |

**Key Tables:**

- `action_ledger` - Transaction tracking and status management
- `pending_events` - Event queue for blockchain events

### Phase 2: Features (`feature_*`)

Additional feature tables added after core infrastructure is stable.

| Migration                                   | Description                          |
| ------------------------------------------- | ------------------------------------ |
| `20260529000000_feature_saved_pools`        | User pool watchlist functionality    |
| `20260530000000_feature_indexer_checkpoint` | Blockchain indexer state tracking    |
| `20260531000000_feature_user_quests`        | Quest progress tracking system       |
| `20260531000001_feature_vault_settlements`  | Vault settlement and escrow pipeline |

**Key Tables:**

- `saved_pools` - User's saved/watchlisted pools
- `indexer_checkpoints` - Blockchain indexer state
- `user_quests` - User quest progress
- `vault_settlements` - Settlement state machine

### Phase 3: Optimization (`optimize_*`)

Performance improvements, index additions, and query optimizations.

| Migration                               | Description                                 |
| --------------------------------------- | ------------------------------------------- |
| `20260627000000_optimize_query_indexes` | Add indexes for frequently-filtered columns |

**Indexes Added:**

- `action_ledger_wallet_action_type_idx` - Filter by action type within wallet range
- `action_ledger_status_created_at_idx` - Status filter for pending/confirmed sweeps
- `vault_settlements_recipient_state_idx` - Recipient lookup for vault releases
- `pending_events_status_hint_received_at_idx` - Status hint filter for event processing
- `saved_pools_pool_id_idx` - Pool ID lookup across wallets

## Running Migrations

### Development

```bash
# Create a new migration
npm run prisma:migrate

# Apply pending migrations
npm run prisma:deploy
```

### Production

```bash
# Deploy pending migrations (non-interactive)
npm run prisma:deploy
```

## Understanding Migration Dependencies

Migrations are applied in **timestamp order** and are **one-directional**. The order is:

1. **20260423000000** - Core init
2. **20260423000001** - Core modifications
3. **20260528000000** - Core enhancements
4. **20260529000000** - First feature
5. **20260530000000** → **20260531000001** - Sequential features
6. **20260627000000** - Optimizations (depends on all prior tables existing)

Never reorder or delete migrations from the migrations directory. Prisma tracks which migrations have been applied and will fail if the history is tampered with.

## Adding New Migrations

1. Create schema changes in `prisma/schema.prisma`
2. Run `npm run prisma:migrate` and name your migration descriptively
3. Rename the generated folder to follow the naming convention:
   ```
   <TIMESTAMP>_<PHASE>_<description>
   ```
4. Update this README with details about the new migration

## Common Issues

### Migration Lock Failed

If you see "migration lock failed" errors:

```bash
# Check for stale locks
npx prisma migrate resolve --rolled-back <migration-name>
```

### Unsync'd Migrations

If your local schema doesn't match migrations:

```bash
# See migration status
npx prisma migrate status

# Force sync (development only)
npx prisma migrate reset
```

## References

- [Prisma Migrations Docs](https://www.prisma.io/docs/concepts/components/prisma-migrate)
- [VaultQuest Architecture](../docs/ARCHITECTURE.md)
- [API Responses Documentation](../docs/API_RESPONSES.md)
