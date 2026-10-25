# User Consent Ledger & Flow Gating

## Overview
VaultQuest requires versioned, auditable records of user consent for terms of service, privacy policies, and data processing agreements. The `UserConsentLedger` (`lib/user-consent-ledger.ts`) provides an append-only ledger tracking consent status against immutable policy versions.

## Key Capabilities
- **Immutable Policy Versioning**: Consent is explicitly pinned to a policy identifier and semantic version (e.g., `terms_of_service@1.0.0`).
- **Full Traceability**: Every consent event records actor, timestamp (ISO-8601), source (e.g., `web_wallet_connect`, `deposit_flow`, `settings_modal`), and optional metadata.
- **Renewed Consent Enforcement**: When a policy version is bumped, previous version consents are no longer valid, requiring user renewal before accessing gated actions.
- **Revocation Support**: Users can revoke consent (e.g., GDPR data processing opt-out), which immediately marks the policy consent invalid and triggers flow gating.
- **Gating for Critical Flows**: The `gateFlow(userId, requiredPolicies?)` method evaluates user eligibility before permitting sensitive protocol actions (vault deposits, prize claims, dashboard operations).
- **Authorized Audit & History Access**:
  - Regular users can only query their own consent history.
  - Maintainers and auditors can inspect any user's history and export the full consent audit ledger for regulatory reporting and dispute resolution.

## Usage Example

```typescript
import { defaultConsentLedger, UserConsentLedger } from '@/lib/user-consent-ledger';

// Recording consent during onboarding/wallet connect
defaultConsentLedger.recordConsent({
  userId: 'GA7QY4B5Y7BVV76...',
  policyType: 'terms_of_service',
  policyVersion: '1.0.0',
  status: 'granted',
  actor: 'GA7QY4B5Y7BVV76...',
  source: 'web_wallet_connect',
});

// Checking whether a user is gated from entering prize vaults
const gateResult = defaultConsentLedger.gateFlow('GA7QY4B5Y7BVV76...');
if (!gateResult.allowed) {
  // Prompt user to review and sign updated policies: gateResult.missingPolicies
  throw new Error('Action blocked: Missing required policy consent');
}

// Inspecting history (authorized)
const history = defaultConsentLedger.getConsentHistory(
  { userId: 'GA7QY4B5Y7BVV76...' },
  { actorId: 'GA7QY4B5Y7BVV76...', role: 'user' }
);
```

## Running Tests
Run the test suite with:
```bash
pnpm test tests/user-consent-ledger.test.ts
```
