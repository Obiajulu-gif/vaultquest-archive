# Environment Variable Inventory

Reference for configuration used by the VaultQuest frontend.

## Classification

| Class | Prefix / location | Exposed to browser? | Committed? |
|-------|-------------------|---------------------|------------|
| Public frontend config | `NEXT_PUBLIC_*` in `.env.local` | Yes — inlined into the browser bundle at build time | No — `.env.local` is git-ignored |

Anything without the `NEXT_PUBLIC_` prefix is server-only and must never be
referenced in frontend code. If it has `NEXT_PUBLIC_`, assume anyone who loads
the site can read it.

## Frontend variables

Copy `.env.example` to `.env.local` before running `npm run dev`.

| Variable | Required | Description |
|----------|----------|-------------|
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | Yes | WalletConnect / RainbowKit project ID. Get one free at [cloud.walletconnect.com](https://cloud.walletconnect.com). |
| `NEXT_PUBLIC_SOROBAN_NETWORK_PASSPHRASE` | Yes | Stellar network passphrase used by the wallet module. |
| `NEXT_PUBLIC_HORIZON_URL` | Yes | Horizon RPC endpoint used for account lookups and network state. |
| `NEXT_PUBLIC_SOROBAN_RPC_URL` | Yes | Soroban RPC endpoint used for contract reads and transactions. |
| `NEXT_PUBLIC_DRIP_POOL_CONTRACT_ID` | Yes | Deployed Soroban contract ID for the drip pool. |
| `NEXT_PUBLIC_TRUSTLESS_WORK_ESCROW_CONTRACT_ID` | No | Optional Trustless Work escrow contract address. |
| `TRUSTLESS_WORK_API_BASE_URL` | No | Optional server-side Trustless Work API URL. |
| `TRUSTLESS_WORK_API_KEY` | No | Optional server-side Trustless Work API key. Keep this secret out of browser bundles.

Validation lives in `stellar-wallet-connect/src/core/env.ts`. The wallet module now fails at startup with a clear error message if required values are missing, invalid, or still set to placeholders such as `YOUR_PROJECT_ID` or `CA_PLACEHOLDER_DRIP_POOL_CONTRACT_ID`.

## Backend variables

The backend uses `backend/.env.example` as its canonical example. These values are consumed by `backend/src/env.ts`.

| Variable | Purpose | Required? |
|---|---|---|
| `DATABASE_URL` | Postgres connection string | Yes |
| `INTERNAL_SERVICE_SECRET` | Shared secret between event indexer (#13) and `/internal/reconcile` | Yes |
| `ORPHAN_TTL_MINUTES` | Minutes after which `submitted` rows with no event are orphaned | Default 10 |
| `LOG_LEVEL` | Pino log level | Default `info` |
| `PORT` | HTTP port | Default 3001 |

`INTERNAL_SERVICE_SECRET` is now validated to reject placeholder text and must be a custom, strong secret at runtime.

## Indexer integration

The backend and any external indexer share the same authentication boundary:

- `INTERNAL_SERVICE_SECRET` — used to authenticate calls to `POST /internal/reconcile`.
- `DATABASE_URL` is backend-only; the indexer should never have direct database access.

If you are building a separate indexer service, keep its environment aligned with the backend secret and endpoint configuration.

## Per-environment setup

| Environment | Frontend | Backend | Indexer |
|-------------|----------|---------|---------|
| Local dev | Copy `.env.example` → `.env.local` and fill in the required `NEXT_PUBLIC_*` values. | Copy `backend/.env.example` → `backend/.env` and set a local Postgres URL + strong `INTERNAL_SERVICE_SECRET`. | Reuse `INTERNAL_SERVICE_SECRET` from backend for local reconciliation. |
| Preview / staging | Set real `NEXT_PUBLIC_*` values in the preview host. Use separate WalletConnect and contract IDs from production if needed. | Use staging database and a staging `INTERNAL_SERVICE_SECRET`. | Use the same staging `INTERNAL_SERVICE_SECRET` and backend URL. |
| Production | Set production `NEXT_PUBLIC_*` values, live contract IDs, and production Horizon/Soroban endpoints. | Use production database, secure secret, and TLS. | Use production secret and secure backend endpoint. |

## CI placeholder guard

`.github/workflows/config-guard.yml` fails any pull request that commits the
literal string `YOUR_PROJECT_ID` in a JS/TS source file. This prevents the old
placeholder from silently sneaking back into the codebase.

| Environment | Setup |
|-------------|-------|
| Local dev | Copy `.env.example` → `.env.local`, fill in your WalletConnect project ID. |
| CI builds | `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` is provided by `.github/workflows/frontend.yml` from a repo secret (falls back to a non-placeholder string so the build passes). |
| Preview / production | Set `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` as a secret in the hosting provider (Vercel, etc.). Use a separate WalletConnect project per environment if you want isolated analytics. |

## CI placeholder guard

`.github/workflows/config-guard.yml` fails any pull request that commits the
literal string `YOUR_PROJECT_ID` in a JS/TS source file. This prevents the old
placeholder from silently sneaking back into the codebase.

## Backend (issue #34 — action ledger)

These are consumed by `backend/src/env.ts`.

| Variable | Purpose | Required? |
|---|---|---|
| `DATABASE_URL` | Postgres connection string | Yes |
| `INTERNAL_SERVICE_SECRET` | Shared secret between event indexer (#13) and `/internal/reconcile` | Yes |
| `ORPHAN_TTL_MINUTES` | Minutes after which `submitted` rows with no event are orphaned | Default 10 |
| `LOG_LEVEL` | Pino log level | Default `info` |
| `PORT` | HTTP port | Default 3001 |
| `WEBHOOK_SECRET` | Secret for internal/custom HMAC-SHA256 signature verification (#799) | Optional (defaults to `INTERNAL_SERVICE_SECRET`) |
| `STRIPE_WEBHOOK_SECRET` | Secret for Stripe webhook signature verification (`whsec_...`) | Optional (required if using Stripe webhooks) |
| `STELLAR_WEBHOOK_PUBLIC_KEY` | Stellar Ed25519 public key (`G...`) for verifying oracle callbacks | Optional (required if using Stellar oracle webhooks) |
| `WEBHOOK_TOLERANCE_SECONDS` | Maximum allowed timestamp drift in seconds for replay-window enforcement | Default 300 |



## Secure configuration preflight (#805)

The backend validates configuration before opening its HTTP listener or starting
workers. Run `pnpm --dir backend config:validate` after provisioning `backend/.env`
(or run `pnpm --dir backend exec tsx src/scripts/validateEnv.ts` with environment
variables injected by your deployment platform). Run this preflight before database
migrations and deployment. It exits nonzero with variable names and remediation
messages, never configuration values. `SKIP_ENV_VALIDATION=1` is now refused.

| Mode | Requirements |
| --- | --- |
| Local | `APP_ENV=local`, `NODE_ENV=development` or `test`; PostgreSQL and Redis hosts must be loopback, resource names must not contain prod/production/live; use independently generated local secrets and a non-mainnet network. |
| Staging | `APP_ENV=staging`, `NODE_ENV=production`; dedicated staging databases and secrets; PostgreSQL `sslmode=require`, `verify-ca`, or `verify-full`; Redis `rediss:`; credential-free HTTPS RPC; non-mainnet passphrase. |
| Production | `APP_ENV=production`, `NODE_ENV=production`; production-only databases and secrets with the same transport requirements; set the intended Stellar network explicitly. |

When `APP_ENV` is absent, `NODE_ENV=production` implies production and other values
imply local. Staging must set `APP_ENV` explicitly. Shared environments require
`API_KEY` (32+ characters), `INTERNAL_SERVICE_SECRET` (32+ characters), a valid
checksum-verified `RECEIPT_SIGNING_SECRET`, and `NETWORK_PASSPHRASE`. Local internal
and webhook secrets require 20+ characters. All configured secrets reject
placeholders, whitespace padding, and repeated-character values. Generate independent
secrets using a cryptographic generator, for example
`node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`.
Keep them in the deployment secret manager, never in source control or `NEXT_PUBLIC_*`.

Local mode rejects known production prefixes (`prod_`, `production-`, `sk_live_`,
`whsec_live_`). Opaque random secrets cannot reveal which deployment owns them:
operators must maintain separate secret-manager entries for each environment.
The validator does not infer deployment ownership from an arbitrary secret.

Indexer configuration requires RPC URL, contract IDs, and network passphrase
together. Supported passphrases are Stellar public, testnet, futurenet, and
standalone. Contract IDs and signing keys are checksum validated. SendGrid requires
its key and sender together. Feature switches accept only literal `true` or `false`,
ports must be 1–65535, and schedules must be valid cron expressions. Sandbox mode
is local-only and requires a loopback sandbox database.

Migration: remove validation bypasses, replace weak/placeholder secrets, explicitly
set staging mode, enable transport security, and provision a stable receipt signing
key before upgrading shared deployments. Existing receipts signed with ephemeral
keys still require their original public key for verification.

The frontend validator uses the same `APP_ENV` modes and refuses mainnet outside
production, URL credentials, non-HTTP protocols, malformed contract IDs, and
secret-bearing `NEXT_PUBLIC_*` variables. Shared frontend endpoints require HTTPS.
Frontend contract IDs receive structural validation; the backend SDK checks the
checksum for indexer contract IDs. Set `APP_ENV=staging` during staging builds as
well as at runtime; public frontend configuration is bundled at build time.

For frontend build preflight, inject the build variables and run
`pnpm --dir backend exec tsx ../scripts/validate-frontend-env.ts` from the repository
root. To load the root `.env.local` instead, run
`pnpm --dir backend exec node --env-file=../.env.local --import tsx ../scripts/validate-frontend-env.ts`.
Both preflight commands finish without contacting databases or network services.
