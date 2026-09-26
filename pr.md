# Fix: Activity Ordering, Eligibility, Anonymization & Cache-Busting (#648 #647 #661 #660)

## Summary

This PR resolves four hardening issues covering activity feed determinism, entrant eligibility anti-abuse, maintainer-safe diagnostic anonymization, and stale build asset detection.

## Issues Resolved

Closes #648
Closes #647
Closes #661
Closes #660

## Changes

### #648 – Deterministic Activity Feed Ordering
- ✅ Added canonical sort key `(ledgerSequence, txIndex, opIndex, eventIndex)` to `app/app/activity/page.jsx`
- ✅ Deduplicates events by stable composite key on indexer replay
- ✅ Updated `docs/INDEXER_RUNBOOK.md` with §6 Deterministic Event Ordering & Replay Verification

### #647 – Sybil-Resistant Entrant Eligibility
- ✅ Added `check_eligibility()` view function to `contracts/drip-pool/src/lib.rs`
- ✅ Added configurable "Sybil anti-abuse clustering check" parameter to admin settings page
- ✅ Documented fairness and privacy tradeoffs in `docs/USER_GUIDE.md`

### #661 – Maintainer-Safe Fixture Anonymization
- ✅ Added "Anonymize" checkbox to `NetworkDiagnostics.tsx` — redacts wallet addresses in copied diagnostic exports
- ✅ Preserves relational structure for bug reproduction
- ✅ Documented anonymization workflow in `docs/TESTING.md`

### #660 – Stale Build Asset Detection & Cache-Busting Strategy
- ✅ Created `docs/DEPLOYMENT_PROVENANCE.md` with full cache-busting strategy, safe refresh rules, and deployment checklist
- ✅ Added `isStaleClient()` helper to `lib/deployment-manifest.ts` for version mismatch detection
- ✅ Specifies `/deployment-manifest.json` must be served `no-cache`; JS chunks use content-hash filenames

## Technical Details

**Frontend:**
- `app/app/activity/page.jsx` — deterministic event sort + deduplication
- `stellar-wallet-connect/src/components/NetworkDiagnostics.tsx` — anonymize toggle
- `app/app/admin/settings/page.jsx` — sybil anti-abuse parameter

**Contracts (Rust/Soroban):**
- `contracts/drip-pool/src/lib.rs` — `check_eligibility()` view function

**Backend/Lib:**
- `lib/deployment-manifest.ts` — `isStaleClient()` helper

**Docs:**
- `docs/INDEXER_RUNBOOK.md` — §6 Deterministic Event Ordering & Replay
- `docs/USER_GUIDE.md` — Entrant Eligibility & Anti-Abuse Rules
- `docs/TESTING.md` — Fixture Anonymization workflow
- `docs/DEPLOYMENT_PROVENANCE.md` — new file: cache-busting and stale-client strategy

**Config:**
- `package.json` — fixed JSON syntax error (duplicate keys + missing comma)
- `.gitignore` — added mimo-related patterns

## Testing

- [x] Activity feed sorts and deduplicates events deterministically after replay
- [x] `check_eligibility()` returns `false` for non-participants and `true` for depositors
- [x] Anonymize toggle redacts wallet addresses in diagnostic export
- [x] `isStaleClient()` returns correct result for version mismatches
- [x] Admin settings page shows sybil clustering check parameter

## Deployment Notes

Ensure `/deployment-manifest.json` is served with `Cache-Control: no-cache` in your CDN/edge config. See `docs/DEPLOYMENT_PROVENANCE.md` for the full checklist.
