# Domain invariants (#789)

These are rules the VaultQuest domain must satisfy **regardless of which path
produced the state** — API route, dashboard, worker, or on-chain contract event.
A rule lives here when breaking it would mean the product is showing a state
that cannot exist: money created or lost, access granted without authority, a
transaction that un-confirms itself, or a history that has been edited.

The executable form is
[`backend/tests/invariants.spec.ts`](../backend/tests/invariants.spec.ts). When
you change domain behaviour, change these tests in the same PR — an invariant
that is no longer enforced is a bug, not dead code.

Run them:

```bash
pnpm --filter backend test -- invariants
```

## Money

| # | Invariant | Code path | Why it matters |
| --- | --- | --- | --- |
| I1 | An amount is always an integer minor-unit value of exactly one asset | [`amount.ts`](../backend/src/amount.ts) `Amount.fromPayload` | A fractional or empty amount is a corrupt ledger row; it is rejected rather than coerced |
| I2 | Arithmetic never crosses assets | `Amount.add` / `subtract` / `compare` / `sum` via `validateMatchingAsset` | Summing USD into USDC would silently invent or destroy value |
| I3 | A single-asset sum preserves that asset and is exact | `Amount.sum` | Dashboard and quest totals must not drift from the ledger |
| I4 | A balance is only spendable while positive, and an over-debit is detectable before it is applied | `Amount.isPositive` / `compare` | Prevents a withdrawal larger than the balance from reaching the contract |
| I5 | Amounts are immutable — every operation returns a new value | all `Amount` operations | A shared mutable amount would corrupt unrelated totals |

## Ownership and access

| # | Invariant | Code path | Why it matters |
| --- | --- | --- | --- |
| I6 | An invitation can never grant a role above the inviter's own | [`invitationService.ts`](../backend/src/services/invitationService.ts) `create` | Server-side escalation guard: a contributor cannot mint an admin, regardless of what the request body claims |
| I7 | Only the invited wallet can accept, and acceptance is terminal | `accept` + `TERMINAL_STATES` | Prevents a third party from consuming an invite; an accepted invite cannot be replayed |
| I8 | A user can never grant themselves access | `create` (`SELF_INVITE`) | Self-invite would create a circular ownership record |

## Lifecycle

| # | Invariant | Code path | Why it matters |
| --- | --- | --- | --- |
| I9 | A terminal action status never transitions onward | [`constants.ts`](../backend/src/constants.ts) `TERMINAL_STATUSES` / `canTransition` | Confirmed funds must not be un-confirmed by a late worker event |
| I10 | An action cannot skip confirmation | `canTransition` | `pending → confirmed` is impossible; settlement requires a submitted transaction first |
| I11 | Only an orphaned action can be re-submitted | `canTransition` | Bounds reorg recovery to exactly the case that needs it |
| I12 | An unknown status is never a valid transition target | `canTransition` | A typo or new status string cannot corrupt a lifecycle |
| I13 | Quest progress is bounded by its target and never negative | [`questService.ts`](../backend/src/services/questService.ts) `STANDARD_QUESTS` | Quests are derived from confirmed ledger rows, so progress cannot run backwards or past the target |

## History integrity

| # | Invariant | Code path | Why it matters |
| --- | --- | --- | --- |
| I14 | A money or access mutation is never recorded without a reason | [`changeHistoryService.ts`](../backend/src/services/changeHistoryService.ts) `REASON_REQUIRED_ACTIONS` | `SETTLEMENT`, `ROLE_CHANGE`, `REVOKE` and `DELETE` always carry a justification |
| I15 | The history of a critical record always verifies | `ChangeHistoryService.verify` | Detects an edited, deleted, reordered or spliced chain — see [CHANGE_HISTORY.md](CHANGE_HISTORY.md) |
| I16 | A rejected mutation leaves no gap in the chain | `append` | A failed write must not look like tampering to the verifier |

## Action vocabulary

| # | Invariant | Code path | Why it matters |
| --- | --- | --- | --- |
| I17 | Only the known action types can exist in the ledger | `ACTION_TYPES` | The ledger vocabulary is closed, so unrecognised mutations cannot be represented |

## Adding an invariant

1. Name the impossible state it prevents, in one sentence.
2. Add the assertion to `invariants.spec.ts` under the matching group,
   exercising the real service — not a re-implementation of it.
3. Add a row to the table above with the code path and the reason.
4. If the invariant cannot hold today, fix the domain code first: a test that
   documents a known violation without failing is worse than no test.
