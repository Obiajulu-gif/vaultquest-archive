# Signed Audit Receipts for Administrative Changes

`lib/signed-audit-receipts.ts` provides cryptographically signed, hash-chained receipts for every administrative configuration or state change.

## Receipt Format & Hash Chain

1. **Canonical digest (`payloadHash`)**:
   - Computed with SHA-256 over recursively key-sorted canonical JSON (`canonicalizeJson`), covering `receiptId`, `sequence`, `prevReceiptHash`, `changeId`, `actor`, `actorRole`, `action`, `targetType`, `targetId`, `beforeState`, `afterState`, `reason`, `issuedAt`, `keyId`, and optional `rollbackOfReceiptId`.
2. **Cryptographic signature (`signature`)**:
   - HMAC-SHA256 over `payloadHash` under `keyRing.keys[keyRing.activeKeyId]`, verified in constant time via `timingSafeEqual`.
3. **Key rotation**:
   - `SignedAuditReceiptLedger.rotateSigningKey` promotes a new `activeKeyId` while preserving historical keys in `keyRing.keys` so older receipts in the chain remain verifiable.
4. **Idempotent retry (`changeId`)**:
   - Re-submitting the same `changeId` with identical intent returns the original receipt (`deduplicatedRetry: true`) without advancing `sequence`. Re-using `changeId` for a different mutation fails with `AUDIT_RECEIPT_CONFLICTING_CHANGE_ID`.
5. **Verified rollback (`rollbackReceipt`)**:
   - Verifies the target receipt's signature first, then appends a new signed receipt with `beforeState` and `afterState` inverted and `rollbackOfReceiptId` linked.

## Migration Plan

Persist receipts in an append-only `admin_audit_receipts` table with unique constraints on `sequence` and `change_id`. Existing `services/adminConfig.ts` writes can emit receipts into the ledger without changing their public return types.
