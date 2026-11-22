# Explainable Action Risk Scoring

Action detail and internal action-history responses include an additive
`risk_assessment` object. The deterministic score is recalculated from the
action type, current status, retry count, and authorization error code; it is
not a new authorization decision and does not block submission, confirmation,
or recovery.

## Scoring policy

| Signal | Points | Explanation |
| --- | ---: | --- |
| Deposit / claim | 5 | Asset or reward movement |
| Vault creation | 15 | Protocol-state change |
| Withdrawal / winner selection | 25 | Asset exit or payout determination |
| Compensating action | 30 | Reversal or repair operation |
| Each retry | 10, capped at 20 | Repeated attempt |
| Failed or reverted status | 15 | Action did not complete normally |
| Known authorization-denial error | 35 | Authorization rejected the action |

The total is capped at 100. Scores are `low` (0–24), `elevated` (25–49),
`high` (50–74), or `critical` (75–100). `requires_review` is true at 50 or
above. Every non-zero contribution is listed in `factors` with a stable code,
point value, and human-readable explanation. This is a triage signal, not
fraud proof or a replacement for wallet signatures, RBAC, or maintainer
approval.

## Operational edge cases and recovery

- Scores are derived at read time, so a retry or terminal status change is
  reflected without a backfill. If an action is later reconciled to a different
  status, its score follows the reconciled ledger state.
- Retry counts below zero or outside the safe-integer range contribute zero;
  unknown error codes do not count as authorization denials. The original
  action state is returned unchanged.
- Authorization-denial scoring relies on the persisted error code. A denial
  that is not recorded as one of the recognized codes is not inferred from
  client-supplied payload content.
- If scoring is unavailable because of an application defect, the action API
  should fail visibly rather than return a success-shaped score. No writes or
  external side effects are performed by scoring.
- Rollback requires no data migration: remove the response field and scoring
  helper. Existing action records, idempotency keys, and chain state remain
  untouched. Consumers should ignore the additive field if they do not use
  risk data.

## Verification

`backend/tests/actionRiskScoring.spec.ts` covers normal, failed, retried, and
authorization-denied cases, including score levels and review thresholds.
Run it from the repository root with:

```sh
pnpm --filter backend exec vitest run tests/actionRiskScoring.spec.ts
```
