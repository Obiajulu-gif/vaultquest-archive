# Authorization Tests for Hidden and Archived Records

## Overview

This document describes the comprehensive authorization tests for hidden (redacted) and archived records in the VaultQuest backend. The tests ensure proper access control, state management, and recovery behavior for sensitive maintainer records.

**Test File:** `tests/hidden-archived-auth.spec.ts`

## Record States

### Archived Records
- **Field:** `MaintainerNote.archivedAt` (nullable DateTime)
- **Meaning:** A soft-delete flag indicating the note is no longer active but is retained for audit purposes
- **Behavior:** Archived notes are excluded from default list operations (`includeArchived = false`)
- **Recovery:** Cannot be unarchived; archival is permanent

### Hidden (Redacted) Records
- **Field:** `MaintainerNote.redactedAt` (nullable DateTime)
- **Meaning:** The note's body has been permanently removed from storage for privacy/compliance
- **Behavior:** Body is `null`; note metadata remains queryable
- **Recovery:** Content is permanently gone; cannot be restored

### Visibility Levels
- **"maintainers":** All maintainers can view and modify (shared)
- **"private":** Only the author can view; other maintainers see 404

## Test Coverage

### 1. Normal Path — Authorized Access

✓ Maintainers can archive and redact their own notes
✓ Any maintainer can archive/redact shared ("maintainers" visibility) notes
✓ Authors can read their private notes even after archive/redaction
✓ List operation respects `includeArchived` flag
✓ Subsequent operations use updated version numbers (optimistic locking)

**Key Contract:**
```typescript
// Archive transitions a note to inactive but preserves content
const archived = await notes.archive(admin1, note.id, note.version);
expect(archived.archivedAt).not.toBeNull();
expect(archived.body).not.toBeNull(); // Body intact

// Redact removes the body permanently
const redacted = await notes.redact(admin1, note.id, note.version);
expect(redacted.body).toBeNull();
expect(redacted.redactedAt).not.toBeNull();
```

### 2. Failure Path — Unauthorized Access

✓ Non-maintainers (users, services) cannot archive or redact
✓ Access denied is logged to audit trail with `allowed: false`
✓ Access denied to private notes returns 404 (not 403) for privacy
✓ Non-maintainers see empty list even if notes exist
✓ Users cannot modify visibility of shared notes

**Authorization Boundaries:**
- Only **maintainers** can archive/redact
- Only **authors** can edit visibility of private notes
- **Role "service"** (automated jobs) cannot access maintainer operations

### 3. Retry Path — Transient Failures & Recovery

#### Optimistic Version Mismatch
```typescript
// Attempting action with stale version fails with 409 Conflict
await expect(notes.archive(admin1, note.id, staleVersion))
  .rejects.toMatchObject({ statusCode: 409 });

// Retry with current version succeeds
const updated = await notes.archive(admin1, note.id, currentVersion);
```

#### State Transition Constraints
- **Cannot edit** archived or redacted notes (throws 409)
- **Cannot restore** redacted content (body is permanently null)
- **Cannot unarchive** an archived note (archival is irreversible)

#### Concurrent Operations
- Optimistic locking prevents race conditions
- Multiple maintainers can safely attempt to archive the same note
- Last writer wins, earlier attempts receive 409 and must retry with updated version

### 4. Edge Cases — Authorization Boundaries

#### Visibility Changes
```typescript
// Author can change visibility at any time
const toPrivate = await notes.edit(admin1, note.id, v1, {
  body: "Now private",
  visibility: "private"
});
// Now admin2 sees 404
await expect(notes.get(admin2, note.id)).rejects.toMatchObject({ statusCode: 404 });
```

#### Archived → Redacted Sequence
```typescript
// Can archive then redact (or vice versa)
let note = await notes.create(admin1, input);
note = await notes.archive(admin1, note.id, note.version);
note = await notes.redact(admin1, note.id, note.version);
// Final state: both archivedAt and redactedAt set, body is null
expect(note.archivedAt).not.toBeNull();
expect(note.redactedAt).not.toBeNull();
expect(note.body).toBeNull();
```

#### Expiry + Visibility
- When note content expires (after `expiresAt`), body is redacted automatically
- **Shared notes:** Any maintainer can see the note exists (with null body)
- **Private notes:** Still return 404 for non-authors, respecting original visibility

#### Authorization vs. Not Found
- **Maintainer + non-existent note:** Returns 404
- **Non-maintainer + any note:** Returns 403 (not 404, to prevent role discovery)

## Recovery and Rollback Behavior

### Failed Authorization
- **Transaction:** Rolls back; no note state changes
- **Audit Trail:** Records the denied action with `allowed: false`
- **State:** Note version and content remain unchanged

```typescript
const v1 = note.version;
await expect(notes.archive(user1, note.id, v1)).rejects.toThrow();
// Audit logged
// Version still v1, archivedAt still null
```

### List Operation Mid-Stream
- Notes that become inaccessible during listing are **skipped gracefully**
- Shared notes appear in results; private notes are filtered
- Each item is re-checked under row lock before including

### Failure Escalation
- **Role enforcement:** Denied in `requireMaintainer` before database transaction
- **Version conflict:** Caught in transaction; rolls back and returns 409
- **State transition violation:** Caught in transaction; rolls back and returns 409

## Contracts and Schema

### Preserved Contracts
- `MaintainerNote` schema is **immutable:** all existing fields remain
- `archivedAt` and `redactedAt` already exist in schema (nullable)
- `visibility` field unchanged ("maintainers" | "private")
- `includeArchived` parameter on `list()` method (default: false)

### Audit Trail
- `MaintainerNoteAudit` table is **append-only**
- **Cannot be deleted** (database trigger blocks DELETE operations)
- Records: action, actor, allowed, version, noteId, createdAt

### Query Indexes
- `@@index([scopeType, scopeId, createdAt])` supports list queries
- `@@index([expiresAt])` supports retention sweep queries

## Implementation Notes

### Optimistic Locking
- Each operation increments `version`
- Caller must provide expected version
- Mismatch triggers 409 Conflict (requires retry with fresh version)

### Row-Level Locking
- Sensitive operations use `SELECT ... FOR UPDATE` to prevent race conditions
- Applies to: archive, redact, edit, expire

### Visibility Enforcement
- Checked **before** returning note (even on 404 errors)
- Private notes return 404 to non-authors (not 403)
- Prevents enumeration attacks

### Time Control
- Tests inject `() => now` clock
- Deterministic expiry behavior
- Batch sweep operations pinned to single instant

## Running the Tests

### Prerequisites
- Docker (for testcontainers/PostgreSQL)
- Node.js with npm

### Command
```bash
cd backend
npm install
npm test -- tests/hidden-archived-auth.spec.ts
```

### Environment
- Uses testcontainers to spin up PostgreSQL 16
- Database auto-migrated via Prisma
- Test isolation via `resetDb()` between tests

## Edge Cases and Known Behaviors

### Private Note Visibility
```typescript
// Even if archived, author can retrieve
const archived = await notes.archive(admin1, privateNote.id, v1);
const retrieved = await notes.get(admin1, archived.id);
// Works — author can see archived private note

// But other maintainers cannot
await expect(notes.get(admin2, archived.id))
  .rejects.toMatchObject({ statusCode: 404 });
```

### Version Mismatch Error Message
```
"note changed; reload its current version"
```
Caller must fetch the note again to get the current version before retrying.

### Redaction is Permanent
- No `unreact()` method exists
- Attempting to edit after redaction fails with 409
- Body cannot be restored once redacted

### Archive + Expiry Interaction
- Archived note can still expire its body
- `archivedAt` and `expiresAt` are independent
- When body expires, `redactedAt` is set (auto-hidden on read)

## Future Enhancements

1. **Soft Unarchive:** Add ability to restore archived notes (currently blocked)
2. **Redaction Escrow:** Delay permanent deletion to support compliance hold periods
3. **Batch Operations:** Archive/redact multiple notes by scope (scopeType + scopeId)
4. **Role-Based Filtering:** Limit archive/redact to specific maintainer roles

## Related Issues

- #841: Structured maintainer notes
- #842: Configured failure escalations
- #814: Audit trail redaction of secrets
- #851: Visibility boundary consistency checks

## References

- `MaintainerNotesService`: `src/services/maintainerNotes.ts`
- `maintainerOperationsRoutes`: `src/routes/maintainerOperations.ts`
- Database schema: `prisma/schema.prisma` (MaintainerNote model)
