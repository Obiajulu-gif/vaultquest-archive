# Retention Enforcement and Deletion Verification (#1166)

`lib/retention-enforcement.ts` enforces category-specific data retention policies with a two-phase quarantine/purge lifecycle, legal-hold exemptions, and cryptographic deletion verification certificates.

## Two-Phase Lifecycle & Rollback

1. **Quarantine (`quarantineExpired`)**:
   - Expired `active` records transition to `quarantined` with `purgeEligibleAt = now + quarantineGraceMs`.
   - Records under `legalHold` are skipped and reported in `skippedLegalHoldIds`.
2. **Rollback during grace window (`restoreQuarantinedRecord`)**:
   - While a record is `quarantined`, an authorized operator (`admin`, `privacy_officer`, `system`, `retention_worker`) can restore it to `active` if a retention policy was misconfigured or an investigation opened.
3. **Hard purge & deletion verification (`purgeAndVerify`)**:
   - Once `purgeEligibleAt` elapses, record payloads are zeroed (`payload: null`), an immutable SHA-256 `tombstoneHash` is recorded, and secondary stores/caches are evicted and probed.
   - If any secondary store still retains a purged ID, `RETENTION_RESIDUAL_DATA_DETECTED` (`retryable: true`) is thrown so the worker retries eviction until 100% absence is confirmed.
   - Once verified, an immutable `DeletionVerificationCertificate` (`verificationHash`) is cached by `runId` for idempotent retries. Certificates list only records purged by that run; a retry after residual data is detected rechecks that run's original purge set without including prior runs' tombstones.
