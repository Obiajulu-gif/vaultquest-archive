# Shared Services Contract

The helpers in `services/` (`escrowService.ts`, `questService.ts`,
`savingsService.ts`) are consumed by more than one part of the stack — the
Next.js frontend/dashboard and the cross-stack conformance suite in
`contracts/drip-pool/tests/`. Because a type-compatible change can still break a
_semantic_ guarantee a consumer relies on (a function that used to floor now
rounds, a no-op that starts throwing, an error that stops being wrapped), this
document is the **behavioral contract** for those helpers.

Each guarantee below has a stable ID (e.g. `SAV-1`). **Consumer-driven contract
tests assert these IDs by number**, so a semantically breaking change to
`services/` fails the contract test of the consumer that depends on the old
behavior — not just the shared package's own unit tests:

- **Frontend consumer:** `services/__contracts__/frontend.contract.test.ts`
  (runs on every PR via `pnpm test` in `.github/workflows/validation.yml`).
- **Conformance consumer:** `contracts/drip-pool/tests/services-contract.test.ts`
  (runs via `pnpm test:conformance` / `.github/workflows/conformance.yml`, which
  is triggered on changes to `services/**` and `lib/conformance-spec.ts`).

The canonical source of the numeric/edge-case rules is
[`lib/conformance-spec.ts`](../lib/conformance-spec.ts), mirrored from
`contracts/drip-pool/src/lib.rs`.

---

## `SavingsService` (`savingsService.ts`)

- **SAV-1 — Non-positive deposits are rejected.** `validateDeposit(amount)` and
  `trackDeposit(...)` throw `Error("InvalidAmount")` when `amount <= 0`, is
  `NaN`, or is non-finite, **before** mutating any state.
- **SAV-2 — Lockup window is enforced.** `validateWithdrawal(p, currentLedger)`
  throws `Error("LockupActive")` when `currentLedger < p.lockedUntilLedger`, and
  is a no-op otherwise.
- **SAV-3 — Claim is a no-op, not an error, when nothing is claimable.**
  `claimable(p)` and `claimReward(p)` return `0` (never throw) when
  `yieldAccrued + prize - claimedReward <= 0`.
- **SAV-4 — Claim deadline reverts.** When `p.claimDeadline != null` and
  `now > p.claimDeadline`, both `claimable` and `claimReward` throw
  `Error("ClaimDeadlinePassed")`. A `null`/`undefined` deadline never expires.
- **SAV-5 — Claimable amount formula.** The claimable total is exactly
  `yieldAccrued + prize - claimedReward` (clamped at `0`), and `claimReward`
  advances `claimedReward` by that amount so a second claim yields `0`
  (monotonic, no double-claim).
- **SAV-6 — Lockup reward-weight tiers (bps).** `lockupWeightBps(days)` returns
  `100` for `days <= 0`, `110` for `1..=7`, `125` for `8..=14`, and `150` for
  `>= 15`. This weight applies to rewards only, never to principal.
- **SAV-7 — Deposit tracking side effects.** A valid `trackDeposit` increments
  `currentBalance` by `amount`, increments `streakDays` by 1, marks a milestone
  complete once `currentBalance >= milestone.targetAmount`, and sets
  `isEligibleForReward = currentBalance > 0`.

## `questService.ts`

- **QST-1 — Quests must be funded.** `createChallenge(...)` throws
  `Error("InvalidAmount")` when `rewardAmount <= 0`.
- **QST-2 — Escrow-derived status.** `createChallenge` produces `status:
  "ACTIVE"` / `escrowStatus: "FUNDED"` when an `escrowId` is supplied, else
  `status: "DRAFT"` / `escrowStatus: "PENDING"`.
- **QST-3 — Only funded, active quests are joinable.** `joinChallenge` throws
  `"Quest not found"` for an unknown id and `"Quest is not joinable at this
  time"` when the quest is not `ACTIVE`.
- **QST-4 — Join is idempotent.** Joining a quest a second time with the same
  address returns the existing participation rather than creating a duplicate,
  and the new participation has one `milestoneProgress` slot per quest milestone.
- **QST-5 — Progress is monotonic.** `updateProgress(...)` throws
  `Error("InvalidAmount")` when `newBalance < currentBalance` (withdrawals never
  reduce earned progress) and throws `"Participation not found"` for an unknown
  participant.

## `EscrowService` (`escrowService.ts`)

> **Status: documented, not yet executable-tested.** `escrowService.ts` imports
> `@/lib/escrow/trustlessWork`, `@/lib/escrow/mapper`, and `@/lib/escrow/types`,
> which do not yet exist in the repo, so the module is not importable/consumed by
> any build today. These guarantees define the contract the frontend will rely
> on once those client modules land; the executable contract test ships with
> them.

- **ESC-1 — Errors are wrapped with context.** Every method catches failures
  from `TrustlessWorkClient` and re-throws an `Error` whose message names the
  failing operation and the relevant id (challenge/escrow), so callers get an
  actionable message instead of an opaque client error.
- **ESC-2 — Delegation is stable.** `createEscrowForChallenge`,
  `getEscrowStatus`, `releaseReward` (via `'multi-release'`), and
  `disputeEscrow` (via `'multi-release'`) delegate to the corresponding
  `TrustlessWorkClient` call and return its result unchanged on success.

---

## Versioning & change policy

The shared services are versioned as a logical package with the semantic
contract above as its public surface.

1. **Semantic version, tracked in [`CHANGELOG.md`](./CHANGELOG.md).**
   - **MAJOR** — a guarantee ID is removed or its documented behavior changes
     (e.g. SAV-6 tiers change, SAV-3 starts throwing). Requires updating every
     consumer contract test that asserts the affected ID.
   - **MINOR** — a new guarantee ID / helper is added; existing IDs unchanged.
   - **PATCH** — implementation/refactor with no behavioral change to any ID.
2. **Every change to `services/**` or `lib/conformance-spec.ts` must:** add a
   `CHANGELOG.md` entry, and — for MAJOR/MINOR — update this document's guarantee
   list and the consumer contract tests in the same PR.
3. **CI enforcement.** `conformance.yml` runs on `services/**` and
   `lib/conformance-spec.ts` changes, and `validation.yml` runs the frontend
   contract tests on every PR, so a breaking change fails in the consumer that
   depends on the old behavior.
