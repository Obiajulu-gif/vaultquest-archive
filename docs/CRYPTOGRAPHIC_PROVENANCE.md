# Cryptographic Provenance for Imported Records

## Overview

Imported records in VaultQuest (`DataImportService` / `RecordProvenanceManager`) can carry a cryptographic provenance proof (`provenance.cryptographicProof`) that binds:

1. **Payload integrity (`payloadHash`)**: SHA-256 hex digest of the canonicalized imported record payload (lexicographically sorted object keys, `undefined` omitted, `Date` as ISO-8601, `bigint` as decimal string).
2. **Metadata envelope integrity (`envelopeHash`)**: SHA-256 hex digest of the canonicalized provenance envelope (`version`, `recordId`, `source`, `importBatchId`, `transformVersion`, `actor`, `timestamp`, `payloadHash`, `keyId`).
3. **Authenticity (`signature`)**: HMAC-SHA256 hex signature over `envelopeHash` using the key identified by `keyId`, verified with constant-time comparison (`crypto.timingSafeEqual`).

## Paths Covered

### Normal Path
- When `DataImportService` is constructed with `provenanceCrypto: { keyId, signingSecret, verificationKeys? }`, every non-dry-run created or updated row receives a `cryptographicProof` attached to `poolInput.provenance` and surfaced as `provenance_proof` on the `ImportRowResult`, with `provenance_signed: true` on the `ImportReport`.
- Verification via `DataImportService.verifyProvenance(...)` or `POST /imports/saved-pools/verify-provenance` returns `valid: true, status: "verified"`.

### Failure Paths
- **Signing misconfiguration**: If signing fails (for example, an empty `signingSecret`), the row is recorded with `action: "error", reason: "provenance_failed"` without writing an unsigned record or aborting the rest of the batch.
- **Tampered payload**: Returns `valid: false, status: "payload_hash_mismatch"`.
- **Tampered metadata** (e.g., altered `actor`, `importBatchId`, or `timestamp`): Returns `valid: false, status: "envelope_hash_mismatch"`.
- **Forged or corrupted signature**: Returns `valid: false, status: "invalid_signature"`.
- **Unknown or retired `keyId`**: Returns `valid: false, status: "unknown_key_id"`.
- **Unsupported proof version/algorithm**: Returns `valid: false, status: "unsupported_algorithm"`.

### Retry Paths
- **Idempotent re-import**: Re-running `DataImportService.run()` with the same records skips unchanged rows (`action: "skip", reason: "unchanged"`), preserving the original cryptographic provenance without re-signing or duplicating writes.
- **Recovery retry**: Rows that failed with `write_failed` or `provenance_failed` can be retried after fixing the transient database error or signing configuration; only the unapplied rows are written and signed.

### Authorization Paths
- `POST /imports/saved-pools` and `POST /imports/saved-pools/verify-provenance` require an authenticated wallet session (`req.principal.walletAddress`).
- Standard wallet callers can only verify provenance for records attributed to their own wallet (`expectedActor === wallet`). Attempting to verify another wallet's imported record returns `403 Forbidden`.
- Privileged operators (`role === "maintainer"` or `role === "admin"`) can verify provenance across wallets for audit and incident response.

## Edge Cases

- **Key rotation**: Configure the new active key in `keyId` / `signingSecret` and retain previous keys in `verificationKeys`. Existing records continue to verify against their recorded `keyId` while new imports are signed with the active key.
- **Post-import ordinary updates**: `updateRecordPreservingProvenance` appends to `provenance.history` while keeping the original `cryptographicProof` intact, preserving the initial import attestation.
- **Canonicalization equivalence**: Equivalent payloads with different JSON key ordering produce identical `payloadHash` values.
- **Dry-run imports**: Dry runs (`dry_run: true`) never write records and do not emit `provenance_proof` entries.

## Recovery and Rollback Behavior

- **Import rollback**: `ImportReport.rollback` (`delete_pool_ids` and `restore_records`) remains unchanged. Rolling back created pools deletes them; restoring overwritten pools via re-import generates a new `import_batch_id` and fresh cryptographic provenance for the restored state.
- **Key compromise recovery**:
  1. Immediately rotate `keyId` and `signingSecret` to a new key and remove the compromised key from `verificationKeys`.
  2. Records signed with the compromised `keyId` now fail verification with `unknown_key_id`.
  3. Re-import affected batches from trusted source snapshots to issue fresh proofs under the new active key.

## Backwards Compatibility & Migration Plan

Existing contracts are preserved without breaking changes:
- `RecordProvenance.cryptographicProof` is optional.
- `RecordProvenanceManager.attachImportProvenance(...)` and `DataImportService` without `provenanceCrypto` behave identically to prior versions.

**Phased rollout:**
1. **Phase 1 (Dual-read / Sign new imports)**: Enable `provenanceCrypto` on `DataImportService` so all new imports are signed. Callers verifying historical records pass `allowLegacyUnsigned: true` (returns `valid: true, status: "legacy_unsigned"` for pre-migration records).
2. **Phase 2 (Audit & Backfill)**: Use `exportProvenanceReport()` to track `cryptographicallySignedRecords` vs `recordsWithProvenance` and re-import or backfill legacy records as needed.
3. **Phase 3 (Strict enforcement)**: Set `allowLegacyUnsigned: false` (the default) so unsigned records are rejected.
