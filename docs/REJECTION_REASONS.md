# VaultQuest Rejection Reason Codes

This document describes the user-facing explanation objects for rejected operations in VaultQuest. The system provides consistent reason codes and recovery hints instead of generic failures.

## Overview

When a vault operation (deposit, withdraw, claim, draw_winner, etc.) is rejected, the system returns a structured explanation object containing:

- **Stable reason code**: For API contracts and logging
- **User-safe message**: What went wrong (shown to users)
- **Recovery hint**: Actionable next step for the user
- **Retryable flag**: Whether retrying without changes may succeed
- **Category**: High-level grouping (validation, permission, policy, stale_state, external)

## Rejection Categories

### Validation
Input/parameter validation failures that require user correction before retrying.

- `VAULT_INVALID_AMOUNT` - Amount must be positive
- `VAULT_INVALID_POOL_ID` - Pool identifier is not valid
- `VAULT_INVALID_WALLET_ADDRESS` - Wallet address is not valid
- `VAULT_INVALID_ASSET` - Asset type not supported by this pool
- `VAULT_INVALID_TIMESTAMP` - Timestamp is not valid

### Permission
Authorization and permission failures requiring authentication or role changes.

- `VAULT_UNAUTHORIZED_OPERATION` - User not authorized
- `VAULT_FORBIDDEN_OPERATION` - User lacks required permissions
- `VAULT_WALLET_NOT_CONNECTED` - Wallet not connected
- `VAULT_SIGNATURE_REQUIRED` - Signature required to complete operation

### Policy
Protocol-level policy violations (caps, deadlines, lockups) that are enforced by the contract.

- `VAULT_POOL_CLOSED` - Pool is closed, no longer accepts deposits
- `VAULT_POOL_LOCKED` - Pool locked for current prize draw cycle
- `VAULT_POOL_CANCELLED` - Pool has been cancelled
- `VAULT_POOL_EMERGENCY` - Pool in emergency mode (deposits paused)
- `VAULT_DEPOSIT_CAP_EXCEEDED` - Deposit exceeds personal cap
- `VAULT_POOL_CAP_EXCEEDED` - Pool reached total deposit capacity
- `VAULT_LOCKUP_ACTIVE` - Funds still in lockup period
- `VAULT_CLAIM_DEADLINE_PASSED` - Claim deadline has passed
- `VAULT_INSUFFICIENT_LIQUIDITY` - Pool lacks available liquidity (withdrawal queued)
- `VAULT_INSUFFICIENT_BALANCE` - Insufficient balance for operation
- `VAULT_ALREADY_CLAIMED` - Prize already claimed
- `VAULT_NOT_PARTICIPANT` - User not a participant in this pool
- `VAULT_INSUFFICIENT_YIELD_RESERVE` - Pool lacks yield reserve for operation
- `VAULT_INVALID_ACTION_STATE` - Action not allowed in current pool state

### Stale State
State consistency issues (concurrent modifications, stale data) that can be resolved by refreshing.

- `VAULT_STALE_POOL_DATA` - Pool data is out of date
- `VAULT_STALE_POSITION_DATA` - Position data is out of date
- `VAULT_CONCURRENT_MODIFICATION` - Item modified by another operation
- `VAULT_VERSION_MISMATCH` - Version mismatch between client and pool

### External
External dependency failures (network, RPC, wallet) that may be transient.

- `VAULT_WALLET_REJECTED` - Wallet rejected the transaction
- `VAULT_WALLET_TIMEOUT` - Wallet did not respond in time
- `VAULT_NETWORK_ERROR` - Could not reach Stellar network
- `VAULT_RPC_FAILURE` - Stellar RPC service returned an error
- `VAULT_CONTRACT_REVERTED` - Transaction reverted on-chain
- `VAULT_TRANSACTION_TIMEOUT` - Transaction timed out waiting for confirmation
- `VAULT_INDEXER_UNAVAILABLE` - Pool indexer service temporarily unavailable

## Implementation

### Frontend Integration

The rejection reasons are integrated into the transaction state machine:

```typescript
import { mapWalletErrorToRejection, getRejectionExplanation } from "../lib/rejectionReasons";

// In txStateMachine.ts
export function mapTxError(
  err: unknown,
  fallbackStage: ActiveTxStage,
): { failedAt: ActiveTxStage; message: string; rejectionExplanation?: { reasonCode: string; userMessage: string; recoveryHint: string } } {
  const kind = (err as { kind?: string }).kind ?? "";
  const rejectionReason = mapWalletErrorToRejection(kind);
  const rejectionExplanation = rejectionReason ? getRejectionExplanation(rejectionReason) : undefined;
  // ... rest of mapping logic
}
```

The transaction state now includes `rejectionExplanation` in the failed state:

```typescript
export type TxFlowState =
  | { stage: "idle" }
  | { stage: "preparing" }
  // ... other states
  | { stage: "failed"; failedAt: ActiveTxStage; message: string; rejectionExplanation?: { reasonCode: string; userMessage: string; recoveryHint: string } };
```

### Backend Integration

VaultQuest rejection reasons are added to the backend error codes and taxonomy:

```typescript
// In backend/src/constants.ts
export const ERROR_CODES = {
  // ... existing codes
  VAULT_INVALID_AMOUNT: "VAULT_INVALID_AMOUNT",
  VAULT_LOCKUP_ACTIVE: "VAULT_LOCKUP_ACTIVE",
  // ... all VaultQuest rejection reasons
} as const;
```

```typescript
// In backend/src/errorTaxonomy.ts
export const ERROR_CATALOG: Record<ErrorCode, ErrorDescriptor> = {
  // ... existing entries
  [ERROR_CODES.VAULT_INVALID_AMOUNT]: {
    category: "validation",
    retryable: false,
    userMessage: "The amount provided is not valid.",
    recovery: "Enter a positive amount greater than zero and try again.",
    exposeMessage: true
  },
  // ... all VaultQuest entries
};
```

### Service Layer Integration

Contract behavior errors are mapped to rejection reasons in the service layer:

```typescript
import { mapContractErrorToRejection, getRejectionExplanation } from "../lib/rejectionReasons";

// In services/savingsService.ts
validateDeposit(amount: number): void {
  const err = validateDepositAmount(amount);
  if (err) {
    const rejectionReason = mapContractErrorToRejection(err);
    const explanation = rejectionReason ? getRejectionExplanation(rejectionReason) : null;
    const error = new Error(explanation?.userMessage || err);
    (error as any).rejectionExplanation = explanation;
    throw error;
  }
}
```

## API Response Format

When an operation is rejected, the API response includes the rejection explanation:

```json
{
  "error": {
    "code": "VAULT_LOCKUP_ACTIVE",
    "category": "validation",
    "message": "Your funds are still in the lockup period.",
    "retryable": false,
    "recovery": "Wait until the lockup period ends before withdrawing. Check your position for the exact unlock time.",
    "error_id": "abc123-def456",
    "status_code": 400
  }
}
```

## Adding New Rejection Reasons

When adding a new rejection reason:

1. **Add the reason code** to `lib/rejectionReasons.ts`:
   ```typescript
   export const VAULT_REJECTION_REASONS = {
     // ... existing codes
     VAULT_NEW_REASON: "VAULT_NEW_REASON",
   } as const;
   ```

2. **Add the explanation** to `REJECTION_EXPLANATIONS`:
   ```typescript
   export const REJECTION_EXPLANATIONS: Record<VaultRejectionReason, RejectionExplanation> = {
     // ... existing entries
     [VAULT_REJECTION_REASONS.VAULT_NEW_REASON]: {
       reasonCode: VAULT_REJECTION_REASONS.VAULT_NEW_REASON,
       category: "validation", // or appropriate category
       userMessage: "User-safe message explaining what went wrong.",
       recoveryHint: "Actionable next step for the user.",
       retryable: false, // or true if retryable
       technicalContext: "Optional technical context for debugging.",
     },
   };
   ```

3. **Add to backend constants** in `backend/src/constants.ts`:
   ```typescript
   export const ERROR_CODES = {
     // ... existing codes
     VAULT_NEW_REASON: "VAULT_NEW_REASON",
   } as const;
   ```

4. **Add to backend error taxonomy** in `backend/src/errorTaxonomy.ts`:
   ```typescript
   export const ERROR_CATALOG: Record<ErrorCode, ErrorDescriptor> = {
     // ... existing entries
     [ERROR_CODES.VAULT_NEW_REASON]: {
       category: "validation",
       retryable: false,
       userMessage: "User-safe message.",
       recovery: "Recovery hint.",
       exposeMessage: true,
     },
   };
   ```

5. **Add mapping function** if needed (for contract or wallet errors):
   ```typescript
   export function mapContractErrorToRejection(contractError: string): VaultRejectionReason | null {
     const errorMap: Record<string, VaultRejectionReason> = {
       // ... existing mappings
       NewContractError: VAULT_REJECTION_REASONS.VAULT_NEW_REASON,
     };
     return errorMap[contractError] || null;
   }
   ```

6. **Add tests** to `lib/rejectionReasons.test.ts` and `backend/tests/rejectionReasons.spec.ts`.

## Testing

Run the rejection reasons tests:

```bash
# Frontend/library tests
pnpm test lib/rejectionReasons.test.ts

# Backend tests
pnpm test backend/tests/rejectionReasons.spec.ts
```

## Design Decisions

### Stable Reason Codes
Reason codes are stable and should not change without a migration plan. They are part of the public API contract. Use descriptive, hierarchical naming (e.g., `VAULT_LOCKUP_ACTIVE` rather than `LOCKUP`).

### User-Safe Messages
Messages are written for end users, avoiding technical jargon, stack traces, or internal implementation details. Recovery hints are actionable and specific to the rejection reason.

### Category-Based Retryable Flags
While retryable flags are set per-reason, they follow category conventions:
- `validation`: Generally not retryable (requires user correction)
- `permission`: Not retryable (requires authentication/authorization)
- `policy`: Generally not retryable (contract-enforced invariants)
- `stale_state`: Retryable (can be resolved by refreshing)
- `external`: Generally retryable (transient failures)

### Mapping Layers
Multiple mapping layers exist to bridge between different error sources:
- Contract behavior errors → Vault rejection reasons
- Wallet/transaction errors → Vault rejection reasons
- Backend error codes → Error taxonomy

This allows each layer to maintain its own error semantics while providing a unified user-facing explanation.

## Migration Notes

### Existing Error Codes
The existing backend error codes (`WALLET_REJECTED`, `NETWORK_ERROR`, etc.) remain unchanged. VaultQuest-specific codes are prefixed with `VAULT_` to avoid conflicts.

### Breaking Changes
Adding new rejection reasons is not a breaking change. The system provides fallback behavior for unknown reason codes, so clients that don't recognize a new code will still receive a generic error message.

### Deprecation
If a rejection reason needs to be deprecated:
1. Keep the code in the constants and catalog for backward compatibility
2. Mark it as deprecated in documentation
3. Add a mapping from the old code to the new code
4. Update clients to use the new code
5. Remove the old code in a future major version
