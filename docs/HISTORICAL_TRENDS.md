# Historical Trend Aggregation for Maintainer Analytics

## Overview

This document describes the historical trend aggregation system for VaultQuest maintainer analytics. The system provides time-series aggregated metrics for usage, failures, recovery actions, and important domain activity over configurable time windows.

## Architecture

### Components

1. **TrendAggregationService** (`backend/src/services/trendAggregationService.ts`)
   - Core service for aggregating trend metrics
   - Handles time window generation and data aggregation
   - Applies privacy redaction to sensitive data
   - Provides export functionality with schema versioning

2. **Trend Aggregation API Routes** (`backend/src/routes/trendAggregation.ts`)
   - RESTful API endpoints for trend aggregation
   - Endpoints for single and multiple metric aggregation
   - Export endpoint with proper headers
   - Persisted aggregate retrieval

3. **TrendAggregate Model** (`backend/prisma/schema.prisma`)
   - Database model for storing aggregated trend data
   - Supports metric-specific aggregation windows
   - Includes schema versioning for future compatibility

4. **DashboardAggregate Model** (`backend/prisma/schema.prisma`)
   - Complementary model for transactionally-consistent dashboard snapshots
   - Watermark-based consistency tracking

### Data Flow

```
User Request → API Route → TrendAggregationService → Prisma Queries → Aggregation → Response
                     ↓
                Privacy Redaction
                     ↓
                Schema Versioning
```

## Metrics

### Available Metrics

| Metric Name | Description | Data Source |
|-------------|-------------|-------------|
| `total_deposits` | Total deposit amount and count | ActionLedger (actionType: deposit, status: confirmed) |
| `total_withdrawals` | Total withdrawal amount and count | ActionLedger (actionType: withdraw, status: confirmed) |
| `total_claims` | Total claim amount and count | ActionLedger (actionType: claim, status: confirmed) |
| `failed_transactions` | Failed transaction count by type | ActionLedger (status: failed, reverted, orphaned) |
| `active_users` | Count of unique active users | ActionLedger (group by walletAddress) |
| `pool_count` | Count of active and total pools | SavedPool |
| `total_tvl` | Total value locked across pools | SavedPool (tvl field) |
| `prize_distributed` | Total prize amount distributed | ActionLedger (actionType: claim) |
| `recovery_actions` | Count of retried and recovered actions | ActionLedger (retryCount > 0) |
| `conflict_resolutions` | Count of conflict-related errors | ActionLedger (errorCode contains "CONCURRENT") |

### Aggregation Windows

| Window | Duration | Use Case |
|--------|----------|----------|
| `hour` | 1 hour | Fine-grained monitoring, anomaly detection |
| `day` | 24 hours | Daily reporting, trend analysis |
| `week` | 7 days | Weekly summaries, planning |
| `month` | 30 days | Monthly reporting, long-term trends |

## API Endpoints

### GET /trends/aggregate

Aggregate trend data for a specific metric and time range.

**Query Parameters:**
- `metricName` (required): The metric to aggregate (see Metrics section)
- `window` (required): Aggregation window (hour, day, week, month)
- `startDate` (required): ISO date string for range start
- `endDate` (required): ISO date string for range end
- `includeMetadata` (optional): Include metadata in response (default: false)

**Example Request:**
```
GET /trends/aggregate?metricName=total_deposits&window=day&startDate=2024-01-01T00:00:00Z&endDate=2024-01-07T23:59:59Z&includeMetadata=true
```

**Example Response:**
```json
{
  "data": {
    "metricName": "total_deposits",
    "window": "day",
    "data": [
      {
        "windowStart": "2024-01-01T00:00:00Z",
        "windowEnd": "2024-01-01T23:59:59Z",
        "value": 5000.00,
        "count": 50,
        "metadata": {
          "uniqueWallets": 25,
          "averageDeposit": 100.00
        }
      }
    ],
    "schemaVersion": 1,
    "generatedAt": "2024-01-08T10:00:00Z"
  }
}
```

### GET /trends/aggregate-multiple

Aggregate multiple metrics for a time range.

**Query Parameters:**
- `metrics` (required): Comma-separated list of metric names
- `window` (required): Aggregation window (hour, day, week, month)
- `startDate` (required): ISO date string for range start
- `endDate` (required): ISO date string for range end

**Example Request:**
```
GET /trends/aggregate-multiple?metrics=total_deposits,total_withdrawals,active_users&window=day&startDate=2024-01-01T00:00:00Z&endDate=2024-01-07T23:59:59Z
```

**Example Response:**
```json
{
  "data": {
    "total_deposits": { /* ... */ },
    "total_withdrawals": { /* ... */ },
    "active_users": { /* ... */ }
  }
}
```

### GET /trends/export

Export trend data for a time range with proper download headers.

**Query Parameters:**
- `metrics` (required): Comma-separated list of metric names
- `windows` (required): Comma-separated list of windows
- `startDate` (required): ISO date string for range start
- `endDate` (required): ISO date string for range end

**Example Request:**
```
GET /trends/export?metrics=total_deposits,total_withdrawals&windows=day,week&startDate=2024-01-01T00:00:00Z&endDate=2024-01-07T23:59:59Z
```

**Response:**
- Content-Type: `application/json`
- Content-Disposition: `attachment; filename="trends-export-{timestamp}.json"`
- Body: Complete export with schema version and metadata

### GET /trends/persisted

Retrieve previously persisted trend aggregates from the database.

**Query Parameters:**
- `metricName` (required): The metric name
- `window` (required): Aggregation window
- `startDate` (required): ISO date string for range start
- `endDate` (required): ISO date string for range end

**Example Request:**
```
GET /trends/persisted?metricName=total_deposits&window=day&startDate=2024-01-01T00:00:00Z&endDate=2024-01-07T23:59:59Z
```

### POST /trends/persist

Persist trend aggregate data to the database (admin only).

**Request Body:**
```json
{
  "metricName": "total_deposits",
  "window": "day",
  "windowStart": "2024-01-01T00:00:00Z",
  "windowEnd": "2024-01-01T23:59:59Z",
  "value": 5000.00,
  "count": 50,
  "metadata": { /* ... */ }
}
```

**Authentication:** Requires admin access

## Privacy and Data Redaction

### Redaction Rules

The trend aggregation system applies privacy redaction to sensitive data:

| Field | Action | Description |
|-------|--------|-------------|
| `walletAddress` | Hash | SHA-256 hash of wallet address |
| `email` | Redact | Completely removed from output |
| `privateKey` | Redact | Completely removed from output |
| `seedPhrase` | Redact | Completely removed from output |

### Privacy Guarantees

- Raw wallet addresses are never included in aggregate reports
- Only counts and totals are exposed, never individual records
- Identifying information is hashed or redacted before export
- Metadata can be optionally included but still respects redaction rules

## Schema Versioning

### Current Schema Version: 1

The trend aggregation system uses schema versioning to ensure compatibility:

- All trend aggregates include a `schemaVersion` field
- Export responses include the schema version
- Future changes to the report structure will increment the version
- Consumers should validate the schema version before processing

### Migration Strategy

When incrementing the schema version:

1. Update `TREND_SCHEMA_VERSION` constant in `trendAggregationService.ts`
2. Document breaking changes in this file
3. Update API documentation
4. Consider providing migration utilities for consumers

## Deterministic Aggregation

### Determinism Requirements

For consistent test results and reproducible analytics:

- Time windows are aligned to UTC boundaries
- Aggregation uses explicit date ranges provided by the caller
- Results are sorted by window start time
- Numeric values use consistent precision
- Empty buckets are included with zero values

### Time Window Alignment

Windows are aligned to natural boundaries:

- **Hour**: Aligned to :00 minutes
- **Day**: Aligned to 00:00:00 UTC
- **Week**: Aligned to Sunday 00:00:00 UTC
- **Month**: Aligned to 1st day 00:00:00 UTC

## Testing

### Test Fixtures

Test fixtures are provided in `backend/tests/trendAggregationFixtures.ts`:

- `TEST_WINDOWS`: Fixed date windows for deterministic testing
- `MOCK_ACTION_LEDGER`: Mock action ledger data
- `MOCK_SAVED_POOLS`: Mock saved pool data
- `EXPECTED_AGGREGATIONS`: Expected results for validation
- `EMPTY_DATASET`: Empty dataset for edge case testing
- `SINGLE_RECORD_DATASET`: Single record for edge case testing
- `generateLargeDataset()`: Function to generate large datasets
- `PRIVACY_SENSITIVE_DATA`: Data for redaction testing

### Running Tests

```bash
# Run trend aggregation tests
pnpm test backend/src/services/trendAggregationService.test.ts

# Run with coverage
pnpm test --coverage backend/src/services/trendAggregationService.test.ts
```

### Test Coverage

Tests cover:
- ✅ Deterministic aggregation for fixture data
- ✅ Privacy redaction for sensitive data
- ✅ Date range handling (single day, multi-day, hour, week)
- ✅ Empty data handling
- ✅ Large result set handling
- ✅ Multiple metric aggregation
- ✅ Export functionality
- ✅ Schema versioning

## Performance Considerations

### Query Optimization

- Use SQL grouping where possible for large datasets
- Leverage database indexes on `metricName`, `windowStart`, and `windowEnd`
- Consider pagination for very large date ranges
- Implement caching for frequently accessed aggregates

### Memory Management

- Process windows sequentially rather than loading all data at once
- Use streaming for export operations on large datasets
- Limit result set size with appropriate defaults

## Integration with Existing Services

### MetricsService

The `TrendAggregationService` complements the existing `MetricsService`:

- `MetricsService` provides current protocol snapshots
- `TrendAggregationService` provides historical time-series data
- Both use the same underlying data models
- Can be used together for comprehensive analytics

### DashboardAggregateService

The `DashboardAggregateService` provides transactionally-consistent snapshots:

- Used for real-time dashboard views
- Watermark-based consistency tracking
- Complementary to trend aggregation
- Trend aggregation provides historical context

## Troubleshooting

### Common Issues

**Issue:** Aggregation returns empty results
- **Cause:** No data in the specified date range
- **Solution:** Verify date range and check that data exists

**Issue:** Slow aggregation for large date ranges
- **Cause:** Querying too much data at once
- **Solution:** Break into smaller date ranges or use persisted aggregates

**Issue:** Schema version mismatch
- **Cause:** Consumer expects different schema version
- **Solution:** Update consumer code or provide migration

**Issue:** Privacy redaction not working
- **Cause:** Field names don't match redaction rules
- **Solution:** Verify field names in data match `PRIVACY_RULES`

## Design Decisions and Tradeoffs

### Deterministic Time Windows

**Decision:** Align windows to UTC boundaries
**Rationale:** Ensures consistent results across timezones and environments
**Tradeoff:** Less flexible for custom window boundaries

### Privacy by Default

**Decision:** Redact sensitive fields by default
**Rationale:** Protects user privacy and prevents accidental data leaks
**Tradeoff:** Limits debugging capability on production data

### Schema Versioning

**Decision:** Explicit schema version field
**Rationale:** Enables safe evolution of the API contract
**Tradeoff:** Requires consumers to handle version changes

### In-Memory Aggregation

**Decision:** Aggregate in service layer rather than pure SQL
**Rationale:** More flexible for complex business logic and metadata
**Tradeoff:** Higher memory usage for very large datasets

### Optional Metadata

**Decision:** Metadata is optional (controlled by query parameter)
**Rationale:** Reduces payload size for simple use cases
**Tradeoff:** Requires additional query parameter when needed

## Future Enhancements

### Potential Improvements

1. **Background Aggregation Job**
   - Scheduled job to pre-compute aggregates
   - Reduces latency for common queries
   - Stores in `TrendAggregate` table

2. **Real-Time Updates**
   - WebSocket-based updates for live metrics
   - Push notifications for threshold alerts

3. **Advanced Metrics**
   - Cohort analysis
   - Funnel metrics
   - Retention metrics

4. **Data Export Formats**
   - CSV export
   - Parquet for large datasets
   - Scheduled report generation

5. **Query Optimization**
   - Materialized views for common aggregations
   - Query result caching
   - Time-series database integration

## Migration Notes

### Database Migration

To add the trend aggregation tables:

```bash
# Generate migration
npx prisma migrate dev --name add_trend_aggregates

# Or use the provided migration file
npx prisma migrate deploy
```

### No Breaking Changes

This implementation:
- Does not modify existing API contracts
- Does not change existing data models
- Adds new tables and services only
- Maintains backward compatibility

## Contributing

When adding new metrics or features:

1. Update the `TrendMetric` type in `trendAggregationService.ts`
2. Implement the aggregation logic in the service
3. Add test fixtures in `trendAggregationFixtures.ts`
4. Update this documentation
5. Increment schema version if contract changes
6. Add appropriate tests

## References

- Related issue: [VaultQuest: Implement historical trend aggregation for maintainer analytics](https://github.com/Obiajulu-gif/vaultquest-archive/issues/XXX)
- Related documentation:
  - [REJECTION_REASONS.md](./REJECTION_REASONS.md)
  - [SESSION_CONTINUITY.md](./SESSION_CONTINUITY.md)
- Related services:
  - `backend/src/services/metricsService.ts`
  - `backend/src/services/dashboardAggregateService.ts`
