# Cross-Environment Configuration Contracts

This document specifies the configuration contracts enforced across VaultQuest environments (`local`, `staging`, and `production`) (#922).

---

## 1. Environment Profiles & Requirements Matrix

| Setting / Variable | Local Dev | Staging | Production | Contract Rule & Severity |
| :--- | :--- | :--- | :--- | :--- |
| `APP_ENV` | `local` | `staging` | `production` | **Critical**: Must match deployed environment tier. |
| `NODE_ENV` | `development` or `test` | `production` | `production` | **Critical**: Non-production runtime rejected in staging/prod. |
| `DATABASE_URL` | Loopback (`localhost` / `127.0.0.1`) | Managed PostgreSQL with TLS | Managed PostgreSQL with TLS | **Critical**: Requires `sslmode=require` or `verify-full` in shared tiers. |
| `INTERNAL_SERVICE_SECRET` | Local unique secret ($\ge 20$ chars) | Isolated secret ($\ge 32$ chars) | Production secret ($\ge 32$ chars, high entropy) | **Critical**: No placeholders (`PLACEHOLDER`, `CHANGE-ME`); never prefixed with `NEXT_PUBLIC_`. |
| `RECEIPT_SIGNING_SECRET` | Ephemeral or dev seed | Fixed Stellar secret seed (`S...`) | Fixed Stellar secret seed (`S...`) | **Critical**: Must be valid Ed25519 seed to maintain stable receipt verification. |
| `API_KEY` | Optional | Required ($\ge 32$ chars) | Required ($\ge 32$ chars) | **Critical**: External API protection in shared deployments. |
| `NETWORK_PASSPHRASE` | Testnet or Standalone | `"Test SDF Network ; September 2015"` | `"Public Global Stellar Network ; September 2015"` | **Critical**: Mainnet strictly forbidden in non-production; testnet forbidden in production. |
| `SOROBAN_RPC_URL` | Optional / Loopback | HTTPS (`https://rpc.testnet.stellar.org`) | HTTPS (Dedicated Production RPC) | **Critical**: HTTPS required; no embedded credentials. |
| `INDEXER_CONTRACT_IDS` | Valid contract IDs | Valid Testnet contract IDs | Valid Mainnet contract IDs | **Critical**: Valid StrKey (`C...`) format; must match frontend contract IDs. |
| `REDIS_URL` | Optional (`redis://localhost:6379`) | Encrypted (`rediss://...`) | Encrypted (`rediss://...`) | **Critical**: Must enforce TLS (`rediss:`) in shared environments. |
| `governance.signerThreshold` | $\ge 1$ | $\ge 1$ | $\ge 2$ | **Critical**: Production contracts must require multi-sig threshold $\ge 2$. |

---

## 2. Automated Contract Verification

The configuration contract is enforced via `validateCrossEnvironmentContract` in `backend/src/config/crossEnvContract.ts` and exercised by:

```bash
cd backend
pnpm test tests/cross-environment-config-contract.spec.ts
```

The validator checks:
1. **Missing Variables**: Halts boot if any environment-critical variable is absent for the target profile.
2. **Contract ID Checksums**: Validates 56-character Base32 StrKey contracts with CRC16 verification.
3. **Transport Security (TLS)**: Rejects plain HTTP RPCs, unencrypted Redis, and non-SSL database connection strings.
4. **Secret Hygiene**: Scans for placeholder values (`PLACEHOLDER`, `CHANGE-ME`, `test`), short keys ($< 32$ characters), and low-entropy secrets.
5. **Cross-Stack Parity**: Verifies that frontend public contract IDs (`NEXT_PUBLIC_DRIP_POOL_CONTRACT_ID`) and network passphrases align 1:1 with backend configuration and deployment manifests.

---

## 3. Operational Edge Cases & Failure Modes

1. **Secret Rotation Disruption**:
   - *Failure Mode*: Rotating `RECEIPT_SIGNING_SECRET` invalidates receipts signed under the previous key.
   - *Recovery*: Configure `RECEIPT_PREVIOUS_PUBLIC_KEYS` with comma-separated retired public keys during the rotation window.
2. **SSL Mode Downgrades by Managed Database Providers**:
   - *Failure Mode*: Connecting to a pooled database proxy that strips `?sslmode=require` causes boot failure.
   - *Mitigation*: Ensure direct connection strings or transaction poolers preserve explicit TLS query parameters.
3. **Cross-Stack Contract Drift on New Deployments**:
   - *Failure Mode*: Smart contract is upgraded and deployed with a new contract ID, but the frontend or backend deployment still references the previous contract ID.
   - *Recovery*: The cross-stack contract test fails during CI/CD preflight (`scripts/check-config-drift.ts`), blocking inconsistent deployments before traffic routing.

---

## 4. Rollback & Recovery Procedures

If configuration drift or an invalid setting prevents service startup:
1. **Revert Environment Release**: Restore the previous validated configuration profile from release tags or secret store history.
2. **Diagnostic Validation**: Execute `pnpm run config:validate` locally to inspect the failure output without starting server listeners.
3. **Emergency Override Prohibition**: `SKIP_ENV_VALIDATION` bypass is disabled by design. All production deployments must satisfy the contract before traffic is served.
