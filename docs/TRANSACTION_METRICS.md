# Transaction Confirmation Metrics

## Overview

VaultQuest tracks transaction confirmation duration from wallet submission through to confirmed and indexed state. This enables maintainers to monitor network performance and distinguish between network delays and indexer processing time.

## Tracked Actions

- `deposit`: User deposits into vaults
- `claim`: Prize or yield claims
- `withdrawal`: Vault withdrawals
- `pool_creation`: New pool creation
- `admin_action`: Administrative operations

## Metrics Captured

### Timestamps

- **Submitted At**: When transaction is submitted from wallet
- **Confirmed At**: When transaction is confirmed on-chain
- **Indexed At**: When transaction is fully processed by indexer

### Derived Metrics

- **Submission to Confirmation**: Network confirmation time
- **Confirmation to Indexing**: Indexer processing time
- **Total Duration**: End-to-end time from submission to indexed

### Percentiles

- **P50 (Median)**: 50th percentile duration
- **P95**: 95th percentile duration
- **P99**: 99th percentile duration

## API Endpoints

### Get All Metrics

```
GET /api/v1/metrics/transactions?since=2026-07-01T00:00:00Z
```

Returns metrics for all action types with optional time filter.

### Get Metrics by Action Type

```
GET /api/v1/metrics/transactions/deposit?network=Stellar&since=2026-07-01T00:00:00Z
```

Returns metrics for specific action type with optional network and time filters.

## Alert Thresholds

### Recommended Thresholds

- **Deposit P95**: Alert if > 30 seconds
- **Claim P95**: Alert if > 20 seconds
- **Withdrawal P95**: Alert if > 30 seconds
- **Indexer Delay P95**: Alert if > 10 seconds

### Distinguishing Delays

**Network Delay**: High submission-to-confirmation time

- May indicate network congestion
- Check network status and fee markets

**Indexer Delay**: High confirmation-to-indexing time

- May indicate indexer backlog
- Check indexer health endpoint
- Consider indexer replay if needed

## Privacy

- Wallet addresses are stored for auditing but excluded from public metrics
- Only aggregate statistics are exposed via API
- Individual transaction details require authenticated access

## Monitoring Dashboard

Use the admin operations panel to:

- View real-time confirmation metrics
- Compare performance by action type and network
- Set up alerting for threshold violations
- Analyze trends over custom time periods
