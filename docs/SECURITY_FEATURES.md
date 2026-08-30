# Security Features Implementation Guide

This document covers the implementation of 4 critical security enhancements.

## #611: Reproducible WASM Release Artifacts & Attestations

### Overview
Pin Rust/Soroban toolchain and produce deterministic, signed WASM builds with cryptographic attestations.

### Components
- **rust-toolchain.toml**: Pins Rust 1.82.0 and soroban SDK version
- **AttestationService**: Generates and verifies signed attestations
- **ReleaseAttestation**: Database table for storing attestation records

### Usage
```typescript
const attestationSvc = new AttestationService(prisma);

const attestation = await attestationSvc.createAttestation({
  wasmBuffer: Buffer.from(wasmBinary),
  sbomContent: sbomJson,
  sourceRevision: gitCommitHash,
  networkId: "stellar-mainnet",
  adminId: adminWallet,
  contractIds: deployedContracts,
  toolchainVersion: "1.82.0",
  signingKey: fs.readFileSync("signing-key.pem")
});

const isValid = await attestationSvc.verifyAttestation(
  attestation,
  publicKey
);
```

### Verification Before Promotion
All attestations must be verified before promoting to registry:
- Signature verification against public key
- Toolchain version validation
- Source revision tracking
- Contract ID pinning

---

## #610: Observability Cardinality & Redaction

### Overview
Prevent unbounded cardinality and redact financial identifiers from logs and metrics.

### Components
- **ObservabilityService**: Schema validation and cardinality enforcement
- **Redaction Middleware**: Automatic identifier hashing/omission
- **Cardinality Budget**: Per-metric-dimension limits

### Usage
```typescript
const schema: ObservabilitySchema = {
  approvedDimensions: new Set(["pool_id", "action_type", "status"]),
  cardinalityBudget: new Map([
    ["transaction_submit:pool_id", 50],
    ["action_status:status", 10]
  ]),
  redactionPatterns: []
};

const observabilitySvc = new ObservabilityService(logger, schema);

// Automatic redaction of sensitive values
const redacted = observabilitySvc.recursiveRedact({
  walletAddress: "GBL3F46SRO2CI27LFVQ6ZGLU5QPCLU3QSE7VMMYT6YJVWCIYT2SZ4XN",
  txHash: "abcdef1234567890...",
  amount: "1000"
});

// Record metric with cardinality enforcement
observabilitySvc.recordMetric("transaction_submit", "pool_id", poolId);
```

### Redaction Rules
- Wallet addresses (G*) → hashed with [REDACTED_WALLET:...] prefix
- Transaction hashes → hashed with [REDACTED_TX:...] prefix
- Structured logs → recursive redaction of sensitive fields
- Error text → omitted or generalized

---

## #609: Admin Audit APIs & Credential Separation

### Overview
Move admin authorization to server-side, use wallet-signed sessions instead of embedded credentials.

### Components
- **AdminSessionService**: Creates and validates wallet-signed sessions
- **admin-session middleware**: Enforces server-side authorization
- **AdminSession table**: Stores active sessions with expiration

### Usage
```typescript
const adminSessionSvc = new AdminSessionService(prisma);

// Client: Create session with wallet signature
const session = await adminSessionSvc.createSession({
  walletAddress: "GBL3F46SRO2CI27LFVQ6ZGLU5QPCLU3QSE7VMMYT6YJVWCIYT2SZ4XN",
  signature: walletSignature,  // Wallet-signed proof of ownership
  audience: "/admin/audit",     // Explicit audience (cannot reuse for other APIs)
  roleVersion: 1,               // Invalidate sessions when role changes
  ttlSeconds: 3600
});

// Client: Use session for subsequent requests
const headers = {
  "Authorization": `Bearer ${session.sessionId}`
};

// Server: Automatic verification and audience validation
// Routes using createRequireAdminSessionAuth middleware
```

### Session Revocation
- Sessions automatically expire after TTL
- Sessions revoked when role version increments
- Server-side revocation available for immediate invalidation

### Benefits
- No test credentials embedded in client code
- Explicit audience prevents token reuse
- Server controls authorization at every request
- Client-side state cannot override server validation

---

## #608: ActionLedger Tamper-Evidence & Verification

### Overview
Make audit ledger tamper-evident with cryptographic chaining and external checkpoints.

### Components
- **ActionLedgerVerificationService**: Creates hash-chained records
- **ActionLedgerChain table**: Immutable audit trail
- **Verification & Export**: Offline verification tooling

### Usage
```typescript
const verificationSvc = new ActionLedgerVerificationService(prisma);

// Create chained record for every action mutation
const record = await verificationSvc.chainRecord({
  actionId: "12345",
  actor: "admin-wallet",
  authorization: "session-signature",
  intentHash: intentHashOfChange,  // Hash of the change intent
  referencedEvents: ["event-id-1", "event-id-2"],
  signingKey: signingKeyBuffer
});

// Verify chain integrity offline
const verification = await verificationSvc.verifyChain(
  "12345",
  publicKeyBuffer
);
// Returns: { valid: true } or { valid: false, reason: "..." }

// Export complete audit trail
const chain = await verificationSvc.exportChain("12345");
// Returns array of chained records for offline verification
```

### Record Structure
Each chained record contains:
- **previousHash**: Hash of previous record (or "genesis")
- **currentHash**: Hash of this record
- **actor**: Who made the change
- **authorization**: How they were authorized (session ID, signature, etc)
- **intentHash**: Hash of the change intent
- **result**: Final state (status, txHash, errorCode)
- **referencedEvents**: Chain events referenced
- **signature**: Cryptographic signature of record

### Verification Process
1. Validate genesis condition (first record.previousHash == "genesis")
2. Verify hash chain (record[i].currentHash == record[i+1].previousHash)
3. Verify signatures with public key
4. Check no records modified or deleted

### Offline Verification
Export and verify ledger without database access:
```bash
# Export ledger
curl -H "Authorization: Bearer $SESSION" \
  /admin/ledger/export/action-id > ledger.json

# Verify offline
node verify-ledger.js --chain ledger.json --public-key pk.pem
```

---

## Integration Checklist

- [ ] Generate signing/public key pairs (environment setup)
- [ ] Add environment variables (LEDGER_SIGNING_KEY, etc)
- [ ] Create database migrations for new tables
- [ ] Wire services in app.ts initialization
- [ ] Register new routes (admin-session, ledger-verification)
- [ ] Update audit routes to use AdminSessionService
- [ ] Update logger to use redaction middleware
- [ ] Add ObservabilityService to metrics pipeline
- [ ] Export toolchain version in build artifacts
- [ ] Test attestation verification
- [ ] Test session expiration and revocation
- [ ] Test ledger chain verification
- [ ] Document API changes for clients

---

## Security Considerations

### Attestation Keys
- Private key (signing): Keep in HSM or secure key management
- Public key (verification): Distribute with registry verifier
- Rotation: Implement key rotation strategy

### Session Keys
- Session IDs: Cryptographically random (32 bytes)
- Storage: Hashed in database, never in logs
- Transport: HTTPS only, no URL parameters

### Ledger Keys
- Signing: Same as attestation or separate key pair
- Public key: Required for offline verification
- Checkpoints: Consider external checkpoint server for immutability

### Redaction
- Approved dimensions only in metrics
- Recursive redaction for structured logs
- Budget enforcement prevents cardinality attacks
- Regular audit of approved dimensions

---

## Monitoring & Alerting

Monitor these metrics:
- Attestation verification failures
- Session expiration rates
- Ledger chain integrity failures
- Cardinality budget violations
- Redaction rate per metric

Alert on:
- Multiple verification failures (5+ in 1 hour)
- Unusual session creation patterns
- Chain verification failures
- Cardinality budget exceeded
