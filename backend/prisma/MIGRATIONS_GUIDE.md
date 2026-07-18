# Database Migrations Guide

This guide explains how to work with VaultQuest database migrations.

## Quick Overview

The database schema is managed through Prisma migrations, organized by phase:

- **Core** - Essential tables (ActionLedger, PendingEvents)
- **Features** - Feature-specific tables (SavedPools, UserQuests, VaultSettlements)
- **Optimization** - Performance improvements (indexes, query optimization)

## File Structure

```
prisma/
├── schema.prisma           # Current schema definition
├── migrations/
│   ├── README.md           # Migration overview & phase definitions
│   ├── MANIFEST.json       # Structured migration metadata
│   ├── migration_lock.toml # Prisma's migration lock file
│   └── [migration folders] # Individual migration folders
```

## Creating a New Migration

### Step 1: Update the Schema

Edit `prisma/schema.prisma` with your changes:

```prisma
model NewTable {
  id        String   @id @default(uuid()) @db.Uuid
  createdAt DateTime @default(now()) @map("created_at")

  @@map("new_table")
}
```

### Step 2: Generate the Migration

```bash
npm run prisma:migrate
```

This will:

1. Detect schema changes
2. Generate SQL migration file
3. Ask for a migration name

### Step 3: Name It Appropriately

The migration will be created with a default name. Rename the folder to follow our convention:

```
<TIMESTAMP>_<PHASE>_<description>/
```

Examples:

- `20260701000000_feature_new_feature/`
- `20260701000000_optimize_new_indexes/`
- `20260701000000_core_schema_update/`

### Step 4: Review the Migration

Always review the generated SQL before proceeding:

```bash
cat prisma/migrations/<timestamp>_<name>/migration.sql
```

### Step 5: Apply the Migration

```bash
npm run prisma:migrate
```

## Migration Naming Convention

Use this format for consistency:

```
<YYYYMMDDHHMM00>_<phase>_<snake_case_description>
```

| Component   | Format                  | Example           |
| ----------- | ----------------------- | ----------------- |
| Timestamp   | YYYYMMDDHHMM00          | 20260701000000    |
| Phase       | core, feature, optimize | feature           |
| Description | snake_case              | add_user_settings |

**Phase Definitions:**

- `core` - Core functionality (tables, enums, constraints)
- `feature` - Feature additions (new tables)
- `optimize` - Performance (indexes, query optimization)
- `fix` - Bug fixes (data corrections, constraint fixes)
- `refactor` - Schema restructuring (rename tables/columns)

## Common Migration Tasks

### Adding a New Table

```prisma
// schema.prisma
model UserSettings {
  id        String   @id @default(uuid()) @db.Uuid
  userId    String   @map("user_id")
  settings  Json     @default("{}")
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  @@unique([userId])
  @@map("user_settings")
}
```

Migration name: `20260701000000_feature_user_settings`

### Adding an Index

```prisma
// schema.prisma
model ActionLedger {
  // ... fields ...
  @@index([walletAddress, status, createdAt(sort: Desc)])
}
```

Migration name: `20260701000000_optimize_action_query_index`

### Modifying a Column

```prisma
// schema.prisma
model UserQuest {
  progress Float? // Make nullable
  // ...
}
```

Migration name: `20260701000000_core_nullable_progress`

### Adding a Constraint

```prisma
// schema.prisma
model SavedPool {
  // ... fields ...
  @@unique([walletAddress, poolId])
}
```

Migration name: `20260701000000_core_pool_uniqueness`

## Reviewing Migration History

### View Pending Migrations

```bash
npx prisma migrate status
```

### View Applied Migrations

```bash
# Check which migrations have been applied
ls -la prisma/migrations/
```

### View Migration Timeline

```bash
# See the manifest for structured info
cat prisma/migrations/MANIFEST.json | jq '.phases'
```

## Troubleshooting

### Migration Naming Conflicts

If two migrations have the same timestamp, rename one to have a unique timestamp:

```
20260701000000_feature_a/ → 20260701000001_feature_b/
```

### Rollback a Migration

⚠️ **Warning**: Only use in development!

```bash
# Reset local database (deletes all data)
npm run prisma:reset
```

### Check Migration Status

```bash
npx prisma migrate status
```

### Validate Schema

```bash
npx prisma validate
```

## Best Practices

1. **Atomic Changes** - One logical change per migration
2. **Descriptive Names** - Use clear, concise descriptions
3. **Review SQL** - Always review generated SQL before committing
4. **Small Batches** - Avoid large schema changes in one migration
5. **Add Comments** - Document why changes are needed
6. **Test Locally** - Run migrations locally before pushing
7. **Update Docs** - Keep README.md and MANIFEST.json current

## Adding Documentation to Migrations

Add SQL comments to explain the migration:

```sql
-- Migration: Add user settings table for preferences (#123)
-- Purpose: Store user-specific settings and configuration
-- Breaking: No (new table, optional)

CREATE TABLE "user_settings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" TEXT NOT NULL,
    -- ... columns ...
    CONSTRAINT "user_settings_pkey" PRIMARY KEY ("id")
);

-- Index for efficient user lookups
CREATE UNIQUE INDEX "user_settings_user_id_key" ON "user_settings"("user_id");
```

## Related Documentation

- [Prisma Migrations](https://www.prisma.io/docs/concepts/components/prisma-migrate)
- [VaultQuest Architecture](../docs/ARCHITECTURE.md)
- [API Documentation](../docs/API_RESPONSES.md)
- [Migrations README](./migrations/README.md)
- [Migrations Manifest](./migrations/MANIFEST.json)

## Questions?

Refer to:

1. `prisma/migrations/README.md` - Migration phases & structure
2. `prisma/migrations/MANIFEST.json` - Detailed migration info
3. Existing migrations - Use as examples for your changes
