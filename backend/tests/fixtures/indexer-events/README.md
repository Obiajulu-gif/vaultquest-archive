# Indexer event fixtures

Reusable fixtures for every Soroban contract event consumed by the VaultQuest
indexer parser (`src/services/stellarIndexer.ts`, see `defaultXdrDecoder`).

## Layout

One JSON file per event type: `pool_created.json`, `deposit.json`, `drip.json`,
`claim.json`, `withdrawal.json`, `reward.json`, `pause.json`, `config.json`.

Each file has four variants:

- `valid` — a well-formed payload at the current contract event version.
- `malformed` — a payload whose `value` cannot be parsed as JSON (uses
  `rawValue`, a raw string, instead of `value`, an object) — exercises the
  parser's error path.
- `legacyVersion` — a well-formed payload using an older `version` field the
  parser must still normalize.
- `unknownVersion` — a well-formed payload using a `version` the parser has
  never seen, to confirm unknown versions don't crash decoding.

Fixtures store the pre-encoding `topic` string and `value` object/string
rather than base64-encoded XDR blobs, so they stay readable and diffable.
`tests/helpers/indexerFixtures.ts` turns a fixture entry into a
`RawHorizonEvent` by base64-encoding `topic` and `value`/`rawValue` the same
way the real Soroban RPC event source would.

## Updating fixtures after a contract event schema changes

1. Add or update the relevant `value` shape in the affected event type's JSON
   file(s) — bump `version` in the `valid` fixture to the new contract event
   version, and move the previous `valid` shape into `legacyVersion` (or add
   a new `unknownVersion` fixture if you're intentionally testing forward
   compatibility).
2. Run `npx vitest run tests/indexer-parser-fixtures.spec.ts` and update the
   parser (`defaultXdrDecoder` or its successor) until normalized output
   matches expectations for both the new and legacy shapes.
3. Never delete a `legacyVersion` fixture when bumping the version — the
   parser must keep normalizing older on-chain events that predate the
   schema change.
