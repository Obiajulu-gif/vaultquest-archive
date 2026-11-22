# Pool lifecycle state machine

Issue #763. `lib/pool-lifecycle.ts` is the single source of truth for the
VaultQuest pool/vault lifecycle: canonical states, legal edges, status aliases,
guards, and the audit event emitted for every accepted change. Presentation
(`lib/pool-status.ts`), API validation (`backend/src/schemas/savedPools.ts`),
and UI action gating (`stellar-wallet-connect/src/vault/components/PoolDetail.tsx`)
all derive from it, so a status can no longer be interpreted differently in two
places.

## States

| State | Meaning | Terminal |
|---|---|---|
| `draft` | Being prepared; not yet visible to savers. | no |
| `upcoming` | Scheduled to open; not accepting deposits. | no |
| `active` | Open and accepting deposits. | no |
| `paused` | Operational hold (review, incident, `is_emergency`). | no |
| `matured` | Earning period ended; deposits closed. | no |
| `settling` | Draw / settlement in progress. | no |
| `completed` | Finished successfully; archived. | **yes** |
| `cancelled` | Cancelled; will not proceed. | **yes** |

`completed` and `cancelled` are sinks: the state machine defines no outgoing
edges and `canTransitionPool` always returns `false` from them.

## Transition table

| From | Allowed to |
|---|---|
| `draft` | `upcoming`, `cancelled` |
| `upcoming` | `active`, `cancelled` |
| `active` | `paused`, `matured`, `cancelled` |
| `paused` | `active`, `cancelled` |
| `matured` | `settling`, `cancelled` |
| `settling` | `completed`, `active` |
| `completed` | — (terminal) |
| `cancelled` | — (terminal) |

```
draft ──► upcoming ──► active ──► matured ──► settling ──► completed
  │           │          │  ▲          │          │
  └───────────┴──────────┴──┘          └──────────┘
              cancelled                     settling ──► active
                                          (settlement failure)
```

Rationale for the two edges that need it:

- **`active → matured`** (not via `paused`): `matured` is the deposit-closure
  boundary — the contract's `lock_round` freezes the principal snapshot. It is a
  forward lifecycle step, distinct from the reversible operational hold
  (`paused`).
- **`settling → active`**: settlement is an off-chain pipeline (compute yield,
  finalise draw, distribute). If it aborts before finalisation the pool reopens
  for deposits instead of being stranded in a non-terminal state. On-chain
  settlement is atomic, so a rejected transition at that boundary is the cue to
  route the pool back to `active` and retry.

## Rejected transitions

Invalid edges are rejected consistently in one place. `canTransitionPool`
returns `false`, and `assertPoolTransition`/`transitionPool` throw
`InvalidPoolTransitionError` carrying the stable reason code:

```
VAULT_INVALID_STATE_TRANSITION
```

The same code is registered in `lib/rejectionReasons.ts` and resolves through
`getRejectionExplanation()` (category `policy`, non-retryable), so callers reuse
the existing rejection taxonomy rather than inventing an error shape. Cases the
suite pins as rejected include `completed → active`, `cancelled → draft`,
`draft → matured`, `active → completed` (settlement must pass through
`matured → settling`), `paused → matured`, `settled → active` (aliases to the
terminal `completed`), an unknown source token, and same-state no-ops.

## Audit trail

Every accepted transition produces one event (pure — no I/O in the model):

```ts
interface PoolAuditEvent {
  type: "pool.status_changed";
  from: PoolState;
  to: PoolState;
  actor: string | null; // null for indexer/system-driven changes
  at: number;           // epoch milliseconds
  reason?: string;      // optional, e.g. "settlement retry"
}
```

`transitionPool(record, to, ctx)` returns `{ record, event }`, never mutates its
input, and forwards the event to the documented sink `ctx.onTransition(event)`
exactly once, only after the edge is accepted. `lib/pool-lifecycle-notifications.ts`
adapts an event into the deduped notification convention from
[NOTIFICATIONS.md](./NOTIFICATIONS.md) (`vault_pause`, `maturity`,
`round_update`, …) for the client notification center.

Where persistence lives today: this layer does **not** persist events, and the
saved-pools backend stores only pool metadata. A writer that owns the pool
record should pass `onTransition` and append the event to the audit store. That
API/DB persistence is intentionally out of scope for #763 and tracked as
follow-up rather than faked here.

## Alias normalization

`normalizePoolState` maps accepted tokens onto canonical states and returns
`null` for anything unknown (so callers reject rather than silently coerce to
`draft`):

| Input token | Canonical state |
|---|---|
| `open` | `active` |
| `locked` | `paused` |
| `drawing` | `settling` |
| `settled`, `closed` | `completed` |
| `pending` | `upcoming` |
| `canceled` | `cancelled` |

`lib/pool-status.ts` no longer defines its own alias table; it imports
`POOL_STATE_ALIASES` and `POOL_STATES` from `lib/pool-lifecycle.ts`.
`backend/src/schemas/savedPools.ts` validates against the shared
`POOL_STATE_INPUTS`, replacing the previous hand-copied `open | locked | drawing
| settled` subset.

### Alias change

`closed` was previously unrecognized (it fell through to the `draft` display
fallback) even though the contract type
(`stellar-wallet-connect/src/vault/contract/types.ts`) and
[API_REFERENCE.md](./API_REFERENCE.md) treat it as a terminal "round completed"
token. It now aliases to `completed`, so contract-terminal pools classify and
validate consistently.

## Contract reconciliation

The authoritative on-chain ordering is `RoundStatus::Open → Locked → Settled`
in `contracts/drip-pool/src/lib.rs` (see `lock_round` / `settle_round`). The
canonical model expresses that as `active → matured → settling → completed`:

- contract `open` → `active`
- contract `Locked` (principal snapshot frozen, deposits closed) → `matured`
- contract `Settled` → `completed`
- `settling` is the off-chain draw/settlement phase between lock and settle.

`paused` is reserved for an **operational** hold that mirrors the contract's
`is_emergency` circuit breaker and is reversible (`paused → active`). The legacy
on-chain token `locked` still aliases to `paused` for display only; a writer
translating a contract `Locked` round into a *domain transition* should target
`matured`. This split keeps the deposit-closure boundary one-way (as on-chain)
while giving operations a reversible pause, and avoids changing the long-standing
`locked` presentation alias.

## Migration note

- Existing records are unaffected: aliases are applied on read, and the
  canonical state is stored only when a writer applies a transition.
- UI component props are unchanged — `PoolStatusBadge`/`PoolDetail` still accept
  `status?: string`, and `availableActions` keeps the same outputs for the
  on-chain tokens it was tested against.
- New writers should call `transitionPool(record, to, ctx)` instead of assigning
  `status` directly, and reject anything for which `canTransitionPool` is false.

## Testing

`lib/pool-lifecycle.test.ts` iterates the entire transition table (every allowed
edge asserts `canTransitionPool === true` and a correct record + audit event),
pins the rejected cases above, covers alias normalization and terminal states,
and verifies purity/immutability plus the reason-code parity with
`lib/rejectionReasons.ts`.

```bash
pnpm vitest run lib/pool-lifecycle.test.ts lib/pool-status.test.ts
```
