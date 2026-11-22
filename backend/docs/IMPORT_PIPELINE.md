# Secure Import Pipeline

## Overview
A two-phase pipeline for operator-supplied data (currently prize-round winners): **preview** → **commit** → **rollback**. Guarantees:
- Preview never mutates business data; it only records the batch and rows.
- Every row is either `accepted` (later applied) or `quarantined` with a machine-readable reason — quarantined rows are never applied.
- Applied rows carry the created action id (`applied_ref`) plus `import_batch_id` provenance in the action payload, so an auditor can walk from CSV row → action → on-chain event.
- Commit is idempotent per row (stable `import:{batch}:{row}` idempotency keys), so retrying a partially-failed commit can never duplicate work.
- Rollback is retry-safe: pending actions are cancelled; submitted/confirmed actions are reported as `rollback_blocked` and must be reversed on-chain manually.

## Kinds
Currently only `prize_winners` is supported. Columns (in order, all required):
| Column | Type | Validation |
|---|---|---|
| `vault_id` | string | `[A-Za-z0-9_-]{1,64}` |
| `wallet_address` | string | `^G[A-Z0-9]{55}$` (Stellar address) |
| `winner_wallet` | string | `^G[A-Z0-9]{55}$` (Stellar address) |
| `amount` | string | `^[0-9]{1,18}$` positive integer |
| `token` | string | `^[A-Z0-9]{1,12}$` |
| `round` | string | `^[1-9][0-9]{0,8}$` positive integer |

## CSV Parser (`parseCsv`)
- Handles RFC-4180 quoting (embedded commas, doubled quotes `""`).
- Strips UTF-8 BOM if present.
- Tracks line numbers (1-based, header = row 1).
- CRLF / LF line endings; lone CR also terminates a row.
- Reports `unterminated quoted field` error if quotes are not closed.
- Skips fully blank lines; a line with only whitespace but no cells is not counted as a data row.
- Enforces `maxRows` cap; returns error if exceeded.
- Returns `{ headers, rows: { row_number, cells }[], error? }`.

## Row Validation (`validatePrizeWinnerRow`)
For each row, after aligning cells to header columns:
1. **Empty field** → `empty_field` (reason: `<column> is empty`).
2. **Oversized field** (> 200 chars) → `unsafe_content` (reason: `<column> exceeds 200 characters`).
3. **Control characters or formula syntax** (`[\u0000-\u001F\u007F]` or `^[=+\-@]`) → `unsafe_content` (reason: `<column> contains control characters or spreadsheet formula syntax`).
4. **vault_id** must match `[A-Za-z0-9_-]{1,64}` → `invalid_vault_id`.
5. **wallet_address** must match Stellar `^G[A-Z0-9]{55}$` → `invalid_wallet`.
6. **winner_wallet** must match Stellar `^G[A-Z0-9]{55}$` → `invalid_wallet`.
7. **amount** must be a positive integer string `^[0-9]{1,18}$` and `BigInt(amount) > 0n` → `invalid_amount`.
8. **token** must match `^[A-Z0-9]{1,12}$` → `invalid_token`.
9. **round** must match `^[1-9][0-9]{0,8}$` → `invalid_round`.
10. **Duplicate detection** — dedupe key is `${vault_id}:${round}:${winner_wallet}`; if already seen → `duplicate_row` (reason: `duplicate of an earlier ${dedupeKey}`).

## Preview (`preview`)
- Validates content size (max 512KB via `Buffer.byteLength`).
- Parses CSV; returns validation error if malformed.
- Checks headers: every expected column must be present; extra or missing columns are reported by name.
- Validates each row individually, recording `quarantineReason` and `quarantineDetail` per row.
- Counts `acceptedRows` and `quarantinedRows`; writes a `status: "preview"` batch + rows to the DB; **no ledger actions are created**.
- Idempotent via `idempotencyKey` (uuid or derived from content hash); duplicate key + same content → return existing batch (200, `created: false`); duplicate key + different content → 409 `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD`.

## Commit (`commit`)
- Fetches the batch; if already `committed` → idempotent return (same counts, `already_committed: true`).
- If status !== `preview` → 409 `ILLEGAL_TRANSITION`.
- For every `accepted` row:
  - Creates a `select_winner` action via `ledger.createAction` with:
    - `walletAddress` = operator's wallet_address (the `wallet_address` column value).
    - `actionPayload` = `{ vault_id, winner_wallet, amount, token, round, origin: "import", import_batch_id, import_row, ...import_source? }`.
    - `idempotencyKey` = `import:{batchId}:{rowNumber}`.
  - Updates the row status to `applied`, `appliedRef` = action id, clears quarantine fields.
- If `createAction` throws for a row → that row is quarantined with `commit_failed` reason and the detail contains the error message; other rows continue.
- After processing all rows, batch status is set to `committed`, `committedAt` = now, `appliedRows` / `quarantinedRows` recounted.
- Retrying commit is safe: already-applied rows are skipped (idempotency key already exists → `createAction` returns existing action).

## Rollback (`rollback`)
- If batch status `rolled_back` → idempotent return (`already_rolled_back: true`).
- If status !== `committed` && `partially_rolled_back` → 409 `ILLEGAL_TRANSITION`.
- For every `applied` row:
  - Fetches the action by `appliedRef`.
  - If action not found → marks row `rolled_back` with detail `action_missing_from_ledger`; continues.
  - If action status !== `pending` → marks row `rollback_blocked` with detail `action already ${action.status}; reverse on-chain state manually`; **does not** cancel the action; continues.
  - If action status === `pending` → calls `ledger.cancelAction(action.id, ERROR_CODES.IMPORT_ROLLBACK, "import batch ${batch.id} rolled back")`; marks row `rolled_back`.
- After processing all applied rows:
  - If any rows remain `rollback_blocked` → batch status = `partially_rolled_back`; `rolledBackAt` = now; `rolledBackRows` = count of successfully rolled back rows.
  - If all applied rows were rolled back → batch status = `rolled_back`; `rolledBackAt` = now; `rolledBackRows` = total applied count.
- Retrying rollback is idempotent: already-rolled-back rows are skipped; already-rollback-blocked rows remain blocked.

## Traceability
- **GET /internal/imports/:id**: returns the batch + all rows with `applied_ref`, `quarantineReason`, `quarantineDetail`, `payload`.
- **GET /actions/:applied_ref**: returns the underlying action; payload contains `import_batch_id` and `import_row`, so an auditor can trace from the ledger action back to the source CSV row.
- The `commit` response includes `batch.next_actions` guidance (e.g. "Broadcast each select_winner action from the wallet UI, then PATCH /actions/:id/submitted", "Roll back not-yet-broadcast rows: POST /internal/imports/:id/rollback").

## Rate Limits & Content Size
- **maxRows**: 1000 per batch.
- **maxContentBytes**: 512KB (zod `.max(512 * 1024)` on the string length; service also checks `Buffer.byteLength(content, "utf8")`).
- Oversized content or row count → 400 validation error.

## Test Cases (imports.spec.ts)
- Preview: 201 status; batch status `preview`; counts (total 7, accepted 1, quarantined 6); quarantine reasons match expected set (`unsafe_content`, `invalid_amount`, `invalid_token`, `invalid_wallet`, `invalid_round`, `duplicate_row`); no ledger actions created.
- Idempotency: same `idempotencyKey` + same content → 200 + `created: false`; same key + different content → 409.
- Header validation: unknown column → 400 with message `unknown: <col>`; missing column → 400 with `missing: <col>`.
- Oversized content (> 600KB) → 400.
- Too many data rows (> 1000) → 400.
- Commit: 200; batch status `committed`; `applied_rows === 1`; 1 `select_winner` action in DB with `status: "pending"`; payload provenance (`import_batch_id`, `import_row`, `origin: "import"`); replay commit → `already_committed: true`; no duplicate actions.
- Rollback (pending): after commit, rollback → action status `failed` with `errorCode: "IMPORT_ROLLBACK"`; batch status `rolled_back`; retry rollback → `already_rolled_back: true`.
- Rollback blocked: commit, then manually set action status to `submitted` (simulating broadcast), then rollback → batch status `partially_rolled_back`; row `rollback_blocked` with detail containing `submitted`; action status remains `submitted`; `next_actions` guidance includes on-chain language.
- Quarantined rows never applied: after commit, `select_winner` action count = 1 even though 8 rows were previewed.
- Traceability: `GET /internal/imports/:id` rows have `applied_ref`; `GET /actions/:applied_ref` payload contains `import_batch_id` and `import_row`.
- Illegal transitions: commit on unknown id → 404; rollback on preview batch → 409 `ILLEGAL_TRANSITION`; commit on non-uuid string → 400.
- CSV parser unit: quoted fields with embedded commas/newlines, CRLF, BOM, unterminated quote error, blank lines skipped.

## Files
- `backend/src/services/importService.ts` — `ImportService` class, `parseCsv`, `validatePrizeWinnerRow`, `ImportQuarantineReason`, `ImportBatchView`, `ImportRowView`, `nextActionsForStatus`.
- `backend/src/services/csv.ts` — `parseCsv`, `CsvRow`, `CsvParseResult`.
- `backend/src/routes/imports.ts` — `POST /internal/imports/preview`, `POST /internal/imports/:id/commit`, `POST /internal/imports/:id/rollback`, `GET /internal/imports/:id`.
- `backend/src/schemas/imports.ts` — `importPreviewBody`, `importBatchParams`.
- `backend/tests/imports.spec.ts` — integration tests.
- `docs/IMPORT_PIPELINE.md` — this document.