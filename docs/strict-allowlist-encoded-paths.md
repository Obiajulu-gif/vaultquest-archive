# Strict allow-list encoded-path handling (#1162)

`backend/src/services/strictAllowlistService.ts` now decodes a filename up to
three times (`MAX_FILENAME_DECODE_DEPTH`) before applying the existing
path-traversal, extension, MIME, length, and null-byte checks. The decoded
value is used **for validation only**: the accepted filename returned to the
caller is unchanged, so downstream contracts and stored values are preserved.

## Policy

- Reject malformed percent escapes (for example `report%2.json`) instead of
  letting them reach a storage layer that may interpret them differently.
- Reject decoded forward slashes, backslashes, `..` parent-directory markers,
  C0/C1 control characters, and **any residual `%`** after the bounded decode
  passes. Rejecting residual `%` closes depths beyond three passes (for example
  `%252525252e...`) as well as malformed escapes that are not valid UTF-8
  sequences.
- Keep the existing dangerous/double extension, extension→MIME alignment,
  maximum-length, URL, wallet, and notification-channel checks unchanged.
- Fail closed with the existing `FILE_TYPE_NOT_ALLOWED` code; no new public
  error code or response field is introduced.
- This remains a **policy** check, not an authorization substitute. Route-level
  authentication and destination ownership checks are still required.

## Edge cases

- Multi-encoded paths such as `%252e%252e%255csecret.csv` become `..\secret.csv`
  within three passes and are rejected. Encodings deeper than three passes keep
  a residual `%` and are rejected by the same fail-closed check.
- Legitimate encoded characters (for example `vault%20export.json`) decode to a
  plain basename and are accepted; the returned filename is the original value.
- A bare `%`, truncated escape (`%2`), or non-UTF-8 escape (`%u002e`, `%zz`)
  fails closed rather than being normalized.
- Encoded or literal C0/C1 control characters (`%0A`, `%00`, `\u0007`) are
  rejected before the extension/MIME checks.

## Recovery and rollback

A rejected filename returns `FILE_TYPE_NOT_ALLOWED`. Clients should resubmit a
canonical basename (for example `activity-export.json`) instead of an encoded
path. No schema, persisted record, or API response migration is required; the
change can be rolled back by removing the decode-validation block without
affecting callers that already send plain basenames.

## Verification

`backend/tests/strictAllowlist.spec.ts` covers encoded and multi-encoded
traversal, malformed escapes, control characters, download-destination
rejection, accepted-basename preservation, and repeated (retry) validation.
