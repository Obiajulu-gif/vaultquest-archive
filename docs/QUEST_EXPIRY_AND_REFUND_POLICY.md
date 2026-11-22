# Quest Expiry and Refund Policy

Issue #741. Companion to [`QUEST_TRUST_BOUNDARY.md`](./QUEST_TRUST_BOUNDARY.md),
which establishes that funds-gating decisions must be contract-enforced, not
service-layer advisory checks — this document applies that rule to the
"quest funded, never completed or claimed" case.

## Policy

Every quest (`Challenge`) funded into escrow carries a `deadline` (ISO 8601,
required at creation — see `types/challenge.ts`). Once `Date.now()` passes
`deadline` and the quest has not reached a terminal `completed` state, the
escrowed funds are eligible for refund back to `funderAddress`, triggered via
`EscrowService.refundExpiredChallenge(challenge)`
(`services/escrowService.ts`).

Refund is not automatic-on-expiry by default — it is triggered by a caller
(scheduled job, admin action, or a "claim this refund" UI affordance for the
funder) that has already confirmed the deadline has passed. `refundExpiredChallenge`
re-validates the deadline itself and throws if called early, so a caller
racing its own clock skew fails safely rather than refunding prematurely.

## No unresolved quests

Every non-completed quest has exactly one eventual resolution path:

- **Completed before the deadline** → `EscrowService.releaseReward(...)`.
  Terminal. No refund is possible afterward (see race handling below).
- **Not completed by the deadline** → `EscrowService.refundExpiredChallenge(...)`.
  Terminal. No completion/release is possible afterward.
- **Disputed** → out of this document's scope; see
  [`QUEST_DISPUTE_STATE_MACHINE.md`](./QUEST_DISPUTE_STATE_MACHINE.md) (#738),
  which itself guarantees no permanently-stuck state via its own timeout
  fallback.

There is no quest state that lacks a path to one of the above — a quest is
never merely "abandoned" with its escrow sitting untouched indefinitely,
provided *something* eventually calls either `releaseReward` or
`refundExpiredChallenge` (or, for a disputed quest, the dispute-resolution
path). Nothing in this repo currently runs that trigger on a schedule — see
"Operational follow-up" below.

## Race safety: completion vs. refund at the deadline

This is the hard part the issue calls out: a completion landing at almost
exactly the same instant as a refund attempt must not let both succeed
(double-paying) or unfairly reject a genuinely just-in-time completion.

**The mutual exclusion is enforced by Trustless Work's own escrow contract,
not by this codebase.** Trustless Work's escrow is an on-chain Stellar/Soroban
resource with a single mutable status; its contract guarantees that a
`release` and a `refund` against the same escrow cannot both succeed —
whichever lands first (block-ordered on-chain) wins, and the second is
rejected by the contract itself.

This codebase's job is to call that API correctly and interpret its
authoritative answer, per [`lib/escrow/trustlessWork.ts`](../lib/escrow/trustlessWork.ts):

- `refundExpiredChallenge` calls `TrustlessWorkClient.refund(...)` directly —
  it does **not** call `getStatus()` first to check whether the quest was
  already completed. A check-then-act sequence is exactly the race window
  this needs to avoid: the status could change between the check and the
  refund call. Calling `refund()` directly and trusting its response is the
  atomic operation.
- If a completion already landed on-chain, the API call returns a conflict,
  surfaced as `EscrowConflictError` (`lib/escrow/types.ts`) rather than a
  generic failure — the caller can distinguish "this quest was already
  completed, so the refund correctly did not happen" from "the refund
  attempt itself broke."
- Symmetrically, `releaseReward` calling into an already-refunded escrow
  gets the same typed rejection from the same contract-level guarantee.

## Operational follow-up (not implemented here)

Nothing in this PR schedules `refundExpiredChallenge` to run automatically.
A follow-up should add a cron-style sweep (mirroring the pattern other repos
in this org use for similar "sweep expired X" jobs) that lists quests past
`deadline` and not `completed`, and calls `refundExpiredChallenge` for each,
tolerating and logging (not crashing on) `EscrowConflictError` for any that
completed in the same window the sweep is running.
