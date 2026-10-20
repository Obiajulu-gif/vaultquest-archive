# Canonical signed and hashed payloads

`src/utils/canonicalJson.ts` defines the backend canonical payload profile used by signed receipts, audit hashes, and prize draw payloads. It sorts object keys at every level, preserves array order, trims strings, lowercases known enum values, and normalizes decimal fields to non-exponent decimal strings. Object values set to `undefined` are omitted; `undefined` array entries serialize as `null`. Dates become ISO strings and bigint values become decimal strings.

Amounts, prizes, weights, and principal/deposit snapshots should be supplied as decimal strings when precision matters. Non-finite values, unsafe integer numbers, malformed decimal strings, excessive numeric exponents, unsupported object types, and duplicate keys created by key trimming are rejected. Keep identifiers and monetary values in their schema-defined types before signing; canonicalization does not validate business rules such as whether a prize is positive.

Key allowlists and denylists apply to top-level fields. An allowlist without `strict` drops other top-level fields. An allowlist with `strict: true` rejects any unknown top-level field. Nested object fields remain part of the canonical payload.

## Compatibility and migration

Existing receipt signatures and audit record hashes were created with the canonical profile already present in this repository. The changes in this branch preserve the serialized form of accepted, safe values. Unsafe integers and unbounded exponents now fail before signing instead of being rounded or causing unbounded expansion. Existing raw JSON proof records remain readable through the draw-proof legacy verification path; new or regenerated records must pass canonicalization before their values are used.

For a stored record that fails canonicalization, retain the original bytes for investigation and verify it with the format/version that originally signed it. Do not silently fall back to signing or hashing the raw payload.

## Examples

These inputs have the same canonical serialization:

```json
{"asset":" USDC ","amount":"001.2500","winner":" GBBD...LLFL "}
```

```json
{"winner":"GBBD...LLFL","amount":"1.25","asset":"usdc"}
```

Both serialize as:

```json
{"amount":"1.25","asset":"usdc","winner":"GBBD...LLFL"}
```

The compatibility fixture in `fixtures/canonical-legacy-payload.json` records an older, reordered payload and its expected canonical form for regression tests.
