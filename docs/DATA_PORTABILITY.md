# Data export and import

## Export — `GET /exports`

Returns a JSON attachment of the caller's own data. Requires a wallet session
(`own.data.export`). Exporting another wallet requires `admin.export.any`
(maintainers); anyone else gets `403` before any data is read.

Query: `wallet` (optional, defaults to the session wallet),
`sections` (comma-separated `actions`, `saved_pools`; default both).

```jsonc
{
  "metadata": {
    "schema_version": "1.0.0",
    "generated_at": "2026-03-01T12:00:00.000Z",
    "expires_at": "2026-03-02T12:00:00.000Z",   // generated_at + retention_hours
    "retention_hours": 24,
    "wallet": "G...",
    "generated_by_role": "user",
    "sections": ["actions", "saved_pools"],
    "record_counts": { "actions": 12, "saved_pools": 3 },
    "redacted_fields": [],                       // fields withheld from this caller (see below)
    "truncated": false,                          // true if a section hit the cap
    "max_records_per_section": 10000,
    "checksum": "<sha256 of JSON.stringify(data)>"
  },
  "data": { "actions": [ ... ], "saved_pools": [ ... ] }
}
```

- **Privacy-safe schema.** Records use an explicit field allowlist. Idempotency
  keys, correlation ids, free-form payloads, error details and scrubbed
  (redacted) rows are never exported.
- **Retention.** Exports are generated on demand and never stored server-side;
  responses are `Cache-Control: no-store`. `expires_at` tells consumers when to
  discard their copy.
- **Schema versioning.** The major version changes on breaking shape changes.
- **Limits.** 10,000 records per section; `truncated: true` signals the cap.

### Field-level authorization

Wallet-level access decides whether you may export a wallet. A per-field policy
(`OWNER_ONLY_FIELDS` in `backend/src/services/dataExport.ts`) then decides
which fields you receive:

| Field | Wallet owner | Maintainer exporting another wallet (`admin.export.any`) |
|---|---|---|
| `actions.amount`, `actions.asset`, `actions.pool_id` | included | **withheld** |
| every other `actions` and `saved_pools` field | included | included |

The withheld fields are read from the action's free-form payload, which
`lib/sensitive-field-access.ts` classes as sensitive (`amount`,
`action_payload`). The owner is whoever's session wallet equals the exported
wallet, so a maintainer exporting their own wallet gets every field.

- **Withheld fields are omitted, not nulled**, and listed in
  `metadata.redacted_fields` as `section.field` (for example
  `"actions.amount"`), so a consumer can tell "withheld" from "empty".
- **Checked on the server.** The fields are dropped while each row is
  projected, before the checksum is computed, so they never leave the service.
- **Access log.** The sensitive-field access log records only the sensitive
  fields the caller actually received.
- **Retries.** Exports are deterministic: retrying the same request gives the
  same rows, the same `redacted_fields` and, for the same `generated_at`, the
  same checksum. A failed read fails the whole export; there are no partial
  files to clean up.

**Migration.** Owner exports are unchanged except for the new, always-present
`metadata.redacted_fields` (`[]`), so `schema_version` stays `1.0.0` and
saved-pool imports keep working. Exports a maintainer makes of another wallet
no longer contain the three fields above. A support workflow that needs an
amount should ask the owner for their own export. No database migration or configuration is
needed. To roll back, revert the change: exports are generated on demand and
nothing is stored.

## Import — `POST /imports/saved-pools`

Imports a wallet's saved pools (watchlist). Requires a wallet session
(`own.data.import`); the target wallet is always the session wallet.
Ledger actions are intentionally **not** importable (they are derived from
on-chain events and could otherwise be forged).

```jsonc
{ "format_version": "1.0.0", "dry_run": true, "records": [ /* saved_pools export rows */ ] }
```

`dry_run` defaults to `true`; committing needs an explicit `false`. Max 1,000
rows. The response lists every row and a summary:

```jsonc
{ "data": {
  "dry_run": true,
  "summary": { "total": 3, "create": 1, "update": 1, "skip": 1, "error": 0 },
  "rows": [ { "index": 0, "pool_id": "p1", "action": "create" },
            { "index": 1, "pool_id": "p2", "action": "skip", "reason": "unchanged" }, ... ]
} }
```

- **Dry run performs no writes.**
- **Idempotent.** `pool_id` is the external id: identical rows are skipped,
  changed rows updated, new rows created. Re-running an import changes nothing.
- **Row-level validation.** Invalid rows report field errors (`reason: "invalid"`)
  and never block the valid rows. Text fields are sanitized (see
  [SECURITY_FEATURES.md](./SECURITY_FEATURES.md#untrusted-content)). In-file
  duplicates are skipped (`duplicate_in_file`, first wins).

### Remediation and rollback

Rows are applied independently, so a partial import is possible
(`write_failed` rows). A committed run returns rollback guidance:

```jsonc
"rollback": {
  "delete_pool_ids": ["p1"],     // created by this run: DELETE /saved-pools/:poolId
  "restore_records": [ { ... } ] // previous values of updated rows: re-import them
}
```

1. **Invalid rows** – fix the listed fields and re-run; already-applied rows are skipped.
2. **Partial failure** – re-run the same file; it is idempotent and only retries what failed.
3. **Undo** – delete the `delete_pool_ids`, then import `restore_records`
   (`format_version` `1.0.0`, `dry_run: false`).

No database migration or new configuration is required.
