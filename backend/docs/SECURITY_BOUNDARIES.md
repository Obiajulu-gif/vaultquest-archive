# Sensitive-Content Boundaries

## Overview
Every payload that crosses a trust boundary — rendered into user-visible notices, exported as CSV/JSON downloads, or forwarded to webhook subscribers — flows through the `contentBoundary` module first. The helpers are deliberately conservative: instead of trying to detect "bad" inputs, they structurally neutralise dangerous encodings.

## CSV Export (Formula-Injection Mitigation)
- `escapeCsvCell(value)` neutralises spreadsheet formulas by prefixing `=` `+` `-` `@` `tab` `CR` with a single quote `'`, always double-quoting the result and escaping embedded `"` → `""`.
- `looksLikeSpreadsheetFormula(value)` detects leading triggers after optional whitespace.
- CSV headers and every cell are run through `escapeCsvCell` before joining.
- Download filenames are sanitised via `sanitizeDownloadFilename` (path traversal, quotes, CRLF stripped; only `[A-Za-z0-9._-]` retained; collapsed leading `..`).

## Rendered Text (`sanitizeRenderedText`)
- Strips control characters (`\u0000-\u001F\u007F-\u009F`), collapses whitespace, caps length at configurable `maxLength`.
- By default HTML-escapes (`<script>`); `htmlEscape: false` leaves tags as plain text.
- Used for user-visible notices and summaries.

## Private Field Projection (`projectPublicFields`)
- Recursively removes any key in `PRIVATE_FIELD_KEYS` (case/underscore/dash-normalised), including `secret`, `private_key`, `seed`, `mnemonic`, `password`, `email`, `phone`, `ssn`, `ip_address`, and prototype-pollution vectors `__proto__`/`constructor`/`prototype`.
- Arrays recurse, objects at any depth are filtered, circular references replaced with `[circular]`, deep nesting truncated with `[truncated]`.
- Survives `JSON.parse` payloads; `token` is intentionally excluded since it is a legitimate vault asset field (e.g., `USDC`).

## Webhook Target Allow-List (`validateWebhookTarget`)
- **Schemes**: defaults to `https:` only; `http:` blocked unless overridden for local dev/tests.
- **Credentials**: rejects `https://user:pass@host`.
- **Ports**: explicit port must be in allow-list (default 443); scheme-default ports otherwise.
- **IP Literals**: rejects IP-literal hosts (`169.254.169.254`, `127.0.0.1`, `::1`, `10.x`) regardless of allow-list (SSRF defence).
- **Host allow-list**: entries starting with `*.` match any subdomain; plain entries match exactly; empty list denies everything (fail-closed).
- Hostnames must not be IP literals; trailing dots are rejected unless allowlisted.

## Webhook Envelopes & Signatures
- Outbound envelope `buildWebhookEnvelope` projects data via `projectPublicFields` and throws if event type not on allow-list (`WEBHOOK_EVENT_TYPES`).
- `signWebhookPayload(secret, body)` HMAC-SHA256 (`sha256=<hex>`).
- `verifyWebhookSignature(secret, body, header)` uses constant-time `crypto.timingSafeEqual`.

## Export Endpoints
- **GET /actions/export?wallet=...&format=csv**: every payload cell escaped via `escapeCsvCell`; Content-Disposition filename sanitised via `sanitizeDownloadFilename`.
- **GET /actions/export?wallet=...&format=json**: `action_payload` projected through `projectPublicFields` so private keys (`secret`, `private_key`, `mnemonic`, etc.) never reach the JSON response; other fields preserved unchanged.
- **GET /actions/:id**: same projection applied to single-action responses.

## Key Test Cases (content-boundaries.spec.ts)
- CSV cells with `=1+1`, `+CMD|' /C calc'!A0`, `-2+3`, `@SUM(A1)` → neutralised with `'` prefix and quoted.
- Leading whitespace before formula → also neutralised.
- Embedded quotes doubled (`"say "hi""` → `"say ""hi"""`).
- CRLF / newline / control characters flattened so rows cannot be split.
- Null/undefined → `""` empty cell.
- Oversized values → truncated with `[truncated]` marker before closing quote.
- `looksLikeSpreadsheetFormula` correctly identifies triggers and ignores normal strings.
- Download filenames with `../../etc/passwd` → `passwd`; `..\\..\\evil.csv` → `evil.csv`.
- HTML in rendered text → escaped to `<script>`.
- Prototype-pollution keys (`__proto__`, `constructor`, `prototype`) dropped from projections.
- Webhook target `169.254.169.254` blocked as `ip_literal_not_allowed` even if allowlisted.
- Redirect-following never occurs (`redirect: "manual"` treated as failure).
- Signature verification: correct signature passes, tampered body or wrong secret fails.
- Unknown webhook event type throws (fail-closed).

## Operational Edge Cases
- **Formula injection via unescaped cells**: mitigated by `escapeCsvCell` + filename sanitisation.
- **Private data leakage in exports/webhooks**: mitigated by `projectPublicFields` applied everywhere responses are built.
- **SSRF via webhook targets**: mitigated by IP-literal rejection + scheme+credential+port+host allow-lists.
- **Control-character/CRLF injection in CSV/text**: mitigated by stripping before export/render.
- **Prototype-pollution via JSON payloads**: mitigated by dropping `__proto__`/`constructor`/`prototype` keys.

## Files
- `backend/src/services/contentBoundary.ts` — core helpers
- `backend/src/services/webhookDelivery.ts` — delivery with target validation, signing, retry/timeout
- `backend/src/routes/actions.ts` — CSV/JSON export wiring
- `backend/tests/content-boundaries.spec.ts` — unit + integration tests
- `docs/SECURITY_BOUNDARIES.md` — this document