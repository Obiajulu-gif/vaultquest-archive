# Intent Approval Flow (Issue #3)

## Overview

High-impact maintainer actions require explicit approval with cryptographic intent receipts. All approvals are audited and can be reviewed after completion or failure.

## Architecture

### IntentApprovalService

Manages the full lifecycle of high-impact action approvals:

```typescript
const service = new IntentApprovalService(prisma);
```

### High-Impact Action Types

- `emergency_halt`: Stop all operations on a pool
- `pool_parameter_change`: Modify critical pool parameters (caps, fees, lockup)
- `force_settlement`: Manually trigger settlement outside normal schedule
- `bulk_refund`: Issue refunds to multiple wallets
- `admin_override`: Override system safeguards (use sparingly)

### Intent Lifecycle

```
Created → Pending → Approved → Executed
              ↓
            Denied
              ↓
           Expired
```

## Usage Flow

### 1. Create Intent Proposal

Requester submits high-impact action for approval:

```typescript
const { intentId } = await service.createIntent({
  actionType: "emergency_halt",
  actionPayload: { poolId: "pool-123", reason: "suspected exploit" },
  requesterAddress: "GREQUESTER...",
  requesterPublicKey: "GREQUESTER...",
  reason: "Halting pool due to suspicious activity"
});
```

**Created**: Intent enters pending state, audit entry recorded.

### 2. Maintainer Reviews

Maintainer reviews intent details, checks justification:

```typescript
const intent = await prisma.intentProposal.findUnique({
  where: { id: intentId }
});

// Review actionPayload, reason, requester
```

### 3. Approve or Deny

#### Approval

Maintainer signs intent with their private key:

```typescript
const receipt = await service.approveIntent({
  intentId,
  approverAddress: maintainerKeypair.publicKey(),
  approverPublicKey: maintainerKeypair.publicKey(),
  approverPrivateKey: maintainerKeypair.secret(),
  approvalNotes: "Approved after security review"
});

// Receipt contains:
// - intentId
// - signature (cryptographic proof)
// - payloadHash (integrity check)
// - approverAddress
// - approvedAt
```

#### Denial

Maintainer denies with reason:

```typescript
await service.denyIntent({
  intentId,
  approverAddress: maintainerKeypair.publicKey(),
  denialReason: "Insufficient evidence of exploit"
});
```

### 4. Execute Approved Intent

System executes approved intent:

```typescript
const receipt = await getApprovedIntent(intentId);

// Verify signature
const isValid = service.verifyIntentSignature(
  receipt,
  receipt.approverAddress
);

if (!isValid) {
  throw new Error("Invalid approval signature");
}

// Execute action
await executeHighImpactAction(receipt.actionPayload);

// Mark as executed
await service.executeIntent(intentId, "system-executor");
```

## Security Model

### Cryptographic Signatures

Approvals are signed with Stellar keypair:

```typescript
const message = `${intentId}:${actionType}:${payloadHash}`;
const signature = keypair.sign(Buffer.from(message));
```

Signature binds:
- Intent ID (prevents replay to different intent)
- Action type (prevents substitution)
- Payload hash (prevents tampering)

### Payload Integrity

Payload hash is SHA-256 of canonical JSON:

```typescript
const canonical = JSON.stringify(payload, Object.keys(payload).sort());
const payloadHash = createHash("sha256").update(canonical).digest("hex");
```

Any modification to payload invalidates hash.

### Intent TTL

Intents expire after 24 hours:

```typescript
if (new Date() > intent.expiresAt) {
  throw new AppError(ERROR_CODES.VAULT_CLAIM_DEADLINE_PASSED);
}
```

Prevents stale approvals.

## Audit Trail

Every state transition is recorded:

```typescript
await service.getIntentAuditTrail(intentId);
// Returns:
// [
//   { action: "created", actor: "GREQUESTER...", createdAt: ... },
//   { action: "approved", actor: "GMAINTAINER...", createdAt: ... },
//   { action: "executed", actor: "system-executor", createdAt: ... }
// ]
```

### Audit Actions

- `created`: Intent proposal submitted
- `approved`: Maintainer signed approval
- `denied`: Maintainer rejected intent
- `executed`: System executed approved action
- `expired`: Intent TTL exceeded

## Operational Procedures

### Emergency Halt

```typescript
// 1. Create intent
const { intentId } = await service.createIntent({
  actionType: "emergency_halt",
  actionPayload: { poolId, reason: "exploit detected" },
  requesterAddress,
  requesterPublicKey,
  reason: "Immediate halt required"
});

// 2. Notify maintainers (out-of-band)
// Slack, PagerDuty, etc.

// 3. Maintainer approves
const receipt = await service.approveIntent({
  intentId,
  approverAddress,
  approverPublicKey,
  approverPrivateKey
});

// 4. System executes
await haltPoolOperations(poolId);
await service.executeIntent(intentId, "emergency-executor");
```

### Pool Parameter Change

```typescript
// 1. Create intent
const { intentId } = await service.createIntent({
  actionType: "pool_parameter_change",
  actionPayload: {
    poolId: "pool-456",
    parameter: "maxDeposit",
    currentValue: "5000",
    newValue: "10000"
  },
  requesterAddress,
  requesterPublicKey,
  reason: "Increasing deposit cap based on demand"
});

// 2. Review and approve
const receipt = await service.approveIntent({ /* ... */ });

// 3. Execute parameter change
await updatePoolParameter(poolId, "maxDeposit", "10000");
await service.executeIntent(intentId, "parameter-updater");
```

## Failure Modes

### Approval Timeout

**Symptom**: Intent reaches `expiresAt` without approval  
**Recovery**: Create new intent with updated justification  
**Rollback**: Intent automatically marked `expired`, no action taken

### Execution Failure

**Symptom**: Execution throws error after approval  
**Recovery**: Retry execution with same intent (idempotent)  
**Rollback**: Intent remains `approved`, can be re-executed

### Invalid Signature

**Symptom**: Signature verification fails during execution  
**Recovery**: Manual investigation (possible compromise)  
**Rollback**: Execution rejected, intent remains `approved`

## Post-Mortem Review

Query all intents within timeframe:

```sql
SELECT * FROM intent_proposals
WHERE created_at BETWEEN '2026-10-01' AND '2026-10-31'
ORDER BY created_at DESC;
```

Review audit trail for each critical action:

```typescript
for (const intent of criticalIntents) {
  const trail = await service.getIntentAuditTrail(intent.id);
  console.log(`Intent ${intent.id}:`, trail);
}
```

## Testing

```bash
npm test -- tests/intent/intent-approval.spec.ts
```

Tests cover:
- Intent creation + audit entry
- Approval signature generation + verification
- Denial with reason
- Execution after approval
- Rejection of non-approved execution
- Complete audit trail

## API Integration

### Create Intent Endpoint

```http
POST /api/admin/intents
Authorization: Bearer <admin-token>
Content-Type: application/json

{
  "action_type": "emergency_halt",
  "action_payload": { "poolId": "pool-123" },
  "reason": "Suspected exploit"
}
```

### Approve Intent Endpoint

```http
POST /api/admin/intents/:id/approve
Authorization: Bearer <maintainer-token>
Content-Type: application/json

{
  "approval_notes": "Approved after review",
  "signature": "<stellar-signature>"
}
```

### Audit Trail Endpoint

```http
GET /api/admin/intents/:id/audit
Authorization: Bearer <admin-token>
```

Response:

```json
{
  "trail": [
    { "action": "created", "actor": "GREQUESTER...", "created_at": "..." },
    { "action": "approved", "actor": "GMAINTAINER...", "created_at": "..." },
    { "action": "executed", "actor": "system-executor", "created_at": "..." }
  ]
}
```

## Schema

### intent_proposals

| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Primary key |
| action_type | TEXT | High-impact action type |
| action_payload | JSONB | Action parameters |
| payload_hash | TEXT | SHA-256 of canonical payload |
| requester_address | TEXT | Stellar address of requester |
| status | TEXT | pending/approved/denied/executed/expired |
| approver_address | TEXT | Maintainer who approved |
| approval_signature | TEXT | Stellar signature |
| created_at | TIMESTAMPTZ | When intent was created |
| approved_at | TIMESTAMPTZ | When approved |
| executed_at | TIMESTAMPTZ | When executed |
| expires_at | TIMESTAMPTZ | Expiration deadline |

### intent_approval_audit

| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Primary key |
| intent_id | UUID | Foreign key to intent_proposals |
| action | TEXT | created/approved/denied/executed/expired |
| actor | TEXT | Who performed action |
| metadata | JSONB | Additional context |
| created_at | TIMESTAMPTZ | When action occurred |

## Migration

```bash
npx prisma migrate dev --name add_intent_approval
```

Applies migration: `20261019000000_add_intent_approval/migration.sql`
