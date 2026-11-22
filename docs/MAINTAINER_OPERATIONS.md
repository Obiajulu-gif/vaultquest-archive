# Maintainer notes, escalation, replay and backup validation

These backend tools implement issues #841, #842, #843 and #844. Apply migrations
with `cd backend && npx prisma migrate deploy`, then generate the client with
`npx prisma generate` before starting the updated service. No new dependencies
or environment variables are required. The migrations add notes, note audit,
escalation policies/attempts and event batch manifests. They also supply the
previously missing migration for the existing `User` model. Prisma mappings for
the existing partial-failure and immutable audit tables are restored so resolution
and rebuild actions use their production stores.

## Structured notes (#841)

All `/admin/notes` endpoints use the existing authenticated maintainer wallet
session and `admin.recovery.read`/`admin.recovery.write` permissions. Users and
machine identities cannot access notes. Scope types are `action`, `failure`,
`wallet` and `pool`; note kinds are `support`, `incident` and `decision`.

```http
POST /admin/notes
Authorization: Bearer <maintainer-session>
Content-Type: application/json

{"scopeType":"failure","scopeId":"<failure-id>","kind":"incident","visibility":"private","body":"Investigating a delayed receipt","retentionDays":30}
```

The response is the standard `{ "data": ... }` envelope with HTTP 201 and the
note's ID, version and expiry. `private` notes are visible only to their author;
`maintainers` notes are readable by all maintainers. Only the author may edit
content or change visibility. An authorized reader can redact or archive a
shared note. Access denied by note visibility is returned as 404.

| Method and path | Input / behavior |
| --- | --- |
| `GET /admin/notes?scopeType=failure&scopeId=...` | Up to 100 visible notes, newest first; `includeArchived=true` includes tombstones |
| `GET /admin/notes/:id` | Audited read with visibility enforcement |
| `PATCH /admin/notes/:id` | `{ "version": 1, "body": "Updated note", "visibility": "private" }` |
| `POST /admin/notes/:id/redact` | `{ "version": 2 }`; removes body permanently |
| `POST /admin/notes/:id/archive` | `{ "version": 2 }`; hides from default scoped listing |

Writes require the current version; stale writes return 409. Redacted and
archived notes cannot be edited. Content expires after 90 days by default,
configurable at creation from 1 through 365 days. Edits and archives do not
extend expiry. Reads enforce expiry even when the background sweep is late.
The bounded sweep runs every minute, including for archived/private notes.

Content is never copied into `maintainer_note_audit`. Create/read/edit/redact/
archive/expire actions and visibility denials record the actor, note reference,
version and outcome. Database triggers reject audit UPDATE, DELETE and TRUNCATE.
Redaction and expiry retain the note identity and audit references. After a
restore, run the updated service's retention sweep before exposing restored
notes; retained backup archives have their own storage retention policy.

## Failure escalation (#842)

The maintainer inbox at `GET /admin/escalations` is the notification destination;
it requires no email configuration. Alerts and acknowledgments persist across
restarts. Each alert records its failure, severity, policy version and attempt.
It intentionally excludes free-form failure metadata from inbox responses.

| Severity | First alert after detection | Repeat interval | Maximum alerts |
| --- | --- | --- | --- |
| low | 24 hours | 24 hours | 10 |
| medium | 1 hour | 1 hour | 10 |
| high | 15 minutes | 30 minutes | 10 |
| critical | Immediately | 5 minutes | 20 |

`GET /admin/escalations/policies` returns the live settings. Update one using
`PUT /admin/escalations/policies/:severity`, for example:

```json
{"afterMs":900000,"repeatMs":1800000,"maxAttempts":10,"enabled":true,"expectedVersion":1}
```

Policy changes apply at the next tick to existing unresolved/retryable
failures. Attempts are not reset by policy changes; increasing `maxAttempts`
permits more alerts, and disabling a policy stops new alerts. Repeat intervals
are at least one minute. Acknowledging an alert with
`POST /admin/escalations/:id/acknowledge` records the maintainer and time; it
does not resolve the underlying failure. Resolve/ignore the failure through
the existing partial-failure endpoints to stop escalation. Resolved/ignored
failures disappear from the active report immediately; their history remains.

The evaluator runs every minute in bounded keyset pages. Multiple replicas
serialize on each failure row, preventing duplicate attempts and races with
resolution. A large backlog can take multiple ticks to traverse. Maintainers
can run a page manually with `POST /admin/escalations/evaluate` and follow the
returned cursor using `{ "cursor": "..." }`. All inbox, policy and manual
evaluation routes require maintainer recovery permissions.

## Event log and projection replay (#843)

`chain_events` remains the raw replay source. Raw XDR, event ID, ledger close
time, transaction and contract identity are persisted before projections are
changed. `chain_event_batches` stores event membership plus SHA-256 hashes of
the original bytes in bounded batches. Duplicate event IDs must have identical
content. The migration gives existing history membership manifests; it cannot
recover events already missing before migration or establish historical byte
hashes. New appends get both checks.

Replay order is the lexicographic RPC event ID (padded TOID plus event index),
not receipt time or transaction hash. IDs are not contiguous numbers. All
projections use the production indexer/ledger path; confirmation and recovery
timestamps come from the event's ledger close time. Legacy events without that
time use the persisted intent time. Registry events remain ordered relative to
action events, and failed writes never advance the replay cursor past a gap.
Ordinary events are committed in batches. Rebuilds register no payout callback.

```bash
cd backend
# Plan: no projection writes, reset, or lease acquisition.
npm run projections:rebuild
# Execute under the indexer lease; CLI credentials must be for a DB operator.
npm run projections:rebuild -- --execute --actor maintainer-name --reason 'Rebuild after decoder repair'
# Continue a failed run, with its persisted projection version and cursor.
npm run projections:rebuild -- --execute --resume <run-id> --actor maintainer-name
```

Set `DATABASE_URL` and the same `VAULT_FACTORY_ADDRESS` as live indexing. The
CLI records execution in the existing immutable audit trail. The authenticated
HTTP job endpoints are also supported: `/admin/projections/plan`,
`/admin/projections/rebuilds`, and `/admin/projections/rebuilds/:id/resume`.
HTTP execution uses the shared audit trail. Downgrading requires an explicit
`--allow-downgrade` or HTTP `allow_downgrade: true`.

Manifest validation runs before reset and again before completion. Missing or
changed logged events block replay with a repair hint. Malformed XDR halts at
quarantine; a write failure persists a failed run. Incomplete runs fence live
indexing until repaired and resumed or superseded. Restore the original bytes
from a trusted archive for missing/altered events; do not delete the manifest to
bypass validation. Fix decoding or database errors before resuming. CLI exits
0 on success, 1 for a persisted failed run and 2 for invocation/preflight errors.

## Snapshot backup validation (#844)

The JSON validation snapshot is a companion to the existing `pg_dump` archive,
not a replacement for that archive. It captures critical validation fields for
profiles, actions, raw chain events/checkpoints, pool registry/watchlists,
settlements, user quests and rewards in one read-only Repeatable Read
transaction. It includes wallet/transaction data: store it with the backup's
access controls. Password hashes and session secrets are excluded. Capture is
intended for bounded, operator-managed snapshots and materializes the selected
rows in memory; use the existing restored-database validator for large restores.

```bash
cd backend
npm run backup:snapshot -- --output /secure/backup/validation.json
# Offline: does not connect to a database or modify the snapshot.
npm run backup:snapshot -- --snapshot /secure/backup/validation.json
# Small, clean checked-in fixture:
npm run backup:snapshot -- --snapshot tests/fixtures/backup-snapshots/clean.json
# Existing read-only check against a restored SQL archive:
npm run db:validate-restore
```

Capture refuses to overwrite an existing file and creates it with mode 0600.
The versioned envelope includes all required tables and captured row counts.
Validation reports missing tables/records, duplicate primary/business keys,
orphan action/pool/reward references, malformed raw events and inconsistent
confirmation/reward/settlement states. It never prints private row values:
findings identify only table, row index, code and invariant. Preserve the capture
manifest with the snapshot: changing its expected counts removes the evidence
needed to detect rows removed from an otherwise internally consistent file.
This is consistency validation, not an authenticity signature for an archive.
Exit codes are 0 (valid/captured), 1 (invalid snapshot) and 2 (file/JSON/connection
or invocation error). Neither capture nor validation writes to the database.
