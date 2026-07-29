# Protocol Health Dashboard & Alert Thresholds

This document defines the operational health states, alert thresholds, and diagnostic signals displayed on the VaultQuest Maintainer Protocol Health Dashboard.

## Service Health Signals & Alert Thresholds

### 1. Stellar RPC Layer
- **Healthy**: Latency < 500ms, HTTP 200 responses across primary endpoint.
- **Degraded**: Latency 500ms – 2000ms, or primary endpoint failing with automatic failover active to backup RPC endpoint.
- **Unavailable**: All configured RPC endpoints failing or unreachable, HTTP 5xx or connection timeouts.

### 2. Backend Service API
- **Healthy**: Endpoint `/health` returns status `ok`, uptime > 99.9%.
- **Degraded**: Latency > 1000ms, transient 5xx errors below 5% rate limit.
- **Unavailable**: Health check endpoint unresponsive or failing continuously.

### 3. Stellar Event Indexer
- **Healthy**: Indexer lag < 5 ledgers (< 25 seconds), active checkpoint updates.
- **Degraded**: Indexer lag between 5 and 20 ledgers (25s – 100s), or last sync error reported.
- **Unavailable**: Indexer lag > 20 ledgers (> 100s), daemon stopped, or unhandled crash.

### 4. Smart Contract Availability
- **Healthy**: On-chain read methods responding without Soroban contract errors.
- **Degraded**: Intermittent contract read errors or high execution gas fees.
- **Unavailable**: Contract invocation reverts or contract address not deployed on target network.

## Security & Sensitive Config Handling

All diagnostic endpoints and dashboard UI components MUST sanitize sensitive URL parameters (API keys, bearer tokens, secret keys) prior to rendering or logging. Sensitive credentials are automatically redacted to `***REDACTED***`.
