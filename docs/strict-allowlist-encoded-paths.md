# Strict allow-list encoded-path handling (#1162)

Filename validation now decodes percent-encoding up to three passes before extension and path checks. This prevents encoded and double-encoded separators from bypassing the existing filename boundary when a downstream layer performs URL decoding.

## Policy

- Reject malformed percent-encoding.
- Reject decoded forward/back slashes, parent-directory markers, and control characters.
- Retain the existing extension, MIME alignment, length, null-byte, and dangerous-extension checks.
- Preserve the accepted filename as supplied after the existing trim behavior; validation does not rewrite a caller's filename or alter public destination types.

## Recovery and rollback

A rejected filename returns the existing `FILE_TYPE_NOT_ALLOWED` code. Callers should submit a plain basename (for example, `activity-export.json`) rather than an encoded path. If a legitimate integration relied on percent-encoded characters, review it and update the caller to provide a canonical basename; do not weaken the global fail-closed check.

No schema or API response migration is required.

## Authorization

Destination allow-list validation remains a policy check, not an authorization substitute. Existing route-level authentication and destination ownership checks remain in force.

## Verification

Run `pnpm --filter backend exec vitest run tests/strictAllowlist.spec.ts`. Tests cover encoded separators, double encoding, malformed escapes, and existing URL/file/destination allow-list behavior.
