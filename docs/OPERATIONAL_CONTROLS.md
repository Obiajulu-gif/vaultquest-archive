# Operational controls

The repository exposes four small controls for safe contributor and production
operations:

- `pnpm diagnostics` checks Node, the package manager, installed node_modules, required local files,
  and the public network setting. Add `-- --strict` in CI when failures must stop a
  job. The command prints only pass/fail metadata and never environment values.
- `lib/contributor-diagnostics.ts` provides diagnostic checks covering normal, failure, retry,
  and role-scoped authorization paths for local contributor setups and external dependencies.
- `lib/rollout-guardrails.ts` requires the admin flag permission, records a
  bounded sample window, disables a rollout when its error budget is exceeded,
  and supports an explicit, reasoned emergency disablement.
- `lib/privacy-safe-export.ts` requires an export permission and projects an
  explicit allowlist. Sensitive fields are rejected and reported as redacted;
  callers must opt into only fields they are authorized to release.
- `lib/recovery-checkpoints.ts` gives every external side effect a stable
  operation, step, and idempotency key. A failed step returns to `pending` until
  its retry limit is reached; a succeeded step is idempotent on resume.

### Contributor Diagnostics & Dependency Failure Operational Edge Cases

1. **Missing or Corrupted Dependencies**:
   - When dependencies fail or timeout, `runContributorDiagnostics` signals `retryable: true` with guidance to retry.
   - When retries are exhausted (e.g. `retryAttempts >= maxRetries`), `retryable: false` is returned with remediation steps recommending rollback to `pnpm-lock.yaml` or executing a clean clean-install (`pnpm install --frozen-lockfile`).
2. **Degraded Dependency Modes**:
   - Non-critical dependencies can be tolerated in degraded local setups via `allowDegradedDependencies: true`.
3. **Role Authorization**:
   - Protected or maintainer-only diagnostic checks (e.g., private infrastructure secrets or protected telemetry) verify the caller's role (`actorRoles`) before executing probes to avoid unauthorized access.
4. **Recovery & Rollback**:
   - If local state or node_modules becomes corrupted, contributors should run `git clean -Xdf node_modules` and re-run `pnpm install` against the locked dependencies.

The checkpoint store is deliberately adapter-free so a deployment can persist
the records in its existing database or queue. Persist the record before
starting the side effect, update it after the provider response, and resume
only `pending` records after a process restart. Never retry a `succeeded`
record solely because the caller did not receive the response.
