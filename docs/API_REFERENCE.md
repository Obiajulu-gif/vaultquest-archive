# VaultQuest API Reference

Comprehensive reference documentation for the VaultQuest backend REST API. This document covers all public endpoints with request/response schemas and curl examples.

## Table of Contents

- [Base URL](#base-url)
- [Authentication](#authentication)
- [Response Format](#response-format)
- [Error Handling](#error-handling)
- [Rate Limiting](#rate-limiting)
- [Endpoints](#endpoints)
  - [Health Check](#health-check)
  - [Actions](#actions)
  - [Dashboard](#dashboard)
  - [Saved Pools](#saved-pools)
  - [Metrics](#metrics)
- [Status Lifecycle](#status-lifecycle)
- [Data Types](#data-types)

## Base URL

```
Production: https://api.vaultquest.io
Development: http://localhost:3001
```

All endpoints are prefixed with the base URL.

## Authentication

The API does not use session-based authentication. Wallet-scoped endpoints accept the connected wallet address as a query parameter. The caller is responsible for passing their own wallet address.

## Response Format

### Success Response

Single resource:

```json
{
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "status": "confirmed"
  }
}
```

List response with pagination:

```json
{
  "data": [
    { "id": "550e8400-..." }
  ],
  "meta": {
    "pagination": {
      "next_cursor": "4f2b9a1d-...",
      "limit": 25,
      "has_more": true
    }
  }
}
```

### Error Response

```json
{
  "error": {
    "code": "INVALID_PAYLOAD",
    "message": "Validation failed",
    "details": "Additional context",
    "issues": []
  }
}
```

## Error Handling

### HTTP Status Codes

| Status | Code | Description |
|--------|------|-------------|
| 200 | OK | Request succeeded |
| 201 | Created | Resource created successfully |
| 400 | Bad Request | Invalid request payload or parameters |
| 401 | Unauthorized | Missing or invalid credentials |
| 404 | Not Found | Resource does not exist |
| 409 | Conflict | State conflict or idempotency violation |
| 429 | Too Many Requests | Rate limit exceeded |
| 500 | Internal Server Error | Unexpected server error |

### Error Codes

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `INVALID_PAYLOAD` | 400 | Request validation failed |
| `UNAUTHORIZED` | 401 | Authentication required |
| `NOT_FOUND` | 404 | Resource not found |
| `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD` | 409 | Idempotency key conflict |
| `TX_HASH_ALREADY_ATTACHED` | 409 | Transaction hash already used |
| `ILLEGAL_TRANSITION` | 409 | Invalid status transition |
| `NETWORK_ERROR` | 503 | Upstream service unavailable |
| `INTERNAL` | 500 | Internal server error |

## Rate Limiting

The API implements rate limiting to prevent abuse:

- Default: 100 requests per minute per IP address
- Headers included in response:
  - `X-RateLimit-Limit`: Maximum requests allowed
  - `X-RateLimit-Remaining`: Requests remaining in current window
  - `X-RateLimit-Reset`: Time when the rate limit resets (Unix timestamp)

When rate limited, the API returns HTTP 429 with:

```json
{
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "Too many requests. Please try again later."
  }
}
```

## Endpoints

### Health Check

#### GET /health

Check if the API is operational.

**Request**

```bash
curl -X GET \
  'http://localhost:3001/health'
```

**Response 200 OK**

```json
{
  "data": {
    "ok": true
  }
}
```

#### GET /health/indexer

Check the health status of the blockchain indexer.

**Request**

```bash
curl -X GET \
  'http://localhost:3001/health/indexer'
```

**Response 200 OK**

```json
{
  "data": {
    "healthy": true,
    "lastCheckpointLedger": 1234567,
    "lastCheckpointTime": "2026-06-27T10:00:00.000Z",
    "lagSeconds": 5
  }
}
```

### Actions

Actions represent user intents (deposits, withdrawals, etc.) and track their lifecycle from creation through blockchain confirmation.

#### POST /actions

Create a new action intent.

**Headers**

| Header | Type | Required | Description |
|--------|------|----------|-------------|
| `Idempotency-Key` | UUID v4 | Yes | Unique identifier for idempotent requests |
| `Content-Type` | string | Yes | `application/json` |

**Request Body**

```json
{
  "wallet_address": "GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCD",
  "action_type": "deposit",
  "action_payload": {
    "vault_id": "42",
    "amount": "1000000",
    "token": "USDC"
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `wallet_address` | string | Yes | Stellar wallet address (max 120 chars) |
| `action_type` | enum | Yes | One of: `deposit`, `withdraw`, `create_vault`, `claim`, `select_winner` |
| `action_payload` | object | Yes | Action-specific data (shape varies by action_type) |

**Request**

```bash
curl -X POST \
  'http://localhost:3001/actions' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000' \
  -d '{
    "wallet_address": "GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCD",
    "action_type": "deposit",
    "action_payload": {
      "vault_id": "42",
      "amount": "1000000",
      "token": "USDC"
    }
  }'
```

**Response 201 Created** (new action) or **200 OK** (idempotent replay)

```json
{
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "idempotency_key": "550e8400-e29b-41d4-a716-446655440000",
    "wallet_address": "GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCD",
    "action_type": "deposit",
    "action_payload": {
      "vault_id": "42",
      "amount": "1000000",
      "token": "USDC"
    },
    "status": "pending",
    "tx_hash": null,
    "soroban_event_id": null,
    "correlation_id": "corr_abc123",
    "error_code": null,
    "error_detail": null,
    "retry_count": 0,
    "created_at": "2026-06-27T10:00:00.000Z",
    "updated_at": "2026-06-27T10:00:00.000Z",
    "submitted_at": null,
    "confirmed_at": null,
    "redacted_at": null
  }
}
```

#### GET /actions

List actions for a wallet.

**Query Parameters**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `wallet` | string | Yes | - | Wallet address |
| `status` | enum | No | - | Filter by status: `pending`, `submitted`, `confirmed`, `failed`, `reverted`, `orphaned` |
| `cursor` | UUID | No | - | Pagination cursor (UUID of last item from previous page) |
| `limit` | number | No | 25 | Items per page (1-100) |

**Request**

```bash
curl -X GET \
  'http://localhost:3001/actions?wallet=GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCD&limit=25&status=confirmed'
```

**Response 200 OK**

```json
{
  "data": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "wallet_address": "GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCD",
      "action_type": "deposit",
      "status": "confirmed",
      "tx_hash": "abc123def456...",
      "created_at": "2026-06-27T10:00:00.000Z",
      "confirmed_at": "2026-06-27T10:01:30.000Z"
    }
  ],
  "meta": {
    "pagination": {
      "next_cursor": "4f2b9a1d-e8c3-42a1-b5d6-123456789abc",
      "limit": 25,
      "has_more": true
    }
  }
}
```

#### GET /actions/:id

Retrieve a single action by ID.

**Path Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | UUID | Yes | Action ID |

**Request**

```bash
curl -X GET \
  'http://localhost:3001/actions/550e8400-e29b-41d4-a716-446655440000'
```

**Response 200 OK**

```json
{
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "idempotency_key": "550e8400-e29b-41d4-a716-446655440000",
    "wallet_address": "GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCD",
    "action_type": "deposit",
    "action_payload": {
      "vault_id": "42",
      "amount": "1000000",
      "token": "USDC"
    },
    "status": "confirmed",
    "tx_hash": "abc123def456...",
    "created_at": "2026-06-27T10:00:00.000Z",
    "confirmed_at": "2026-06-27T10:01:30.000Z"
  }
}
```

**Response 404 Not Found**

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "action 550e8400-e29b-41d4-a716-446655440000 not found"
  }
}
```

#### PATCH /actions/:id/submitted

Attach transaction hash after wallet broadcast.

**Path Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | UUID | Yes | Action ID |

**Request Body**

```json
{
  "tx_hash": "abc123def456789..."
}
```

**Request**

```bash
curl -X PATCH \
  'http://localhost:3001/actions/550e8400-e29b-41d4-a716-446655440000/submitted' \
  -H 'Content-Type: application/json' \
  -d '{
    "tx_hash": "abc123def456789..."
  }'
```

**Response 200 OK**

```json
{
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "status": "submitted",
    "tx_hash": "abc123def456789...",
    "submitted_at": "2026-06-27T10:00:05.000Z"
  }
}
```

#### POST /actions/:id/cancel

Cancel a pending action.

**Path Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | UUID | Yes | Action ID |

**Request Body**

```json
{
  "error_code": "WALLET_REJECTED",
  "error_detail": "User dismissed the wallet popup"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `error_code` | enum | Yes | `WALLET_REJECTED`, `WALLET_TIMEOUT`, `NETWORK_ERROR` |
| `error_detail` | string | No | Additional error context |

**Request**

```bash
curl -X POST \
  'http://localhost:3001/actions/550e8400-e29b-41d4-a716-446655440000/cancel' \
  -H 'Content-Type: application/json' \
  -d '{
    "error_code": "WALLET_REJECTED",
    "error_detail": "User dismissed the wallet popup"
  }'
```

**Response 200 OK**

```json
{
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "status": "failed",
    "error_code": "WALLET_REJECTED",
    "error_detail": "User dismissed the wallet popup"
  }
}
```

#### DELETE /actions

Scrub personal data for a wallet (GDPR compliance).

**Query Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `wallet` | string | Yes | Wallet address to scrub |

**Request**

```bash
curl -X DELETE \
  'http://localhost:3001/actions?wallet=GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCD'
```

**Response 200 OK**

```json
{
  "data": {
    "scrubbed": 12
  }
}
```

#### GET /actions/export

Export wallet activity history as JSON or CSV.

**Query Parameters**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `wallet` | string | Yes | - | Wallet address |
| `format` | enum | No | `json` | Output format: `json` or `csv` |
| `from` | ISO 8601 | No | - | Start date for filtering |
| `to` | ISO 8601 | No | - | End date for filtering |
| `limit` | number | No | 500 | Max rows (1-1000) |

**Request (JSON)**

```bash
curl -X GET \
  'http://localhost:3001/actions/export?wallet=GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCD&format=json&limit=100'
```

**Response 200 OK (JSON)**

```json
{
  "data": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "wallet_address": "GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCD",
      "action_type": "deposit",
      "action_payload": {
        "vault_id": "42",
        "amount": "1000000",
        "token": "USDC"
      },
      "status": "confirmed",
      "tx_hash": "abc123...",
      "created_at": "2026-06-27T10:00:00.000Z",
      "submitted_at": "2026-06-27T10:00:05.000Z",
      "confirmed_at": "2026-06-27T10:01:30.000Z"
    }
  ]
}
```

**Request (CSV)**

```bash
curl -X GET \
  'http://localhost:3001/actions/export?wallet=GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCD&format=csv' \
  -o activity-export.csv
```

**Response 200 OK (CSV)**

```
Content-Type: text/csv; charset=utf-8
Content-Disposition: attachment; filename="vaultquest-activity-GABCDEF1.csv"

"id","date","action_type","pool_id","amount","token","status","tx_hash","error_code","submitted_at","confirmed_at"
"550e8400-...","2026-06-27T10:00:00.000Z","deposit","42","1000000","USDC","confirmed","abc123...","","2026-06-27T10:00:05.000Z","2026-06-27T10:01:30.000Z"
```

#### GET /api/actions/:walletAddress

Get paginated action history for a wallet.

**Path Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `walletAddress` | string | Yes | Wallet address |

**Query Parameters**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `page` | number | No | 1 | Page number (1-indexed) |
| `limit` | number | No | 25 | Items per page |
| `status` | enum | No | - | Filter by status |
| `type` | enum | No | - | Filter by action type |

**Request**

```bash
curl -X GET \
  'http://localhost:3001/api/actions/GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCD?page=1&limit=25&status=confirmed'
```

**Response 200 OK**

```json
{
  "data": {
    "totalCount": 50,
    "currentPage": 1,
    "data": [
      {
        "id": "550e8400-...",
        "action_type": "deposit",
        "status": "confirmed"
      }
    ]
  }
}
```

### Dashboard

#### GET /dashboard/summary

Get aggregated dashboard statistics for a wallet.

**Query Parameters**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `wallet` | string | Yes | - | Wallet address |
| `stale_after_ms` | number | No | 300000 | Staleness threshold in milliseconds (default 5 minutes) |

**Request**

```bash
curl -X GET \
  'http://localhost:3001/dashboard/summary?wallet=GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCD'
```

**Response 200 OK**

```json
{
  "data": {
    "wallet_address": "GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCD",
    "total_actions": 14,
    "by_status": {
      "pending": 0,
      "submitted": 1,
      "confirmed": 11,
      "failed": 1,
      "reverted": 1,
      "orphaned": 0
    },
    "pending_tx_hashes": ["abc123..."],
    "is_stale": false,
    "latest_activity_at": "2026-06-27T10:00:00.000Z",
    "latest_confirmed_at": "2026-06-27T09:55:00.000Z"
  }
}
```

#### GET /portfolio/summary

Get portfolio summary including deposits and positions.

**Query Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `wallet` | string | Yes | Wallet address |

**Request**

```bash
curl -X GET \
  'http://localhost:3001/portfolio/summary?wallet=GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCD'
```

**Response 200 OK**

```json
{
  "data": {
    "wallet_address": "GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCD",
    "total_deposits": "50000.00",
    "total_withdrawals": "10000.00",
    "net_position": "40000.00",
    "active_vaults": 3,
    "total_yield_earned": "250.50",
    "recent_activity": []
  }
}
```

### Saved Pools

Saved pools allow users to bookmark and track specific prize pools.

#### GET /saved-pools

List saved pools for a wallet.

**Query Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `wallet` | string | Yes | Wallet address |

**Request**

```bash
curl -X GET \
  'http://localhost:3001/saved-pools?wallet=GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCD'
```

**Response 200 OK**

```json
{
  "data": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "wallet_address": "GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCD",
      "pool_id": "pool-42",
      "pool_name": "Weekly USDC Prize Pool",
      "status": "open",
      "tvl": "125000.50",
      "asset": "USDC",
      "participant_count": 24,
      "expected_yield": "5.2% APY",
      "prize": "50 USDC",
      "opens_at": "2026-06-27T12:00:00.000Z",
      "locks_at": "2026-07-04T12:00:00.000Z",
      "draws_at": "2026-07-11T12:00:00.000Z",
      "created_at": "2026-06-27T10:00:00.000Z",
      "updated_at": "2026-06-27T10:00:00.000Z"
    }
  ]
}
```

#### POST /saved-pools

Save or update a pool for a wallet.

**Request Body**

```json
{
  "wallet_address": "GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCD",
  "pool": {
    "pool_id": "pool-42",
    "pool_name": "Weekly USDC Prize Pool",
    "status": "open",
    "tvl": "125000.50",
    "asset": "USDC",
    "participant_count": 24,
    "expected_yield": "5.2% APY",
    "prize": "50 USDC",
    "opens_at": "2026-06-27T12:00:00.000Z",
    "locks_at": "2026-07-04T12:00:00.000Z",
    "draws_at": "2026-07-11T12:00:00.000Z"
  }
}
```

**Request**

```bash
curl -X POST \
  'http://localhost:3001/saved-pools' \
  -H 'Content-Type: application/json' \
  -d '{
    "wallet_address": "GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCD",
    "pool": {
      "pool_id": "pool-42",
      "pool_name": "Weekly USDC Prize Pool",
      "status": "open",
      "tvl": "125000.50",
      "asset": "USDC",
      "participant_count": 24,
      "expected_yield": "5.2% APY",
      "prize": "50 USDC",
      "opens_at": "2026-06-27T12:00:00.000Z",
      "locks_at": "2026-07-04T12:00:00.000Z",
      "draws_at": "2026-07-11T12:00:00.000Z"
    }
  }'
```

**Response 201 Created** (new) or **200 OK** (updated)

```json
{
  "data": {
    "saved": {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "pool_id": "pool-42",
      "pool_name": "Weekly USDC Prize Pool"
    }
  }
}
```

#### DELETE /saved-pools/:poolId

Remove a saved pool.

**Path Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `poolId` | string | Yes | Pool ID |

**Query Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `wallet` | string | Yes | Wallet address |

**Request**

```bash
curl -X DELETE \
  'http://localhost:3001/saved-pools/pool-42?wallet=GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCD'
```

**Response 200 OK**

```json
{
  "data": {
    "deleted": 1
  }
}
```

### Metrics

#### GET /api/metrics

Get protocol-wide metrics summary.

**Request**

```bash
curl -X GET \
  'http://localhost:3001/api/metrics'
```

**Response 200 OK**

```json
{
  "ok": true,
  "data": {
    "totalValueLocked": "5000000.00",
    "totalParticipants": 1250,
    "totalPrizesAwarded": "125000.00",
    "activeVaults": 45,
    "last24hVolume": "250000.00"
  }
}
```

#### GET /api/metrics/round

Get current round status and statistics.

**Request**

```bash
curl -X GET \
  'http://localhost:3001/api/metrics/round'
```

**Response 200 OK**

```json
{
  "ok": true,
  "data": {
    "currentRound": 42,
    "status": "open",
    "opensAt": "2026-06-27T00:00:00.000Z",
    "locksAt": "2026-07-04T00:00:00.000Z",
    "drawsAt": "2026-07-11T00:00:00.000Z",
    "totalDeposits": "500000.00",
    "participantCount": 120,
    "estimatedPrize": "2500.00"
  }
}
```

#### GET /api/metrics/history

Get historical metrics data.

**Request**

```bash
curl -X GET \
  'http://localhost:3001/api/metrics/history'
```

**Response 200 OK**

```json
{
  "ok": true,
  "data": {
    "rounds": [
      {
        "round": 41,
        "totalDeposits": "480000.00",
        "participantCount": 115,
        "prizeAwarded": "2400.00",
        "drawDate": "2026-06-20T00:00:00.000Z"
      }
    ]
  }
}
```

## Status Lifecycle

Actions progress through the following states:

```
pending → submitted → confirmed
   ↓            ↓
failed      reverted
   ↓
orphaned
```

### Status Descriptions

| Status | Description |
|--------|-------------|
| `pending` | Action created, awaiting wallet signature |
| `submitted` | Transaction broadcast to network |
| `confirmed` | Transaction confirmed on blockchain |
| `failed` | Action failed before submission (e.g., user rejected) |
| `reverted` | Transaction submitted but reverted on-chain |
| `orphaned` | Submitted transaction not found after timeout |

### Terminal States

The following states are terminal and cannot transition further:

- `confirmed`
- `failed`
- `reverted`
- `orphaned`

## Data Types

### Action Types

| Type | Description | Payload Fields |
|------|-------------|----------------|
| `deposit` | Deposit funds into a vault | `vault_id`, `amount`, `token` |
| `withdraw` | Withdraw funds from a vault | `vault_id`, `amount`, `token` |
| `create_vault` | Create a new vault | `vault_id`, `amount`, `token` |
| `claim` | Claim a prize | `vault_id` |
| `select_winner` | Select prize winner | `vault_id` |

### Pool Status

| Status | Description |
|--------|-------------|
| `open` | Accepting deposits |
| `locked` | No longer accepting deposits, awaiting draw |
| `drawn` | Winner selected |
| `closed` | Round completed |

### Timestamps

All timestamps are in ISO 8601 format with UTC timezone:

```
2026-06-27T10:00:00.000Z
```

### Wallet Addresses

Stellar wallet addresses are 56-character strings starting with 'G':

```
GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCD
```

### UUIDs

Resource identifiers use UUID v4 format:

```
550e8400-e29b-41d4-a716-446655440000
```

## Pagination

List endpoints support cursor-based pagination:

1. Initial request: omit `cursor` parameter
2. Subsequent requests: use `next_cursor` from previous response
3. Stop when `has_more` is `false` or `next_cursor` is `null`

Example pagination flow:

```bash
curl 'http://localhost:3001/actions?wallet=GABCD...&limit=25'

curl 'http://localhost:3001/actions?wallet=GABCD...&limit=25&cursor=4f2b9a1d-...'
```

## Best Practices

1. Always include `Idempotency-Key` header when creating actions
2. Implement exponential backoff for retries on 429 and 5xx errors
3. Use cursor-based pagination for large result sets
4. Poll `/dashboard/summary` to check for transaction status updates
5. Handle `NETWORK_ERROR` responses with retry logic
6. Store and reuse `next_cursor` values for pagination
7. Validate wallet addresses before making requests
8. Use appropriate `limit` values to balance performance and data freshness

## Support

For API support or to report issues:

- GitHub Issues: https://github.com/vaultquest/vaultquest
- Documentation: https://docs.vaultquest.io
