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

## Notification Delivery & Deduplication (#652)

Operational alerts (RPC degradation, indexer lag, contract errors, withdraw batching) are surfaced in the VaultQuest notification center. To prevent alert storms from repeated or overlapping events, notifications are **deduplicated by identity and scope**.

### Identity & Scope Model
- Every notification has an **identity key**: `type::scope::subject`.
- **Scope** is one of:
  - `wallet` — subject is a wallet address (e.g. `reward_event::wallet::GBBD...FLA5`);
  - `vault` — subject is a vault name (e.g. `apy_change::vault::XLM Drip Vault`);
  - `global` — protocol-wide, no subject (`vault_pause::global::global`).
- A wallet alert and a global alert for the same subject are **distinct identities** and are both retained.

### Collapsing Semantics
- A repeated alert (identical identity key **and** identical title/message/timestamp) collapses into the existing notification — the center keeps **one current notification per identity**.
- A refreshed alert (same identity, new content) replaces its predecessor **in place**, becomes unread again, and bumps a `version` counter shown as `Updated ×N`.
- A user who dismissed an alert stays **dismissed across refreshes** of the same alert family — refreshed alerts do not re-notify.

### Lifecycle
- Read/dismissed state is **persisted** to `localStorage` under `vaultquest:notifications:<scopeKey>`, where `scopeKey` is `wallet@network`, so dismissed state cannot leak across accounts/networks.
- Alerts can carry an `expiresAt`; `clearExpired` prunes stale alerts and is applied on load.

### Enabling a Repeat Alert for the Dashboard
Emit the alert through the notification center with a stable identity and the latest payload; the provider collapses duplicates automatically:

```ts
dispatchAlert({
  type: "protocol_alert",
  scope: "global",
  title: "Indexer lag spike",
  message: `Indexer lagged ${ledgers} ledgers`,
  expiresAt,
});
```

Tests: `tests/notification-dedup.test.tsx` (identity/scope collisions, collapsing, dismiss persistence, cross-scope isolation).
