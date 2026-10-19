# Operational controls

The repository exposes four small controls for safe contributor and production
operations:

- `pnpm diagnostics` checks Node, the package manager, required local files, and
  the public network setting. Add `-- --strict` in CI when failures must stop a
  job. The command prints only pass/fail metadata and never environment values.
- `lib/rollout-guardrails.ts` requires the admin flag permission, records a
  bounded sample window, disables a rollout when its error budget is exceeded,
  and supports an explicit, reasoned emergency disablement.
- `lib/privacy-safe-export.ts` requires an export permission and projects an
  explicit allowlist. Sensitive fields are rejected and reported as redacted;
  callers must opt into only fields they are authorized to release.
- `lib/recovery-checkpoints.ts` gives every external side effect a stable
  operation, step, and idempotency key. A failed step returns to `pending` until
  its retry limit is reached; a succeeded step is idempotent on resume.

The checkpoint store is deliberately adapter-free so a deployment can persist
the records in its existing database or queue. Persist the record before
starting the side effect, update it after the provider response, and resume
only `pending` records after a process restart. Never retry a `succeeded`
record solely because the caller did not receive the response.

