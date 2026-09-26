# Quest Rewards — Grant Lifecycle & Idempotency Guarantees

This document explains how `backend/src/services/questService.ts` turns on-chain
activity into quest completions and reward grants. It is the standalone
reference for the reward system — read it alongside the code, which keeps the
same terminology (`computeMetrics`, `projectProgress`, `evaluateWallet`,
`createRewardGrantIfAbsent`, `flagGrantsForReorgedActions`, `processGrants`).

> **⚠️ Production-readiness status:** the *grant records* are real, but the
> actual *payout* is **not wired up**. `processGrants` currently marks grants
> `granted` without disbursing anything (see
> [“The payout path is not production-ready”](#6-the-payout-path-is-not-production-ready)).
> Do not read anything below as describing a system that moves real funds today.

---

## 1. The five standard quests and their metrics

The quest engine tracks motivations on a single `STANDARD_QUESTS` list. Every
quest is measured against one of five metrics, each derived **only** from
`confirmed` `action_ledger` rows (never `submitted`/`pending`/`failed`, and never
rows that have been redacted — `redactedAt != null`).

| Quest id | Title | Metric | Target | Meaning |
|---|---|---|---|---|
| `first_deposit` | First Steps | `depositCount` | 1 | Make your first confirmed deposit |
| `save_100` | Save $100 | `totalDeposited` | 100 | Accumulate $100 in total confirmed deposits |
| `save_100_three_months` | Save $100 for 3 Months | `distinctMonths` | 3 | Deposit in at least three distinct calendar months |
| `participate_5_draws` | Participate in 5 Draws | `distinctPools` | 5 | Deposit into at least five distinct prize pools |
| `first_win` | Lucky Saver | `claimCount` | 1 | Claim a reward from a prize draw |

### Why amounts use `Amount` (bigint) instead of a float SQL cast

`computeMetrics` parses and sums deposit amounts with the `Amount` type (`backend/src/amount.ts`),
**not** a raw SQL `SUM(...)::float`. This is the fix for the #504 precision-loss
history: amounts are treated as bigint minor units, asset-tagged, and summed
exactly. Depositing into a float column on Stellar-sized integer amounts could
otherwise silently round (e.g. a token with >15 significant digits), making
`totalDeposited` drift from the true on-chain value — which would in turn make
`save_100` complete early (over-counted) or never complete (under-counted).

Two precision details to keep in mind:

- `QUEST_ASSET_DECIMALS = 0` and `QUEST_ASSET_CODE = "USD"`. This matches the
  file's pre-existing convention of treating `payload.amount` as an already
  whole-unit dollar figure (e.g. `"100"` means $100 toward `save_100`). As a
  result the `Amount` here is really about *integer exactness* and
  *asset-tagging*, not decimals.
- A deposit whose payload fails `Amount.fromPayload` (missing, fractional, or
  malformed `amount`) is **excluded from `totalDeposited`** but still counts
  toward `depositCount`/`distinctPools`/`distinctMonths`. `computeMetrics`
  deliberately does not silently treat a malformed amount as `0`, because that
  would hide a real problem; it only needs the *existence* (not the parsed
  value) of the action for those three metrics.

`computeMetrics` rides the `(wallet_address, created_at)` composite index with a
single scan — the `tests/quest.spec.ts` benchmark asserts a sub-100ms sweep over
a 2,000-row ledger.

---

## 2. Exactly-once reward grants

### The idempotency key

When a wallet completes a quest, `createRewardGrantIfAbsent` records the
intended grant in `reward_grants`. Its `idempotencyKey` is deterministic:

```
idempotencyKey = sha256(walletAddress + ":" + questId)
```

A wallet can complete a given quest only once in the protocol's lifetime (there
is exactly one `save_100`), so this key is naturally unique per *intended*
grant. The unique constraint on `reward_grants.idempotency_key`
(`@@unique` on the `IdempotencyKey` field) is the backstop.

### What stops a double-grant

There are two ways the same completion could be processed twice — the cron
**sweep re-running**, and a **backfill vs. sweep race**. Both are stopped by the
same mechanism:

- `createRewardGrantIfAbsent` performs an `INSERT`. If a row already exists, the
  `P2002` unique-constraint violation is swallowed and treated as success
  (the grant is already recorded — that's the exact, correct outcome of an
  idempotent insert). This is the #505/#506 design.
- The sweep call-site in `cron.ts` additionally wraps the whole run in a
  `JobLease`, so at most one worker executes a sweep at a time. #505 deliberately
  notes that the idempotency key is what makes even a *double-run safe*, not the
  lease — the lease is defense-in-depth, not the guarantee.

`createRewardGrantIfAbsent` takes a Prisma client/transaction handle explicitly
(rather than always `this.prisma`) so callers can run it inside a larger
`$transaction` alongside the paired `UserQuest` write in `evaluateWallet`.

---

## 3. Reorg / refund correction policy

`flagGrantsForReorgedActions` handles the case where an action **underlying an
already-granted reward** later reverts or is refunded — for example a chain
reorg, or a withdrawal/payout that bounces back.

The policy is deliberately conservative: it **flags for manual review**, it does
**not** auto-claw-back.

- Why not auto-claw-back? This is a real-money decision. The #505 design proposal
  explicitly declined to guess at it unilaterally, and an irreversible automated
  claw-back based on a possibly-temporary reorg would be riskier than surfacing
  the inconsistency for a human decision.
- Why not quietly ignore it? “Do nothing” would silently let `reward_grants`
  drift from ledger truth — a granted reward whose funding action no longer
  stands. That's not an acceptable default either.

What `flagGrantsForReorgedActions` does:

1. It scans a set of wallet addresses whose confirmed actions have recently
   reverted/refunded.
2. For each wallet it recomputes quest metrics (`computeMetrics`) and re-projects
   progress (`projectProgress`).
3. For every `granted` `RewardGrant` whose quest would **no longer** meet its
   target, it flips the grant to `status = "needs_review"` and records a
   `lastError` explaining that the underlying action(s) reverted/refunded and
   the quest no longer meets its target.

`needs_review` is deliberately **distinct from `failed`**: `failed` means a
payout attempt errored out, whereas `needs_review` means a *completed* payout's
justification changed after the fact.

### What “resolving” a `needs_review` grant looks like

The tooling for automated resolution does **not** exist yet — this is the
intended operational process, currently manual:

1. An operator reviews the flagged grant (and the `lastError` reason + the
   underlying ledger rows for the wallet).
2. **If the quest genuinely no longer qualifies** (the reorg was final, the
   refund stands): the grant must be handled like the payout path's correction
   policy dictates — either void the grant or recover the disbursed funds. Since
   `processGrants` doesn't actually pay out yet (see §6), “recovery” today means
   cancelling the grant row (e.g. `failed` or a manual delete/void) rather than
   clawing back on-chain assets.
3. **If the quest still qualifies** (the action is confirmed again, e.g. the
   reorg resolved back to the original state): reset the grant to `granted` and
   clear `lastError`, so it is no longer surfaced for review.

The exact SQL/JSON of “reset” and “void” has not been codified into a helper
yet; until it is, operators update the `reward_grants` row directly per the
state table in §5.

---

## 4. State model of a reward grant

`reward_grants` rows move through these statuses:

| Status | Meaning | Terminal? | Entered by |
|---|---|---|---|
| `pending` | Grant recorded but payout not yet attempted | No (initial) | `createRewardGrantIfAbsent` |
| `granted` | Marked as granted (see ⚠️ §6) | Yes | `processGrants` |
| `needs_review` | Underlying action reverted/refunded after grant; no auto-clawback | No (manual) | `flagGrantsForReorgedActions` |
| `failed` | Payout attempts exhausted (dead-letter) | Yes | `processGrants` (error branch) |

Additional tracking fields: `attempts` (incremented per payout attempt),
`lastError` (reason for `failed`/`needs_review`), `grantedAt` (timestamp of
`granted`).

---

## 5. Measurement caveats

- **Only `confirmed` + non-redacted rows count.** A `submitted` action you
  haven't confirmed yet doesn't move progress — the wallet must wait for the
  chain to confirm it.
- **Redactions remove history.** A privacy scrub (`DELETE /actions`) nulls the
  payload and sets `redacted_at`; `computeMetrics` skips those rows entirely, so
  scrubbed activity no longer contributes to quest progress. This is intended
  (privacy) but means quest progress can decrease after a scrub.
- **Malformed deposits count-but-don't-sum.** A deposit with a bad `amount`
  still increments `depositCount` and the pool/month sets, but contributes `0`
  to `totalDeposited` (and surfaces as a non-fatal `InvalidAmountError` skip,
  not a disguised `0`).

---

## 6. The payout path is not production-ready

`processGrants` (`attempts`-bounded, dead-lettering to `failed` after
`maxAttempts`, batching via `take: limit`) is the intended payout pipeline, but
the actual disbursement call is **not wired up**. From the code's own
`TODO(#505)`:

> There is no existing reward/credit-disbursement mechanism anywhere in this
> codebase to call into. This method currently marks every `pending` grant
> `granted` without performing a real payout, which is **NOT safe to run against
> production data** — it exists so the idempotency/retry/dead-letter machinery is
> in place and testable.

Two decisions are unresolved and block a real payout:

1. **What the payout call actually is** — an on-chain contract invocation? An
   off-chain credit-ledger entry?
2. **The correction policy for a reorged/refunded action underlying an
   already-granted reward** — see §3 (flag for review is the current safe
   default; auto-clawback is open).

The design reasoning and open questions live on issue **#505** (precision-loss
history on #504, double-grant sweeps on #505/#506, single-canonical-pool on
#507). Any work to wire up payouts should start by resolving those issues.

---

*Guide to the code:* `computeMetrics` / `projectProgress` (metric computation),
`evaluateWallet` (per-wallet evaluation + paired `UserQuest`/grant write),
`createRewardGrantIfAbsent` (the idempotent insert in §2),
`flagGrantsForReorgedActions` (the correction policy in §3), `processGrants`
(the stub payout pipeline in §6).