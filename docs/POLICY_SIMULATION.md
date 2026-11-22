# Policy simulation preview

`lib/policy-simulation.ts` lets maintainers preview a governance/policy change
— affected records and users, expected side effects, risk, and rollback
constraints — **before** committing anything irreversible or high-impact.

It complements the narrower previews that already exist:

- [`admin-parameter-simulation.ts`](../lib/admin-parameter-simulation.ts) for
  protocol parameters (fees, deposit bounds, cadence),
- [`permission-diff.ts`](../lib/permission-diff.ts) for RBAC/permission
  policies (see `docs/API_REFERENCE.md` for the maintainer endpoints).

This module covers the data-affecting policies: retention windows,
notification defaults, feature-flag rollout, search index rebuilds, and
session lifetimes.

## How a preview is produced

```ts
import { createPolicyPreview, preparePolicyApplication } from "../lib/policy-simulation";

const preview = await createPolicyPreview(
  [{ policyId: "retention.userDataExportDays", from: 30, to: 7 }],
  impactSource, // measures affected records/users for the change
  { author: "operator-wallet" },
);

preview.summary;          // counts: valid, blocked, highImpact, irreversible…
preview.changes[0].impact; // { affectedRecords, affectedUsers, sampleRecords }
preview.rollbackPlan;      // steps, constraints, irreversible warning

const plan = preparePolicyApplication(preview, {
  confirmedToken: preview.confirmationToken,
  acknowledgeIrreversible: true,
});
// plan.activated === false — persisting the change is the caller's job.
```

The **impact source** is the seam to real data:

```ts
export interface PolicyImpactSource {
  measure(change, spec): PolicyImpactMeasurement | Promise<PolicyImpactMeasurement>;
}
```

In production it runs dry-run counts against the database (for example
`SELECT count(*)` and `count(distinct wallet)`); in tests it is a fixture. Its
`measure` output is folded into the preview's confirmation token, so a token
issued for one measured impact cannot authorize a different one.

## Catalog and validation

Each entry in `POLICY_CATALOG` declares:

- bounds (`min`/`max`/`integer`) and the current value; a request whose `from`
  does not match the current value is **stale** and blocked,
- `affectedSurfaces` and `sideEffects` (what actually changes for users),
- `reversible` and `rollbackConstraints`,
- `impactThresholds` (records/users) above which the change is high impact.

The engine blocks a change when it is unknown, stale, out of bounds,
wrong-typed, or when its impact could not be measured. Blocked changes are
still rendered in the preview with the reasons attached, so a rejected request
is visible rather than silently dropped.

## Risk and confirmation

- Risk starts from the relative magnitude of the change (`low`, `medium`,
  `high`), is escalated to `high` when measured impact exceeds a threshold,
  and is `none` for no-ops.
- `confirmationToken` is a deterministic hash over the changes **and** the
  measured impact. `preparePolicyApplication` refuses to produce a plan
  without the exact token (`PolicyConfirmationRequiredError` /
  `PolicyPreviewStaleError`).
- Previews containing irreversible changes additionally require
  `acknowledgeIrreversible: true` (`IrreversiblePolicyError` otherwise). The
  acknowledgement is recorded in the plan — it authorizes the change, it does
  not make it reversible.
- The returned plan is always `activated: false`; the caller persists the
  change (usually as a governance proposal/audit record) and owns rollback.

## Operational edge cases

| Edge case | Behavior |
| --- | --- |
| Impact measurement times out or errors | That change is blocked with an `impact` issue and the error text; the preview fails loudly instead of guessing. |
| Policy edited between preview and apply | `from` no longer matches the catalog → change is blocked as stale; re-run the preview. |
| Token copied from an older preview | Impact and change hashes differ → `PolicyPreviewStaleError`; re-run the preview. |
| Multiple changes in one preview | Aggregated summary and one combined rollback plan; a single blocked change blocks the whole application. |
| High-impact but reversible change (e.g. 100% rollout) | Requires confirmation (impact threshold), but not irreversible acknowledgement. |
| No-op (from == to) | Risk `none`, no confirmation required, still recorded in the preview. |

## Failure modes and recovery

- **Applied a change with the wrong scope.** Re-run the preview and apply the
  inverse change; the aggregated `rollbackPlan.steps` list the per-policy
  reversal. For reversible policies, delivery/flags revert on the next
  dispatch or session.
- **Applied an irreversible retention change too aggressively.** Purged export
  payloads cannot be regenerated. Recover from the most recent verified
  database backup (see [`DISASTER_RECOVERY.md`](./DISASTER_RECOVERY.md)), then
  re-extend the retention window. This is why the preview marks retention
  irreversible and requires explicit acknowledgement.
- **Confirmation token mismatch in production.** Treat as a stale plan; do not
  bypass the check. Re-run `createPolicyPreview` against the current values
  and measured impact, then re-confirm.
- **Impact source measured zero records but the change is broad.** Verify the
  source's query filters before applying; zero is a valid measurement only
  when the policy truly has no current rows to affect.

## Rollback

The feature is additive: callers that do not preview can still change policies
directly. To disable the preview path, stop calling `createPolicyPreview` /
`preparePolicyApplication`; nothing is persisted by these functions, so no
cleanup is required. Audit/plan records written by the caller follow the
caller's retention rules.

## Verification

```bash
pnpm exec vitest run tests/policy-simulation.test.ts tests/parameter-simulation.test.ts tests/permission-diff.test.ts
```
