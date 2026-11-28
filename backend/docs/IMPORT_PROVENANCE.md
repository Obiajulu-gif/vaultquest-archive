# Import Provenance System (Issue #1148)

## Overview

The Import Provenance System provides cryptographic verification and audit trails for all records imported into the VaultQuest backend. This ensures data integrity, operator accountability, and rollback capabilities for backup restores, migrations, manual imports, and repair operations.

## Motivation

Before this system, imported records (from backups, migrations, or manual operations) lacked:
- **Integrity verification**: No guarantee that imported data matched the source
- **Tamper detection**: No way to detect if data was modified during import
- **Accountability**: No audit trail of who performed imports
- **Rollback support**: No mechanism to revert corrupted or failed imports

## Architecture

### Core Components

1. **`ImportProvenance` Table**: Stores cryptographic provenance metadata
2. **`ImportProvenanceService`**: Business logic for hash verification, signatures, and rollback
3. **Migration**: Database schema changes with indexed queries

### Data Flow

```
┌─────────────────┐
│  Source Data    │ (backup file, migration script, manual payload)
│  (untrusted)    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Compute SHA-256 │
│      Hash       │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Create Provenance│ (pending status)
│    Record       │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Verify Hash     │ ◄─── Re-compute hash on actual import
│  (Match?)       │
└────────┬────────┘
         │
    ┌────┴────┐
    │         │
   YES       NO
    │         │
    ▼         ▼
 Verified   Failed
    │         │
    ▼         ▼
 Import   Rollback
```

## Usage

### 1. Creating Import Provenance

```typescript
import { ImportProvenanceService } from "./services/importProvenanceService.js";

const service = new ImportProvenanceService(prisma, logger);

// Step 1: Create provenance record before importing
const sourceData = fs.readFileSync("/backups/prod-2024-11-22.sql.gz");
const { id, sourceHash } = await service.createImportProvenance(
  {
    sourceType: "backup_restore",
    sourceRef: "/backups/prod-2024-11-22.sql.gz",
    operatorId: "admin-001",
    targetEntity: "ActionLedger",
    recordIds: [], // Will be populated during import
    metadata: { backupVersion: "1.5.2" }
  },
  sourceData
);

// Step 2: Perform actual data import
const importedRecords = await importBackupData(sourceData);

// Step 3: Update provenance with imported record IDs
await prisma.importProvenance.update({
  where: { id },
  data: {
    recordIds: importedRecords.map((r) => r.id),
    recordCount: importedRecords.length
  }
});

// Step 4: Verify integrity
const verification = await service.verifyImportIntegrity(id, sourceData);
if (!verification.valid) {
  throw new Error(`Import integrity check failed: ${verification.errorDetail}`);
}

// Step 5: Mark as completed
await service.completeImport(id);
```

### 2. Verifying Import Integrity

```typescript
// Re-verify an existing import
const verification = await service.verifyImportIntegrity(
  provenanceId,
  actualSourceData
);

if (!verification.valid) {
  console.error("TAMPER DETECTED:", verification.errorDetail);
  // Trigger rollback or alert
  await service.rollbackImport(provenanceId);
}
```

### 3. Rolling Back Failed Imports

```typescript
// Atomic rollback of corrupted import
const rollback = await service.rollbackImport(provenanceId);

if (rollback.success) {
  console.log(`Reverted ${rollback.revertedRecordCount} records`);
} else {
  console.error("Rollback failed:", rollback.errorDetail);
}
```

### 4. Digital Signatures (Optional)

```typescript
import { generateKeyPairSync } from "node:crypto";

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048
});

const signedService = new ImportProvenanceService(
  prisma,
  logger,
  privateKey // Enable signing
);

const { signature } = await signedService.createImportProvenance(input, data);

// Later: verify signature with public key
const isValid = signedService.verifyImportSignature(
  payload,
  signature,
  publicKey
);
```

### 5. Provenance History & Audit

```typescript
// Get import history for operator
const history = await service.getProvenanceHistory({
  operatorId: "admin-001",
  status: "completed"
});

// Get all backup restore operations
const backups = await service.getProvenanceHistory({
  sourceType: "backup_restore"
}, 50);
```

## Security Guarantees

### 1. Integrity Verification
- **SHA-256 hashing**: Cryptographically secure hash function
- **Tamper detection**: Any byte-level modification changes the hash
- **Verification on demand**: Re-compute hash anytime to detect corruption

### 2. Non-Repudiation (with Signatures)
- **Digital signatures**: Operator cannot deny performing an import
- **RSA-2048 or Ed25519**: Industry-standard signature algorithms
- **Public key verification**: Third parties can verify signatures

### 3. Atomicity & Rollback
- **Transaction-based rollback**: All-or-nothing reversion
- **Target-aware cleanup**: Redacts `ActionLedger`, deletes `PendingEvent`
- **Idempotent rollback**: Safe to retry on failure

### 4. Audit Trail
- **Immutable logs**: Provenance records are never deleted
- **Operator tracking**: Every import linked to an operator ID
- **Timestamped events**: `createdAt`, `verifiedAt`, `completedAt`, `revertedAt`

## Failure Modes & Recovery

### Hash Mismatch
**Scenario**: Source data was tampered with or corrupted during transfer.

**Detection**:
```typescript
const verification = await service.verifyImportIntegrity(id, data);
// verification.valid === false
// verification.errorCode === "HASH_MISMATCH"
```

**Recovery**:
1. Reject the import immediately
2. Rollback any partially imported records
3. Alert operator and security team
4. Re-fetch source data from trusted backup

### Failed Import
**Scenario**: Database constraint violation or network error during import.

**Detection**: Import completes with `status: "failed"`

**Recovery**:
```typescript
// Automatic retry with exponential backoff
const retried = await service.retryFailedImport(id, maxRetries = 3);
if (!retried) {
  // Max retries exceeded, escalate to manual intervention
}
```

### Orphaned Provenance Records
**Scenario**: Import crashes mid-execution, leaving `pending` provenance.

**Detection**: Cron job finds `pending` imports older than 1 hour.

**Recovery**:
```typescript
const stale = await prisma.importProvenance.findMany({
  where: {
    status: "pending",
    createdAt: { lt: oneHourAgo }
  }
});

for (const p of stale) {
  await service.rollbackImport(p.id); // Clean up partial state
}
```

## Edge Cases

### Duplicate Imports
**Protection**: Source hash deduplication

```typescript
// Attempting to import same data twice
const first = await service.createImportProvenance(input1, data);
const second = await service.createImportProvenance(input2, data);

// second.id === first.id (returns existing record)
```

### Large Imports
**Strategy**: Batch provenance tracking

```typescript
// Split large import into chunks
const chunks = splitIntoChunks(largeData, chunkSize = 1000);

for (const chunk of chunks) {
  const { id } = await service.createImportProvenance(
    { ...input, sourceRef: `${input.sourceRef}-chunk-${i}` },
    chunk
  );
  await importChunk(chunk);
  await service.completeImport(id);
}
```

### Concurrent Imports
**Safety**: Prisma transactions + unique source hash constraint

```typescript
// Two workers attempt to import same backup simultaneously
// Only one succeeds, the other gets existing provenance ID
```

## Testing Strategy

### Unit Tests (100% coverage)
- Hash computation correctness
- Signature generation/verification
- Idempotency via source hash
- Rollback transaction atomicity

### Integration Tests
- End-to-end import with verification
- Tamper detection (modify data mid-flight)
- Failed import retry logic
- Concurrent import handling

### E2E Tests
- Backup restore with provenance
- Migration with rollback
- Manual import with signature

## Performance Considerations

### Hash Computation
- **SHA-256 speed**: ~400 MB/s on modern CPUs
- **Large files**: Consider streaming hash for multi-GB backups

```typescript
import { createReadStream } from "fs";

function computeStreamHash(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}
```

### Database Indexes
- `source_hash`: Fast duplicate detection
- `operator_id + created_at`: Efficient audit queries
- `status + created_at`: Quick status filtering

### JSONB Record IDs
- Efficient storage for large record ID arrays
- GIN index on `record_ids` for membership queries (optional)

## Migration Path

### Existing Data
Existing imported records (pre-#1148) have no provenance. Options:

1. **Retrospective provenance** (recommended):
   ```sql
   INSERT INTO import_provenance (...)
   SELECT ...
   FROM action_ledger
   WHERE created_at < '2024-11-23'
   -- Mark as 'legacy' source type
   ```

2. **Fresh start**: Only track new imports going forward.

### Deployment
1. Apply migration: `prisma migrate deploy`
2. Deploy new backend with `ImportProvenanceService`
3. Update backup/restore scripts to use provenance
4. Train operators on new audit procedures

## Future Enhancements

### Merkle Tree Verification
For batch imports, use Merkle trees to verify subsets:

```typescript
const merkleRoot = computeMerkleRoot(recordIds);
// Store merkleRoot in metadata
// Later: verify any record is part of import without full list
```

### Blockchain Anchoring
Publish provenance hashes to Stellar blockchain for immutability:

```typescript
await stellarClient.submitTransaction({
  memo: `provenance:${sourceHash}`,
  ...
});
```

### Automated Anomaly Detection
Flag suspicious patterns:
- Multiple failed imports from same operator
- Large imports outside business hours
- Imports with no prior approval ticket

## References

- **Issue**: #1148
- **Migration**: `20261123002425_add_import_provenance`
- **Service**: `backend/src/services/importProvenanceService.ts`
- **Tests**: `backend/tests/importProvenance.spec.ts`
- **Related**: Backup Service (#275), Disaster Recovery (#754)
