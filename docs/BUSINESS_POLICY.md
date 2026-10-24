# Business Policy Engine

VaultQuest's shared `lib/business-policy.ts` module evaluates typed deposit, withdrawal, claim, yield, draw, quest-reward, and lockup-weight rules. `lib/conformance-spec.ts`, the savings service, local wallet mocks, and the wallet transaction state machine use the same default evaluator so their decisions do not drift.

## Defaults and Boundaries

- Deposit and reward amounts must be finite and strictly greater than zero.
- A configured maximum deposit or withdrawal is inclusive: the exact limit is allowed; any larger amount is denied.
- Prize amount must be strictly greater than `minimumPrize`; eligible participant count must be greater than or equal to `minimumEligibleParticipants` when supplied.
- Withdrawal is allowed at the exact `lockedUntilLedger`; it is denied before that ledger.
- A claim at its exact deadline is still valid. No claimable balance is a `noop`, not an error.
- Default lockup reward weights remain 100 bps for 0 days, 110 bps through 7 days, 125 bps through 14 days, and 150 bps above 14 days. These multipliers never change principal.

## Configure a Consumer

Overrides are passed as typed configuration; the engine validates limits and tier ordering at construction and freezes the effective policy.

```ts
const policy = new BusinessPolicyEngine({
  maximumDeposit: 5_000,
  maximumWithdrawal: 2_500,
  minimumPrize: 10,
  minimumEligibleParticipants: 3,
  maximumQuestReward: 500,
});

const savings = createSavingsService({
  maximumDeposit: 5_000,
  maximumWithdrawal: 2_500,
});
```

Pass `businessPolicy` in `TxFlowOptions` to check a wallet action before opening the signing prompt. Supply `policyContext` when the vault view has current lockup ledger or claim eligibility data. Local contract mocks accept the same engine through `MockVaultConfig.businessPolicy`.

Denials have a stable `code`, `rule`, and actionable `userMessage`; `BusinessPolicyError` carries those fields when used by a service. The existing contract conformance API keeps its canonical error names for default contract behavior.

## Authority and Deployment

Policy overrides are application configuration injected into a consumer; no database migration is needed. Preflight policies improve UX and enforce protocol-level business restrictions in application flows, but they do not replace Soroban contract checks. On-chain validation remains authoritative, especially for balances, lockups, draw results, and payouts. Do not loosen a client policy to bypass a contract restriction.