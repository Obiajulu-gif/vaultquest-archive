# Integration Sandbox

The sandbox exercises the real backend settlement state machine and frontend wallet-client seam without contacting Stellar, using a real signer, or writing to a production database.

## Isolation

`SANDBOX_MODE=true` is fail-closed. It requires `SANDBOX_DATABASE_URL` to use PostgreSQL on `localhost`, `127.0.0.1`, or `::1`, with a database name containing `sandbox`; it refuses `NODE_ENV=production`. The normal `DATABASE_URL` is ignored for sandbox server connections. Startup disables Redis, the live Soroban indexer, scheduled jobs, database backups, and replay-equivalence. If background jobs are explicitly enabled, they use the in-memory job store. The sandbox settlement command independently validates the same local-database restrictions.

## Local Setup

From the repository root:

```bash
docker compose -f backend/docker-compose.sandbox.yml up -d
cp backend/.env.sandbox.example backend/.env
pnpm --dir backend prisma:deploy
pnpm --dir backend sandbox
```

PowerShell equivalent for copying the template:

```powershell
Copy-Item backend/.env.sandbox.example backend/.env
```

To run the HTTP backend in sandbox mode, use `pnpm --dir backend sandbox:server`. The sandbox env template uses local fixture credentials only. `DATABASE_URL` and `SANDBOX_DATABASE_URL` both point at the isolated Compose database so Prisma migrations and runtime use the same schema.

## Scenarios

Set `SANDBOX_SCENARIO` in the ignored local `backend/.env` and run `pnpm --dir backend sandbox`:

| Scenario | Simulated behavior | Expected settlement |
|---|---|---|
| `success` | Submit and finalized payout facts match | `Resolved` |
| `retry_once` | First submit returns `tx_bad_seq`; next succeeds | `Resolved` |
| `timeout_once` | First submit times out; next succeeds | `Resolved` |
| `submit_failure` | Submit returns permanent `tx_bad_auth` | `Unresolved` |
| `verification_pending` | Submit succeeds without finalized payout evidence | `PendingVerification` |
| `verification_mismatch` | Finalized recipient/amount do not match | `PendingVerification` |

Each report includes deterministic adapter call traces. Scenario vault IDs are isolated by name, and repeated successful settlement calls use the normal idempotency path.

Frontend contributors can use `createSandboxVaultClient()` from the wallet-connect vault package. It uses a fixed simulated address, sample pool, deterministic transaction IDs, and selectable disconnected/signature/RPC/contract/stale-read failures; it never opens a wallet provider or sends a transaction.

## Limitations

The sandbox verifies application behavior and state transitions only. Fake XDR strings, transaction hashes, signer responses, and payout facts are not valid Stellar transactions or proofs. It does not test network consensus, real wallet prompts, contract execution, or production payout safety. The sandbox database contains disposable local records; reset it with `docker compose -f backend/docker-compose.sandbox.yml down --volumes`.