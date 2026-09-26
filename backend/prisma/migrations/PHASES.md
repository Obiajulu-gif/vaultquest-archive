# Migration Phases

Visual reference for understanding the database evolution through migration phases.

## Phase Overview

```
┌─────────────────────────────────────────────────────────────┐
│ PHASE 1: CORE (Foundation)                                  │
│ ─────────────────────────────────────────────────────────── │
│ Establishes core transaction tracking and event queue       │
│                                                              │
│ Timeline: April 23 - May 28, 2026                           │
│ Migrations: 3                                                │
│ Tables: 2                                                    │
│                                                              │
│ ├─ 20260423000000 | Initial Schema                          │
│ │   └─ CREATE action_ledger (idempotency key, status)       │
│ │   └─ CREATE pending_events (event queue)                  │
│ │                                                            │
│ ├─ 20260423000001 | Make action_payload nullable           │
│ │   └─ ALTER action_ledger (optional payload)               │
│ │                                                            │
│ └─ 20260528000000 | Add TX Hash Uniqueness                 │
│     └─ CREATE UNIQUE INDEX (enforce 1 action per tx)        │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│ PHASE 2: FEATURES (Functionality)                           │
│ ─────────────────────────────────────────────────────────── │
│ Adds business features built on core foundation             │
│                                                              │
│ Timeline: May 29 - May 31, 2026                            │
│ Migrations: 4                                                │
│ Tables: 4                                                    │
│                                                              │
│ ├─ 20260529000000 | SavedPools Watchlist                   │
│ │   └─ CREATE saved_pools (user pool watchlist)             │
│ │                                                            │
│ ├─ 20260530000000 | Indexer Checkpoint                     │
│ │   └─ CREATE indexer_checkpoints (blockchain sync state)   │
│ │                                                            │
│ ├─ 20260531000000 | User Quest Progress                    │
│ │   └─ CREATE user_quests (quest tracking)                  │
│ │                                                            │
│ └─ 20260531000001 | Vault Settlements                      │
│     └─ CREATE vault_settlements (settlement pipeline)        │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│ PHASE 3: OPTIMIZATION (Performance)                         │
│ ─────────────────────────────────────────────────────────── │
│ Improves query performance with strategic indexing          │
│                                                              │
│ Timeline: June 27, 2026                                    │
│ Migrations: 1                                                │
│ Indexes: 5                                                   │
│                                                              │
│ └─ 20260627000000 | Query Index Optimization              │
│     ├─ INDEX action_ledger (wallet + action_type)           │
│     ├─ INDEX action_ledger (status + created_at)            │
│     ├─ INDEX vault_settlements (recipient + state)          │
│     ├─ INDEX pending_events (status_hint + received_at)     │
│     └─ INDEX saved_pools (pool_id)                          │
└─────────────────────────────────────────────────────────────┘
```

## Table Creation Timeline

```
April 23, 2026
  └─ action_ledger (transaction tracking)
     pending_events (event queue)

May 29, 2026
  └─ saved_pools (user watchlist)

May 30, 2026
  └─ indexer_checkpoints (indexer state)

May 31, 2026
  ├─ user_quests (quest progress)
  └─ vault_settlements (settlement pipeline)

June 27, 2026
  └─ [Indexes added to existing tables]
```

## Feature Dependencies

```
┌─────────────────────┐
│   CORE TABLES       │
│                     │
│ action_ledger ◄──┐  │
│ pending_events    │  │
└──────────┬────────┘  │
           │           │
           ▼           │
┌──────────────────────────────────┐
│   DEPENDENT FEATURES             │
│                                  │
│ saved_pools ◄────────────────────┘
│ indexer_checkpoints
│ user_quests
│ vault_settlements
│                                  │
│ (All depend on core tables for  │
│  wallet address, status, etc.)   │
└──────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────┐
│   PERFORMANCE LAYER              │
│                                  │
│ Strategic Indexes                │
│ (Optimize all table queries)     │
└──────────────────────────────────┘
```

## Apply Order (IMPORTANT)

Migrations MUST be applied in timestamp order:

1. **20260423000000** - core_init (REQUIRED)
2. **20260423000001** - core_nullable_action_payload
3. **20260528000000** - core_unique_tx_hash
4. **20260529000000** - feature_saved_pools (can skip if feature not used)
5. **20260530000000** - feature_indexer_checkpoint (can skip if feature not used)
6. **20260531000000** - feature_user_quests (can skip if feature not used)
7. **20260531000001** - feature_vault_settlements (can skip if feature not used)
8. **20260627000000** - optimize_query_indexes (recommended for performance)

**Note:** Feature migrations can be skipped individually, but core migrations are required.

## Naming Pattern

Each migration follows this pattern:

```
20260423000000_core_init
│           ││        │
│           ││        └─ Description (snake_case)
│           │└─ Phase (core, feature, optimize)
│           └─ Separator (underscore)
└─ Timestamp (YYYYMMDDHHMM00)
```

### Phase Prefixes

| Prefix      | Purpose           | Examples                     |
| ----------- | ----------------- | ---------------------------- |
| `core_`     | Foundation tables | init, nullable*\*, unique*\* |
| `feature_`  | Business features | saved_pools, user_quests     |
| `optimize_` | Performance       | query_indexes, indexes       |
| `fix_`      | Bug fixes         | constraint*\*, data*\*       |
| `refactor_` | Schema changes    | rename*\*, restructure*\*    |

## Statistics

```
Total Migrations:  8
├─ Core:          3 (April 23 - May 28)
├─ Features:      4 (May 29 - May 31)
└─ Optimization:  1 (June 27)

Total Tables:      6
├─ From Phase 1:  2 (action_ledger, pending_events)
├─ From Phase 2:  4 (saved_pools, indexer_checkpoints, user_quests, vault_settlements)
└─ From Phase 3:  0 (adds indexes only)

Total Indexes:     9 (counting unique indexes and primary keys)
├─ Created in P1:  4
├─ Created in P2:  7
└─ Created in P3:  5 (additional optimization indexes)
```

## Related Files

- `README.md` - Detailed migration documentation
- `MANIFEST.json` - Structured migration metadata
- `../MIGRATIONS_GUIDE.md` - Developer guide for creating migrations
