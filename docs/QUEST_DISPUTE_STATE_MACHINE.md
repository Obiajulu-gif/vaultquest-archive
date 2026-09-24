# Quest / Escrow Dispute and Timeout State Machine

Issue #738. Extends [`QUEST_EXPIRY_AND_REFUND_POLICY.md`](./QUEST_EXPIRY_AND_REFUND_POLICY.md)
(#741) to cover the unhappy paths that policy explicitly scoped out: an
ambiguous, disputed, or never-resolving completion condition.

## States

```
                 ┌─────────┐
                 │  draft  │  (no escrow yet)
                 └────┬────┘
                      │ EscrowService.createEscrowForChallenge
                      ▼
                 ┌─────────┐
        ┌────────┤ funded  ├────────┐
        │        └────┬────┘        │
        │ deadline     │ dispute     │ deadline passes,
        │ passes,      │ raised      │ nothing raised/completed
        │ completed    ▼             │
        │        ┌───────────┐       │
        │        │ disputed  │       │
        │        └─────┬─────┘       │
        │   ┌───────────┼───────────┐│
        │   │ arbitrated│  timeout  ││
        │   │ within    │  elapses  ││
        │   │ window    │  (silent) ││
        │   ▼           ▼           ▼▼
        │ ┌────────┐ ┌────────┐ ┌─────────┐
        │ │resolved│ │resolved│ │ expired │
        │ │(arb.)  │ │(fallbk)│ └────┬────┘
        │ └────────┘ └────────┘      │
        ▼                            ▼
  ┌──────────┐                 ┌──────────┐
  │completed │                 │ refunded │
  └──────────┘                 └──────────┘
```

`resolved` carries a `resolution` of `released`, `refunded`, or `split` (see
`TWEscrowStatusResponse.resolution` in `lib/escrow/types.ts`) — it is a
terminal state whose *outcome* varies, not a fourth distinct outcome.

## Transitions

| From | Event | To | Enforced by |
|---|---|---|---|
| `draft` | `createEscrowForChallenge` | `funded` | This service + Trustless Work escrow creation |
| `funded` | Verified completion before deadline | `completed` | `EscrowService.releaseReward` → Trustless Work contract |
| `funded` | Deadline passes, uncompleted | `expired` → `refunded` | `EscrowService.refundExpiredChallenge` (#741) |
| `funded` | Either party raises a dispute | `disputed` | `EscrowService.disputeEscrow` |
| `disputed` | Arbitration decision within the dispute window | `resolved` (`released`/`refunded`/`split`) | `EscrowService.resolveDispute` |
| `disputed` | Dispute window elapses with no arbitration | `resolved` (`split`, 50/50 by default) | `EscrowService.applyDisputeTimeoutFallback` |

## No stuck states

Every non-terminal state (`funded`, `disputed`) has exactly one condition
that moves it forward, and every condition is either a bounded deadline or
an explicit action — there is no state that depends solely on an actor
choosing to act with no fallback if they don't:

- `funded` always resolves via completion, expiry, or dispute — the deadline
  itself is the fallback if nobody does anything.
- `disputed` always resolves within the dispute window via arbitration, or
  via the timeout fallback if it doesn't. The timeout fallback is not
  optional tooling — the state machine has no other way out of `disputed`,
  so whatever schedules the sweep (see "Operational follow-up" in the
  companion policy doc) must call `applyDisputeTimeoutFallback` for any
  quest whose dispute window has elapsed.

## Fairness: the timeout fallback cannot be gamed by silence

The failure mode this guards against: whichever party benefits from
inaction (the funder if the completer would otherwise win, or vice versa)
has an incentive to dispute and then simply go quiet, hoping the fallback
favors them by default.

`applyDisputeTimeoutFallback` defaults to a 50/50 `split`
(`fallbackSplitBps = 5000`), not a full release or a full refund. Neither
party's silence advantages them — going quiet after disputing gets you half,
the same as if you'd never disputed and let a legitimate completion land,
and worse than actually winning arbitration would have. The split ratio is
a parameter (`fallbackSplitBps`), not hardcoded, so a specific quest type
can configure a different default if 50/50 is inappropriate for it — but
the *existence* of a non-extreme default is what removes the incentive to
stay silent.

## Explicit non-goals

- This does not implement a decentralized arbitration mechanism (voting,
  staking, etc.) — `resolveDispute`'s `resolution` argument is supplied by
  whatever caller has arbitration authority (an admin action, in the
  current codebase; a more decentralized arbiter is a separate, larger
  design question raised in the original issue but not solved here).
- The dispute window's length is not defined in code in this PR — it's a
  property of the underlying Trustless Work escrow configuration, not
  something this repo currently overrides.
