# Security Features Migration

This migration adds support for 4 critical security features:

## Issue #611: Reproducible WASM Release Artifacts & Attestations

Add `ReleaseAttestation` table:
```prisma
model ReleaseAttestation {
  id String @id @default(cuid())
  wasmHash String @unique
  sbomHash String
  checksumSignature String
  sourceRevision String
  networkId String
  adminId String
  contractIds String[]
  toolchainVersion String
  timestamp DateTime @default(now())
  createdAt DateTime @default(now())
}
```

## Issue #610: Observability Cardinality & Redaction

Add `MetricCardinality` table:
```prisma
model MetricCardinality {
  id String @id @default(cuid())
  metricName String
  dimension String
  distinctCount Int @default(0)
  budgetLimit Int @default(100)
  lastUpdated DateTime @default(now())
  
  @@unique([metricName, dimension])
}
```

## Issue #609: Admin Audit APIs & Credential Separation

Add `AdminSession` table:
```prisma
model AdminSession {
  id String @id @default(cuid())
  sessionId String @unique
  walletAddress String
  signature String
  audience String
  roleVersion Int
  expiresAt DateTime
  createdAt DateTime @default(now())
  revokedAt DateTime?
}
```

## Issue #608: ActionLedger Tamper-Evidence & Verification

Add `ActionLedgerChain` table:
```prisma
model ActionLedgerChain {
  id String @id @default(cuid())
  actionId String
  previousHash String
  currentHash String @unique
  actor String
  authorization String
  intentHash String
  result Json
  referencedEvents String[]
  canonical String
  signature String
  createdAt DateTime @default(now())
  
  @@index([actionId])
  @@index([createdAt])
}
```

## Environment Variables Required

```
LEDGER_SIGNING_KEY=<hex-encoded-signing-key>
LEDGER_PUBLIC_KEY=<hex-encoded-public-key>
ATTESTATION_SIGNING_KEY=<hex-encoded-signing-key>
```

## Deployment Notes

1. Run migrations to create new tables
2. Set environment variables for signing keys
3. Update app initialization to wire new services
4. Add new routes to API server
5. Export toolchain version in build artifacts
