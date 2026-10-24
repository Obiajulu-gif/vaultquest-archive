# Resolved Issues

## #648 – Vault activity feed cannot verify event ordering across indexer restarts

**Problem:** Activity pages depend on ordered transaction/event history. Indexer restarts or replay can reorder deposits, withdrawals, rewards, and claims unless event ordering is deterministic.

**Resolution:**
- Defined canonical ordering by `(ledgerSequence, txIndex, opIndex, eventIndex)`.
- Updated `app/app/activity/page.jsx` to deduplicate events by stable composite key and sort deterministically.
- Updated `docs/INDEXER_RUNBOOK.md` (§6) with replay verification procedures and canonical sorting key specification.

**Files changed:**
- `app/app/activity/page.jsx`
- `docs/INDEXER_RUNBOOK.md`
- `docs/STATE_MODEL.md`
- `stellar-wallet-connect/src/vault/components/ActivityExport.tsx`

---

## #647 – Vault entrant eligibility does not include sybil-resistant wallet clustering or configurable anti-abuse checks

**Problem:** Prize savings systems can be gamed by splitting deposits across wallets unless the protocol defines optional anti-abuse checks and transparent eligibility rules.

**Resolution:**
- Added `check_eligibility()` view function to `contracts/drip-pool/src/lib.rs`.
- Added configurable "Sybil anti-abuse clustering check" parameter to admin settings page.
- Documented fairness and privacy tradeoffs in `docs/USER_GUIDE.md`.

**Files changed:**
- `contracts/drip-pool/src/lib.rs`
- `app/app/admin/settings/page.jsx`
- `docs/USER_GUIDE.md`
- `docs/STATE_MODEL.md`

---

## #661 – VaultQuest does not provide maintainer-safe fixture anonymization for shared bug reports

**Problem:** Bug reports often need vault, wallet, transaction, and activity data, but maintainers need a tool to anonymize sensitive fields before sharing.

**Resolution:**
- Added "Anonymize" toggle to `NetworkDiagnostics.tsx` — when enabled, wallet addresses are redacted in the copied diagnostic export while preserving relational structure.
- Updated `docs/TESTING.md` with fixture anonymization workflow.

**Files changed:**
- `stellar-wallet-connect/src/components/NetworkDiagnostics.tsx`
- `app/app/activity/page.jsx`
- `docs/TESTING.md`

---

## #660 – VaultQuest app shell does not expose service-worker or cache-busting strategy for stale build assets

**Problem:** Users can run stale JavaScript after deployments, causing mismatched contract addresses, API schemas, or transaction builders.

**Resolution:**
- Created `docs/DEPLOYMENT_PROVENANCE.md` documenting the full cache-busting strategy, safe refresh prompt rules, and deployment checklist.
- Added `isStaleClient()` helper to `lib/deployment-manifest.ts` for version mismatch detection.
- Defined that `/deployment-manifest.json` must be served `no-cache`; JS chunks use content-hash filenames.

**Files changed:**
- `components/AttestationProvider.jsx`
- `lib/deployment-manifest.ts`
- `app/layout.jsx`
- `docs/DEPLOYMENT_PROVENANCE.md`

---

## #778 – Stable pagination and filtering for rapidly changing datasets

**Problem:** `listRecoverableActions` used `skip`/`offset` pagination, which causes duplicate or skipped records when rows are inserted or change status while a user paginates.

**Resolution:**
- Replaced `skip: offset` with cursor-based pagination `(cursor: { id }, skip: 1)` in `listRecoverableActions`, ordering deterministically on `(submittedAt, id)`.
- Documented filter behavior for hidden, deleted, and restricted records in `docs/PAGINATION_AND_FILTERING.md`.
- All key list endpoints (`/actions`, `/saved-pools`, `/admin/audit`, `/admin/partial-failures`) now use cursor pagination; offset is isolated to the in-memory search index which operates on a stable snapshot.

**Files changed:**
- `backend/src/services/ledger.ts` — `listRecoverableActions` converted to cursor-based
- `docs/PAGINATION_AND_FILTERING.md` — new filter behavior documentation

---

## #791 – Scoped maintainer impersonation for support debugging

**Problem:** No safe way for maintainers to reproduce user-reported issues without gaining broad access to private data.

**Resolution:**
- Added `ImpersonationService` with time-limited (default 30 min, max 4 h) sessions.
- Sessions are scoped (read-only by default), audited (every action written to `audit_trail`), and visible (UI banner via `X-Impersonation-Active` header).
- Dangerous mutations (withdraw, select_winner, compensating) are blocked unless `allowMutations: true` is set explicitly on session creation.
- One active session per maintainer enforced by the service.
- New permission `admin.impersonation.read/write` added to RBAC.

**Files changed:**
- `backend/src/services/impersonation.ts` — new ImpersonationService + InMemoryImpersonationStore
- `backend/src/routes/impersonation.ts` — REST API (start / list / inspect / end)
- `backend/src/middleware/impersonation.ts` — onRequest hook + assertImpersonationBlocked helper
- `backend/prisma/schema.prisma` — ImpersonationSession model
- `backend/prisma/migrations/20261001000000_add_impersonation_sessions/migration.sql`
- `lib/rbac.ts` — admin.impersonation.read/write permissions + maintainer grants
- `backend/src/app.ts` — wired ImpersonationService + routes
- `app/app/admin/impersonation/page.jsx` — admin UI page
- `components/ImpersonationBanner.jsx` — persistent warning banner
- `app/layout.jsx` — banner mounted in root layout

---

## #793 – Partial failure dashboard for background and external integrations

**Problem:** Maintainers had no unified view of operations stuck between internal state and external systems.

**Resolution:**
- Added `PartialFailureService` to record, list, and transition partial failures.
- Failures are grouped by `operationType`, `severity`, and `state` in a summary endpoint.
- All failures carry a human-readable `description` and sanitized `metadata` (no secrets).
- List endpoints use cursor-based pagination (newest first).
- State transitions (retry → resolved / still_failing, resolve, ignore) are audited.
- Admin dashboard page with summary cards, filterable table, and inline action modal.

**Files changed:**
- `backend/src/services/partialFailureService.ts` — new PartialFailureService
- `backend/src/routes/partialFailures.ts` — REST API (list / summary / inspect / record / retry / resolve / ignore)
- `backend/prisma/schema.prisma` — PartialFailure model
- `backend/prisma/migrations/20261001000001_add_partial_failures/migration.sql`
- `backend/src/app.ts` — wired PartialFailureService + routes
- `app/app/admin/partial-failures/page.jsx` — admin dashboard UI

---

## #991 – Add audit evidence for administrative configuration changes

**Problem:** Administrative configuration adjustments (treasury fee basis points, round cadence, quorum thresholds, and emergency pause flags) lacked an immutable, tamper-evident cryptographic audit log that could detect covert database tampering or record gaps without incurring heavy on-chain Soroban storage rent.

**Resolution:**
- Implemented `AdminConfigAuditService` with an append-only cryptographic hash chain ($H_n = \text{SHA256}(\text{canonicalJson}(H_{n-1} \parallel \text{fields})))$ anchored at genesis ($H_0 = 0^{64}$).
- Integrated parameter simulation to evaluate risk ratings (`none`, `low`, `medium`, `high`) and block stringency violations unless explicitly authorized.
- Built chain verification (`verifyEvidenceChain`) to detect `ALTERED` records, `BROKEN_LINK` severed hash pointers, or `SEQUENCE_GAP` record omissions.
- Added verifiable rollback evidence generation restoring previous values with forward provenance.
- Provided structured multi-format export in JSON (with Merkle roots), streaming NDJSON, and RFC 4180 CSV.

**Files changed:**
- `backend/src/services/adminConfigAuditService.ts`
- `backend/tests/adminConfigAudit.spec.ts`

---

## #993 – Implement duplicate suppression for notifications and webhooks

**Problem:** Upstream Stellar Horizon event streams, blockchain indexers, and webhook relays operate under at-least-once delivery guarantees, leading to redundant user notifications and potential duplicate webhook executions during transient network retries.

**Resolution:**
- Implemented `DuplicateSuppressionService` providing dual-layer sliding-window deduplication.
- Notification sliding window (300s) calculates canonical fingerprints to suppress duplicate alerts while allowing emergency bypass for critical-severity notifications and authorized maintainers.
- Webhook deduplication state machine (`processing`, `processed`, `failed`) enforces concurrency locks, payload content hashing, and retry allowance on prior delivery failures.

**Files changed:**
- `backend/src/services/duplicateSuppressionService.ts`
- `backend/tests/duplicateSuppression.spec.ts`

---

## #994 – Add retention and deletion tests for sensitive operational data

**Problem:** Sensitive operational credentials and transient authentication records lacked exhaustive lifecycle validation, creating risks of lingering PII, replay vulnerabilities, or accidental deletion of active user sessions.

**Resolution:**
- Added automated lifecycle verification tests covering Stellar SEP-10 challenge purging (1-day TTL) vs active challenge preservation.
- Validated 30-day session revocation and cleanup while strictly protecting active, unexpired sessions.
- Validated 7-day TTL cleanup for action and job leases.
- Tested failure handling for database query errors, mid-execution delete errors, and verified strict immunity for records under regulatory retention holds.
- Fixed mock interface completeness in `dataRetention.spec.ts` to include `findMany` on `actionLedger`.

**Files changed:**
- `backend/tests/dataRetentionSensitiveData.spec.ts`
- `backend/tests/dataRetention.spec.ts`

---

## #921 – Privacy-preserving audit evidence bundles for support investigations

**Problem:** Customer support agents and auditors investigating failed deposits, prize round claims, or reconciliation anomalies needed exportable diagnostics, but exporting raw database records risked leaking Stellar secret keys, user passwords, and PII.

**Resolution:**
- Implemented `SupportEvidenceBundleService` to generate exportable, cryptographically verifiable diagnostic bundles.
- Automatically redacts Stellar secret seeds (`S...`), Bearer tokens, passwords, JWTs, and PII into `[REDACTED_SECRET]` and `[REDACTED_PII]`.
- Implemented salted HMAC-SHA256 pseudonymization for Stellar public keys (`anon_wallet_...`) in compliance with GDPR Article 4(5) & 32.
- Preserved behavioral integrity (tx hashes, ledger sequences, financial amounts, error codes).
- Added Merkle-style root checksum verification (`verifyBundle`) and support for JSON and streaming NDJSON exports.

**Files changed:**
- `backend/src/services/supportEvidenceBundleService.ts`
- `backend/tests/supportEvidenceBundle.spec.ts`

---

## #946 – Add API problem-details taxonomy with stable error codes and remediation hints

**Problem:** API error responses lacked stable machine-readable error codes, unified RFC 7807/9457 problem details formatting, field-level validation details, and remediation guidance across vault deposits, prize rounds, quests, wallet flows, and indexer reconciliation.

**Resolution:**
- Implemented `formatProblemDetails` in `backend/src/problemDetails.ts` adhering to RFC 7807 and RFC 9457 schemas (`type`, `title`, `status`, `detail`, `instance`, `code`, `category`, `retryable`, `remediation`, `error_id`, `timestamp`, `invalid_params`).
- Added domain-specific stable error codes in `backend/src/constants.ts` and catalog entries with safe messages and actionable remediation hints in `backend/src/errorTaxonomy.ts`.
- Updated `backend/src/middleware/errorHandler.ts` to negotiate `application/problem+json` while preserving the backward-compatible `{ error: { code, message, details, issues } }` payload envelope.
- Added comprehensive unit and contract drift prevention tests in `backend/tests/problemDetails.spec.ts`.

**Files changed:**
- `backend/src/constants.ts`
- `backend/src/errorTaxonomy.ts`
- `backend/src/problemDetails.ts`
- `backend/src/middleware/errorHandler.ts`
- `backend/tests/problemDetails.spec.ts`

---

## #985 – Add contract tests for pagination, filtering, and authorization boundaries

**Problem:** List endpoints lacked executable contract tests verifying pagination monotonicity, exact limit boundaries, filter isolation (including soft-delete/redacted record hiding), and multi-tenant authorization boundaries.

**Resolution:**
- Built contract test suite `backend/tests/paginationFilteringAuthContract.spec.ts` covering normal pagination traversal, exact limit boundary conditions, empty list envelopes, and limit clamping (`[1, 100]`).
- Validated filtering boundaries for `ActionStatus`, `ActionType`, combined filters, and strict exclusion of soft-deleted / redacted records (`redactedAt IS NOT NULL`).
- Verified multi-tenant wallet isolation (Alice cannot access Bob's ledger records), missing wallet parameter rejection, RBAC 401 unauthenticated boundary, and internal secret verification.
- Documented operational edge cases, failure modes, and recovery steps in `docs/PAGINATION_AND_FILTERING.md`.

**Files changed:**
- `backend/tests/paginationFilteringAuthContract.spec.ts`
- `docs/PAGINATION_AND_FILTERING.md`

---

## #984 – Implement expiring capability tokens for sensitive actions

**Problem:** Sensitive operations (such as emergency vault draining, round settlement, key rotation, and ledger repairs) operated under ambient privileges rather than requiring explicit, time-bounded, single-use cryptographic authorization tokens.

**Resolution:**
- Implemented `CapabilityTokenService` in `backend/src/services/capabilityTokenService.ts` utilizing HMAC-SHA256 signatures, constant-time verification (`timingSafeEqual`), bounded TTL (10s to 3600s), and scope checking (action, resource, principal).
- Built `InMemoryCapabilityTokenStore` providing atomic single-use replay protection, token revocation, principal revocation, and periodic TTL memory pruning.
- Created Fastify middleware `requireCapability` in `backend/src/middleware/capabilityToken.ts` enforcing capability headers with RFC 7807 Problem Details on unauthorized, expired, or replayed tokens.
- Added capability token routes in `backend/src/routes/capabilityTokens.ts` (`POST /auth/capabilities/issue`, `POST /auth/capabilities/inspect`, `POST /auth/capabilities/revoke`) and integrated into `backend/src/app.ts`.
- Created comprehensive test suite in `backend/tests/capabilityToken.spec.ts`.

**Files changed:**
- `backend/src/services/capabilityTokenService.ts`
- `backend/src/middleware/capabilityToken.ts`
- `backend/src/routes/capabilityTokens.ts`
- `backend/src/app.ts`
- `backend/tests/capabilityToken.spec.ts`

---

## #977 – Build a resumable repair job for orphaned and inconsistent records

**Problem:** Reconciling orphaned actions, stale pending events, and inconsistent vault settlements across large tables could fail mid-execution or exceed memory limits without cursor checkpointing, bounded batching, and resumption capabilities.

**Resolution:**
- Implemented `ResumableRepairEngine` in `backend/src/services/resumableRepairJob.ts` with multi-phase execution (`orphaned_actions`, `stale_pending_events`, `unresolved_settlements`), cursor-based checkpointing, dry-run mode, and error isolation.
- Designed strictly bounded $O(B)$ memory footprint and $O(N \log N)$ execution time using indexed primary key cursor pagination.
- Added abstract data source interface with both `PrismaRepairDataSource` for PostgreSQL and `InMemoryRepairDataSource` for zero-dependency test execution.
- Integrated background worker job handler in `backend/src/worker/handlers.ts` (`JOB_TYPES.RESUMABLE_REPAIR = "repair.resumable"`).
- Added authenticated REST API endpoints in `backend/src/routes/jobs.ts` (`POST /internal/repair/resumable`, `GET /internal/repair/resumable/:id/checkpoint`, `POST /internal/repair/resumable/:id/resume`, `POST /internal/repair/resumable/:id/pause`).
- Added comprehensive unit and integration test suite in `backend/tests/resumableRepairJob.spec.ts`.

**Files changed:**
- `backend/src/services/resumableRepairJob.ts`
- `backend/src/worker/handlers.ts`
- `backend/src/routes/jobs.ts`
- `backend/src/app.ts`
- `backend/tests/resumableRepairJob.spec.ts`

---

## #966 – Add concurrency tests for duplicate submissions and stale versions

**Problem:** Concurrent duplicate actions with the same or altered payloads, along with stale version edits during optimistic locking races, lacked comprehensive executable verification covering convergence, conflict rejection, idempotent retries, and cross-wallet authorization isolation.

**Resolution:**
- Added deterministic concurrency test suite `backend/tests/concurrencyDuplicateStaleVersions.spec.ts` verifying duplicate submissions (identical convergence, 409 conflict on altered payload, idempotent retry after network failures, and cross-wallet isolation preventing idempotency key hijacking).
- Verified stale version detection and optimistic locking (sequence advancement on valid writes, 409 CONCURRENT_MODIFICATION rejection on stale tokens, automatic token refresh and retry with `executeWithRetryOnConflict`, unauthorized actor rejection, and 10-way stress races where exactly 1 writer commits).
- Added frontend concurrency suite `tests/concurrency-stale-version.test.ts` validating client-side optimistic concurrency control helpers, conflict banner rendering, and retry triggers.
- Updated `docs/IDEMPOTENCY.md` with explicit invariants, operational edge cases, and recovery/rollback guidelines.

**Files changed:**
- `backend/tests/concurrencyDuplicateStaleVersions.spec.ts`
- `tests/concurrency-stale-version.test.ts`
- `docs/IDEMPOTENCY.md`

---

## #969 – Add accessibility coverage for keyboard, focus, and async status states

**Problem:** Interactive async dialogs and conflict banners (e.g., `DepositModal`, `ConflictResolutionUI`) lacked complete WCAG 2.1 AA accessibility coverage across keyboard navigation (Tab/Shift+Tab focus trapping, Escape dismissal), initial focus management, focus restoration on unmount, live regions for async pending/error states (`role="status"`, `role="alert"`, `aria-busy`), form input error binding (`aria-invalid`, `aria-describedby`), and disconnected wallet authorization guards.

**Resolution:**
- Enhanced `components/app/DepositModal.jsx` with full dialog ARIA semantics (`role="dialog"`, `aria-modal="true"`, `aria-labelledby`), active focus trapping with Tab cycling, `previouslyFocusedRef` focus restoration to trigger elements, heading auto-focus on step transitions, live regions for async transaction states, assertive error announcements with accessible keyboard retry buttons, and disconnected wallet authorization gates.
- Enhanced `lib/useConflictAwareOperation.tsx` (`ConflictResolutionUI` and `ConflictBanner`) with `role="alert"`, `aria-busy`, accessible labels, and keyboard-operable retry actions.
- Created comprehensive test suite in `app/tests/a11y-async-states.spec.tsx` covering normal, failure, retry, authorization, and reduced-motion states (12 tests).
- Updated `docs/ACCESSIBILITY_REGRESSION.md` with component protections, test matrix, and audit guidelines.

**Files changed:**
- `components/app/DepositModal.jsx`
- `lib/useConflictAwareOperation.tsx`
- `app/tests/a11y-async-states.spec.tsx`
- `docs/ACCESSIBILITY_REGRESSION.md`

---

## #972 – Add release readiness checks for migrations, smoke tests, and rollback

**Problem:** Release validation lacked an automated and auditable pipeline uniting migration safety checks (destructive statement detection, rollback notes, post-checks), Fastify application smoke tests (liveness, component aggregation, Problem Details errors, degraded retry headers, internal secret auth), and dual-control maintainer sign-off verification with emergency exception workflows.

**Resolution:**
- Fixed casing bug in `backend/src/scripts/migrationSafety.ts` identifier parsing with `/i` on statement and updated rollback notes text for pre-migration backups.
- Created `backend/src/scripts/releaseReadiness.ts` exporting `validateReleaseReadiness` and `formatReport` automating checks across documentation, migrations, rollback procedures, configuration inventories, and dual-control maintainer authorizations.
- Created `docs/release-readiness-checklist.md` satisfying all required checklist sections (Tests, Migration, Configuration, Rollback, Documentation, Maintainer sign-off) and emergency exception workflows.
- Refactored `backend/tests/smoke.spec.ts` with mock database fallback to reliably verify normal, failure, retry (`Retry-After: 30` on degraded mode), and authorization paths (`x-internal-secret` enforcement) in environments with or without Docker.
- Added test suite `backend/tests/releaseReadiness.spec.ts` testing release readiness verification across normal, failure, retry, and authorization paths.

**Files changed:**
- `backend/src/scripts/migrationSafety.ts`
- `backend/src/scripts/migrationSafetyCli.ts`
- `backend/src/scripts/releaseReadiness.ts`
- `backend/tests/smoke.spec.ts`
- `backend/tests/releaseReadiness.spec.ts`
- `docs/release-readiness-checklist.md`


