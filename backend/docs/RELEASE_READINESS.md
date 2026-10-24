# Release readiness gate

The authoritative release checklist and failure/recovery guidance lives in
[`docs/release-readiness-checklist.md`](../../docs/release-readiness-checklist.md).
The `Release on Tag` workflow blocks draft creation until migration deployment
and post-checks, security checks, backend smoke tests, and an isolated PostgreSQL
backup/restore rehearsal all pass.

For manual verification, follow the checklist on a disposable database. Never
point release-gate tooling at production. Database recovery is restore or
forward-fix, not an assumed reverse migration. Contract rollback must follow
the timelock and multisignature procedure; CI never submits live transactions.
