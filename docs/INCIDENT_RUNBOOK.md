# Incident Triage and Emergency Rollback Runbook

This runbook is the first stop for VaultQuest production incidents. It covers
triage, containment, validation, and recovery communications across the web
app, TypeScript backend, Stellar/Soroban contracts, indexer, and user
dashboards. Use the linked domain runbooks for detailed repair and recovery
procedures. On-chain state is authoritative for funds and transaction outcomes.

## Incident roles and severity

The incident lead coordinates decisions and communications; the service owner
for the affected surface investigates and executes approved changes. One
person may fill both roles in a small response, but financial repairs and
high-risk contract actions still require the controls in their specific
runbooks.

| Severity | Decision point | Initial action |
|---|---|---|
| **SEV-1** | Suspected loss or mis-accounting of funds, unsafe withdrawals or payouts, compromised signing/control plane, or broad service outage | Page the incident lead and backend/protocol owners. Contain risky writes immediately and preserve evidence. |
| **SEV-2** | A critical flow is impaired for multiple users, indexer is persistently degraded, or reconciliation detects financial contradictions | Assign an owner, assess scope, and mitigate the affected feature or service. Escalate to SEV-1 if funds or integrity are at risk. |
| **SEV-3** | Isolated user/dashboard issue with no evidence of funds or system integrity impact | Track with the owning team, investigate with the user-visible error/correlation ID, and monitor for spread. |

Severity is based on user and funds impact, not alert volume. If impact is
unclear and funds may be affected, treat it as SEV-1 until verified otherwise.

## First response

1. **Declare and coordinate.** Record incident start time, severity, incident
   lead, affected surface, and a private response channel. Keep an append-only
   timeline of observations and actions.
2. **Scope impact.** Identify affected operations, environments, release or
   contract version, approximate start time, and whether user transactions
   were submitted. Use error correlation IDs and aggregate metrics; do not
   paste wallet addresses, transaction payloads, tokens, or credentials into
   public tickets or chat.
3. **Check current health.** Query the backend endpoints and monitoring
   configured for the environment:
   ```bash
   curl -fsS "$BACKEND_URL/health/indexer"
   curl -fsS "$BACKEND_URL/metrics"
   ```
   Review the [Maintainer Dashboard](MAINTAINER_DASHBOARD.md), backend
   [Prometheus alerts](../backend/prometheus/alerts.yml), and structured logs
   using the reported `correlation_id`. The indexer health endpoint and
   ingestion alerts are detailed in the [Indexer Runbook](INDEXER_RUNBOOK.md).
4. **Contain before repair.** Stop a rollout or disable the smallest risky
   feature that limits further impact. Do not replay transactions, mutate
   accounting records, clear quarantines, or run a repair plan until the
   on-chain evidence and affected records have been reviewed.
5. **Verify containment.** Check the relevant health/metrics and logs for new
   failures, confirm the affected operation has stopped or recovered, and
   monitor through at least one normal worker/indexer cycle.

## Incident routing

| Signal or symptom | First checks and owner action | Detailed procedure |
|---|---|---|
| Deposits, withdrawals, claims, or wallet sign-in fail | Backend owner checks API status, structured failures, RPC availability, and wallet-provider status. Use the correlation ID; distinguish a wallet rejection from a submitted transaction. For a submitted transaction, verify its final chain status before retrying. | [API](API.md), [Indexer Runbook](INDEXER_RUNBOOK.md) |
| Indexer stalled, lagging, or holding poison events | Backend/indexer owner checks `/health/indexer`, `/metrics`, Prometheus ingestion alerts, RPC errors, and unresolved poison events. Do not advance a cursor or mark an event resolved without verifying its chain record. | [Indexer Runbook](INDEXER_RUNBOOK.md) |
| Ledger drift, orphaned action, or stuck settlement | Backend/protocol owner runs reconciliation in dry-run mode, inspects quarantine and chain evidence, and uses dual control for high-value repairs. Never auto-correct a contradiction or insolvency discrepancy. | [Reconciliation](RECONCILIATION.md), [Maintainer Dashboard](MAINTAINER_DASHBOARD.md) |
| Prize draw proof, winner selection, or payout appears incorrect | Protocol owner halts additional affected draw execution, verifies the draw inputs/proof and contract events, and determines whether any payout transaction was already submitted. Preserve records; do not rerun a draw to "fix" an outcome. | [Feature Flags](FEATURE_FLAGS.md), [Draw Audit](DRAW_AUDIT.md), [Contract rollback](../contracts/docs/UPGRADE_ROLLBACK.md) |
| Dashboard balances or transaction status are stale | Frontend owner checks API responses and client errors; backend owner checks indexer checkpoint, event backlog, and reconciliation. Confirm chain state before communicating a balance correction. | [Indexer Runbook](INDEXER_RUNBOOK.md), [Reconciliation](RECONCILIATION.md) |
| Backend database is unavailable, corrupted, or restored from an old backup | Backend/data owner freezes writes, assesses backup freshness, restores off-chain records, and rebuilds chain-derived state. Do not treat a database restore as a rollback of on-chain activity. | [Disaster Recovery](DISASTER_RECOVERY.md) |
| Contract release causes unsafe or broken on-chain behavior | Protocol/contract owner follows the contract-specific pause and upgrade rollback procedure. Account for the timelock; this is not an instant application rollback. | [Upgrade rollback](../contracts/docs/UPGRADE_ROLLBACK.md), [Deployment provenance](DEPLOYMENT_PROVENANCE.md) |

## Emergency feature containment

Use the authorized, audited feature-flag operation described in
[Feature Flags](FEATURE_FLAGS.md). Disable only the affected global or scoped
flag, record the incident reason, operator, and time, then confirm the stored
flag state and observe that new executions stop.

| Flag | Containment effect | Important limitation |
|---|---|---|
| `prize-draw-execution` | Stops new proof generation and prize distribution through the flagged path. | Does not undo proofs or payouts already generated or submitted. |
| `withdrawal-submission-enabled` | Stops new withdrawal submissions through the flagged path. | Pending user actions may remain pending; reconcile their transaction status before retrying. |
| `reconciliation-auto-repair` | Stops automated repair-plan execution while allowing detection/proposals to be reviewed. | Does not resolve existing drift or quarantine records. |

If flag control is unavailable or the fault is outside the flagged path, stop
the affected worker/service or roll back the application release using the
deployment platform's approved procedure. Do not disable unrelated safeguards
or bypass authorization/audit controls. Flag changes cannot reverse a Stellar
transaction already submitted to the network.

## Application release rollback

Use this path for a bad frontend or backend release; it does not roll back
contract state or database contents.

1. Stop further rollout and identify the last known-good, verified release
   artifact/commit. Confirm the incident is release-related and identify
   whether any migration or externally submitted transaction occurred.
2. Disable the implicated feature flag first when that safely contains the
   risk. Otherwise use the release platform's rollback to the prior artifact.
   For a Kubernetes-managed backend, the operator may use the deployment's
   configured name and namespace:
   ```bash
   kubectl rollout undo deployment/<backend-deployment> -n <namespace>
   kubectl rollout status deployment/<backend-deployment> -n <namespace>
   ```
   For a frontend hosted on Vercel, promote the verified previous deployment
   through the project's deployment controls. Follow the configured provider
   procedure if the service is deployed elsewhere.
3. Verify the running artifact/commit, health endpoints, error rates, and the
   affected user flow. For an indexer incident, verify sync progress resumes;
   for accounting concerns, verify against chain state and keep affected
   records quarantined until reviewed.
4. **Do not automatically roll back database migrations.** Production schema
   changes are applied with `prisma migrate deploy`; migrations are designed
   to be additive and rollback is intentionally manual. Keep the service
   compatible with the deployed schema and prepare a reviewed forward fix or
   migration plan with the backend owner. See
   [backend migration strategy](../backend/docs/ARCHITECTURE.md#migration-strategy)
   and [Migration Safety](MIGRATION_SAFETY.md).
5. For contract logic or state, follow the contract-specific upgrade rollback
   runbook. Do not assume promoting an older web/backend release restores
   contract behavior or reverses on-chain effects.

## Recovery validation

Run the focused checks for the affected domain from the repository root. These
commands validate code and fixtures; they do not authorize or execute a
production repair:

```bash
pnpm docs:validate
pnpm --filter backend run build
pnpm --filter backend exec vitest run tests/indexer.spec.ts tests/reconciler.spec.ts tests/featureFlagService.spec.ts tests/drawProofService-featureFlag.spec.ts
```

For contract changes, also run the contract tests and checks required by the
[contract contributor guide](../contracts/README.md). Before restoring a
feature flag or resuming a rollout, reproduce the failure in a non-production
environment, verify the fix against the relevant tests and chain fixtures,
obtain the domain owner's approval, and re-enable gradually while watching
health and error metrics.

For suspected record drift, use a dry run and the review/approval process in
[Reconciliation](RECONCILIATION.md). For database recovery, follow the rebuild
and verification steps in [Disaster Recovery](DISASTER_RECOVERY.md). Never
run test commands that target production data or include production
credentials in command history.

## Recovery communications

The incident lead owns updates. Share only verified facts and avoid exposing
secrets or unnecessary wallet/transaction identifiers.

| Milestone | Include |
|---|---|
| Initial notice | Start time, affected user flows, known impact, current mitigation, and next update time. Mark unknowns as unknown. |
| Progress update | What changed, whether new failures have stopped, what remains under investigation, and user action to avoid if needed. |
| Resolution | Recovery time, verified affected flows, any delayed transaction/reconciliation work, and support route for remaining cases. |
| Follow-up | Root cause, impact window, corrective actions with owners, and any reconciliation or data-recovery work still pending. |

Keep the internal incident timeline and audit trail. Do not state that funds
are safe or balances are final until verified against the relevant on-chain
state.

## Related operational references

- [Feature flags and emergency rollback](FEATURE_FLAGS.md)
- [Maintainer Dashboard](MAINTAINER_DASHBOARD.md)
- [Indexer Operations Runbook](INDEXER_RUNBOOK.md)
- [Reconciliation and repair](RECONCILIATION.md)
- [Chain-state Disaster Recovery](DISASTER_RECOVERY.md)
- [Contract upgrade rollback](../contracts/docs/UPGRADE_ROLLBACK.md)
- [Backend observability](../backend/docs/OBSERVABILITY.md)