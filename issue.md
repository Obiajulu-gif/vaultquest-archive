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
