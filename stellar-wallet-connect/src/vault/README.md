# Vault pool UI module

Pool-level UI for VaultQuest plus a testable contract seam.

| Piece | Issue | What it is |
|---|---|---|
| `components/PoolDetail.tsx` | #73 / #90 | Pool overview, user position, save toggle, and state-aware actions |
| `components/OnboardingChecklist.tsx` | #79 | First-time wallet checklist with dismiss/revisit state |
| `components/RewardHistory.tsx` | #75 | Completed-cycle reward history (table/cards) |
| `components/SavedPoolsWatchlist.tsx` | #89 / #90 | Saved-pools dashboard section (table/cards) |
| `contract/` | #67 | `VaultContractClient` interface + in-memory mock |
| `hooks.ts` | #73 / #75 / #89 / #90 | `usePoolDetail`, `useRewardHistory`, `useSavedPools` data adapters |
| `lib/format.ts` | #73 / #75 | Address truncation, amount/date formatting, explorer links |

All states (loading, empty, stale, error, wallet-disconnected) reuse the shared
`components/FallbackStates` from #61, and wallet references render truncated.

`PoolDetail` shows the first-time wallet onboarding checklist by default. Users
can dismiss it or reopen it from the compact checklist button; the preference is
stored in `localStorage` under `vaultquest.onboarding.dismissed`.

## Shared data-access and query state (#22)

Frontend surfaces should call the hooks in `hooks.ts` rather than embedding
`fetch`, Soroban client calls, cache timers, or polling logic inside pages.
The shared layer standardizes these boundaries:

| Boundary | Hook/client | Source strategy | Cache key |
|---|---|---|---|
| Pool discovery | `usePoolDiscovery` | Backend `/pools`, with optional `VaultContractClient.listPools()` fallback | `vaultQueryKeys.pools()` |
| Pool detail | `usePoolDetail` | Contract adapter (`getPool`, `getUserPosition`) | `vaultQueryKeys.poolDetail(poolId, wallet)` |
| Account dashboard | `useAccountView` | Backend saved pools + contract rewards/positions | `vaultQueryKeys.account(wallet)` |
| Prize views | `usePrizeViews` | Backend `/prizes`, with reward-history fallback | `vaultQueryKeys.prizes(wallet)` |
| Saved pools | `useSavedPools` | Backend `/saved-pools` via `VaultApiClient` | `vaultQueryKeys.savedPools(wallet)` |
| Transaction status | `useTransactionStatus` | Backend `/actions/:id`, polling until terminal | `vaultQueryKeys.transaction(actionId)` |
| Wallet actions | `usePoolAction` | Contract write adapter + shared invalidation | `vaultQueryKeys.actionFlow(type, poolId, wallet)` |

All hooks return the same loading semantics: `loading` means no usable data is
available yet, `stale` means cached data is being refreshed or is expired, and
`partialError` means a background refetch failed while previous data remains
safe to render. Fatal `error` is reserved for cases with no usable cached data.

Mutations and terminal transaction statuses invalidate the pool-detail, account,
reward, saved-pool, and discovery keys that downstream UI surfaces depend on.
This keeps create, join, drip, claim, and withdraw flows aligned without each
component re-implementing cache behavior.

### Local data configuration

`data/config.ts` centralizes frontend data-layer configuration from environment
variables. Defaults favor backend reads with intentional contract fallbacks.

| Variable | Purpose | Default |
|---|---|---|
| `NEXT_PUBLIC_VAULTQUEST_API_BASE_URL` / `PUBLIC_VAULTQUEST_API_BASE_URL` | Backend API base URL for reads and transaction polling | `/api` |
| `NEXT_PUBLIC_DRIP_POOL_CONTRACT_ID` | Soroban drip-pool contract ID | empty string |
| `NEXT_PUBLIC_TRUSTLESS_WORK_ESCROW_CONTRACT_ID` | Optional escrow contract ID | unset |
| `NEXT_PUBLIC_SOROBAN_NETWORK_PASSPHRASE` / `PUBLIC_SOROBAN_NETWORK_PASSPHRASE` | Network passphrase used to infer testnet/mainnet/futurenet/custom | empty string |
| `NEXT_PUBLIC_HORIZON_URL` / `PUBLIC_HORIZON_URL` | Horizon URL metadata | empty string |
| `NEXT_PUBLIC_SOROBAN_RPC_URL` | Soroban RPC URL metadata | empty string |
| `NEXT_PUBLIC_VAULTQUEST_BACKEND_READS` | Enable backend-driven reads | `true` |
| `NEXT_PUBLIC_VAULTQUEST_CONTRACT_FALLBACK_READS` | Allow direct contract fallback reads | `true` |
| `NEXT_PUBLIC_VAULTQUEST_TRANSACTION_POLLING` | Poll non-terminal action statuses | `true` |

## Contract-interface mock strategy (#67)

UI code depends only on the `VaultContractClient` interface — never on a live
Stellar connection. Tests inject `createMockVaultClient(config)`, which lets
wallet-driven flows (create / join / drip / claim / withdraw) and their reads
run with no network.

```ts
import { createMockVaultClient } from "./contract/mockClient";

// Happy path
const client = createMockVaultClient({
  connected: true,
  pools: { "pool-1": myPool },
  positions: { "pool-1": myPosition },
  rewardHistory: [myRewardRow],
});

// Failure injection — one case per error the UI must recover from
createMockVaultClient({ connected: false });                       // wallet_disconnected
createMockVaultClient({ failActions: { join: "signature_rejected" } });
createMockVaultClient({ failActions: { withdraw: "rpc_failure" } });
createMockVaultClient({ failActions: { claim: "contract_error" } });
createMockVaultClient({ failReads: "stale_data" });                // reads throw stale
```

Every failure surfaces as a `ContractInterfaceError` whose `kind` is one of:
`wallet_disconnected`, `signature_rejected`, `rpc_failure`, `contract_error`,
`stale_data`. Components map these to the matching fallback UI.

### Adding a new mock case

1. If you need a new read/write, add it to `VaultContractClient` in
   `contract/types.ts` so the real and mock clients stay aligned.
2. Implement it in `contract/mockClient.ts`, honouring `failReads` /
   `failActions` so error states stay injectable.
3. Add a test in `contract/mockClient.test.ts` covering success **and** at
   least one failure kind.

## Running the tests

From `stellar-wallet-connect/`:

```bash
npm install
npm test          # vitest run (jsdom)
npm run typecheck  # tsc --noEmit
```

No Stellar wallet, RPC, or network is required.
