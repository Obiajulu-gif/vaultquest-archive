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

## Hash-chained admin change receipts (#1163)

`src/lib/signed-audit-receipts.mjs` now exposes `AdminChangeReceiptChain`, an
Ed25519-signed, hash-chained ledger for privileged administrative changes. It
complements (and does not replace) the TypeScript HMAC ledger above.

- **Normal path**: `recordChange()` signs a canonical payload containing an
  optional `sequence`, `prevReceiptHash`, and `rollbackOfReceiptId`. Each
  `prevReceiptHash` is the previous receipt's `payloadDigest`, starting at
  `GENESIS`; `verifyChain()` checks signatures, contiguous sequences, links,
  and rollback direction.
- **Failure path**: tampering with any signed field yields
  `PAYLOAD_DIGEST_MISMATCH` or `INVALID_SIGNATURE`; edits to the chain structure
  yield `AUDIT_RECEIPT_CHAIN_SEQUENCE_GAP` / `AUDIT_RECEIPT_CHAIN_BROKEN`.
- **Retry path**: retries reuse `changeId`, return the original envelope with
  `deduplicatedRetry: true`, and never advance the chain. Transient store
  errors marked `retryable` are retried up to `maxRetries`.
- **Rollback / recovery path**: `rollback()` first verifies the target
  receipt's signature, then appends a new signed receipt whose
  `rollbackOfReceiptId` points to that earlier receipt. Callers pass the
  inverted `beforeState`/`afterState` because raw state is intentionally kept
  out of the signed payload (only its digest is committed).
- **Authorization path**: `admin`, `security_officer`, or an actor with the
  `audit:issue` scope may issue or roll back receipts; everyone else receives
  `AUDIT_RECEIPT_UNAUTHORIZED` (HTTP 403).

### Edge cases and compatibility

- Stores that implement `list()` (including `InMemoryAuditReceiptStore`) support
  cross-process verification; a store without `list()` verifies only receipts
  observed in the current process and should be upgraded before production use.
- All new payload fields are optional and additive. Existing envelopes remain
  verifiable, and the existing `issuePrivilegedAuditReceipt` /
  `verifyAuditReceipt` signatures, error codes, and response shapes are unchanged.
- No schema migration is required. For durable storage, persist one envelope
  per `receiptId` with a unique constraint on `changeId` and an ordered
  `sequence` column; rotate signing keys by injecting a new signer while
  retaining prior public keys for verification.

Verification: `tests/backend/admin-change-audit-receipts.test.mjs` covers
normal, failure, retry/rollback, and authorization paths.
