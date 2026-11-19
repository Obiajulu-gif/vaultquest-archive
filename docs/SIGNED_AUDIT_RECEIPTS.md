# Signed Audit Receipts for Privileged Actions (#1065)

## Overview
`src/lib/signed-audit-receipts.mjs` issues and verifies Ed25519-signed audit receipts for privileged operations (`role_grant`, `role_revoke`, `config_change`, `repair_execute`, `key_rotation`, `emergency_pause`), preserving the canonical JSON and domain-separation contract from `backend/src/services/receipts.ts`.

## Cryptographic & Payload Contract
- **Domain separation**: `vaultquest-receipt:v1\n` + canonical JSON payload (sorted keys).
- **Deterministic ID**: `receiptId = sha256(actionId + ":" + stage)`.
- **Privacy**: Raw privileged `params` are never stored in the receipt; `requestDigest` commits to the canonical request via SHA-256.

## Authorization
- Issuing receipts requires `admin` or `security_officer` role (or `audit:issue` scope). Unauthorized callers fail with `AuditReceiptAuthorizationError` (`AUDIT_RECEIPT_UNAUTHORIZED`, HTTP 403).

## Failure, Retry & Verification
- **Idempotency / Retry**: `InMemoryAuditReceiptStore.insertIfAbsent` deduplicates by `receiptId` so duplicate/retried requests return the exact original envelope (`created: false`). Transient persistence errors are retried up to `maxRetries` before throwing `RECEIPT_PERSISTENCE_FAILED`.
- **Tamper detection**: `verifyAuditReceipt(envelope, publicKeyPem)` checks algorithm/domain, `receiptId` derivation, `payloadDigest`, and the Ed25519 signature, returning structured failure reasons (`PAYLOAD_DIGEST_MISMATCH`, `INVALID_SIGNATURE`, `RECEIPT_ID_MISMATCH`).
