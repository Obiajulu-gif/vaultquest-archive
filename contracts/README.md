# Soroban contracts

This workspace is the home of the TrustQuest on-chain contracts (#10, #11,
#12). It exists today as a thin scaffold so two cross-stack issues have a
real artifact to land against:

- **#26** — Soroban integration tests + client-compatibility checks
- **#27** — Storage rent / footprint / per-op cost optimization

The current `drip-pool` crate is a placeholder skeleton: enough to prove
the integration harness wires up end-to-end and to give the cost-tracking
spec a measurable baseline. As the real contract work lands the lifecycle
methods get filled in; the harness shape stays.

## Layout

```
contracts/
├── Cargo.toml          # workspace root
├── drip-pool/
│   ├── Cargo.toml
│   └── src/
│       ├── lib.rs      # contract scaffold (#10/#11/#12 will replace)
│       └── test.rs     # lifecycle integration harness (#26)
├── docs/
│   ├── CONTRACT_COSTS.md   # cost spec + tracking workflow (#27)
│   ├── EVENT_SCHEMA.md     # canonical emitted event schema (#68)
│   └── PAUSE_RECOVERY.md   # admin pause / recovery model (#76)
└── scripts/
    └── measure_costs.sh    # runs the lifecycle test under cost reporting
```

## Quick start

```bash
# from contracts/
cargo build --target wasm32-unknown-unknown --release
cargo test                                                  # runs the lifecycle harness
./scripts/measure_costs.sh                                  # prints per-op CPU + storage costs
```

`cargo test` exercises the same lifecycle that frontend and backend
consumers will rely on (`create`, `join`, `drip`, `claim`, `withdraw`)
through the generated `DripPoolClient` bindings, satisfying the
client-compatibility part of #26.

## CI

The integration harness is intended to run on every PR via:

```yaml
- run: rustup target add wasm32-unknown-unknown
- run: cargo build --target wasm32-unknown-unknown --release
- run: cargo test
- run: ./scripts/measure_costs.sh
```

Wire that block into the existing GitHub Actions workflow in a follow-up
PR; this scaffold deliberately leaves the workflow change out so the
contract diff stays reviewable in isolation.

## Relationship to the rest of the system

- The backend's `POST /internal/reconcile` endpoint expects events with
  the shape documented in [`docs/EVENT_SCHEMA.md`](./docs/EVENT_SCHEMA.md).
  As real events are added in the
  contract, mirror them in `backend/src/services/reconciler.ts` and
  validate the round-trip with the harness here.
- Admin pause and incident recovery behavior is documented in
  [`docs/PAUSE_RECOVERY.md`](./docs/PAUSE_RECOVERY.md).
- Conservative proportional-allocation arithmetic and rounding reports are
  documented in [`docs/ROUNDING_POLICY.md`](./docs/ROUNDING_POLICY.md).
- The frontend imports the generated TypeScript bindings — keep the
  public method names + types stable across releases.
