/**
 * Parser tests for every Soroban contract event type consumed by the
 * VaultQuest indexer (issue #413), driven by the fixtures in
 * `tests/fixtures/indexer-events/`. These tests exercise `defaultXdrDecoder`
 * directly — no database or LedgerService involved — so they run fast and
 * stay isolated from indexer/ledger reconciliation concerns.
 */

import { describe, it, expect } from "vitest";
import { defaultXdrDecoder } from "../src/services/stellarIndexer.js";
import {
  listFixtureEventTypes,
  loadFixture,
  toRawHorizonEvent
} from "./helpers/indexerFixtures.js";

const EXPECTED_EVENT_TYPES = [
  "pool_created",
  "deposit",
  "drip",
  "claim",
  "withdrawal",
  "reward",
  "pause",
  "config"
];

describe("indexer event fixtures", () => {
  it("has a fixture file for every indexed event type", () => {
    const found = listFixtureEventTypes();
    for (const type of EXPECTED_EVENT_TYPES) {
      expect(found).toContain(type);
    }
  });
});

describe.each(EXPECTED_EVENT_TYPES)("defaultXdrDecoder: %s events", (eventType) => {
  const fixture = loadFixture(eventType);

  it("normalizes a valid payload with the expected `type` and fields", () => {
    const raw = toRawHorizonEvent(fixture.valid);
    const decoded = defaultXdrDecoder.decode(raw);

    expect(decoded.type).toBe(eventType);
    for (const [key, value] of Object.entries(fixture.valid.value ?? {})) {
      expect(decoded[key]).toEqual(value);
    }
  });

  it("normalizes a legacy-version payload without throwing", () => {
    const raw = toRawHorizonEvent(fixture.legacyVersion);
    const decoded = defaultXdrDecoder.decode(raw);

    expect(decoded.type).toBe(eventType);
    expect(decoded.version).toBe(fixture.legacyVersion.value?.version);
  });

  it("normalizes an unknown-version payload without throwing", () => {
    const raw = toRawHorizonEvent(fixture.unknownVersion);
    const decoded = defaultXdrDecoder.decode(raw);

    expect(decoded.type).toBe(eventType);
    expect(decoded.version).toBe(fixture.unknownVersion.value?.version);
  });

  it("fails predictably (never throws) on a malformed payload", () => {
    const raw = toRawHorizonEvent(fixture.malformed);

    let decoded: Record<string, unknown> | undefined;
    expect(() => {
      decoded = defaultXdrDecoder.decode(raw);
    }).not.toThrow();

    // Malformed `value` XDR can't be parsed as JSON, so only `type` survives —
    // the parser degrades gracefully instead of propagating a JSON parse error.
    expect(decoded).toBeDefined();
    expect(decoded!.type).toBe(eventType);
    expect(Object.keys(decoded!)).toEqual(["type"]);
  });

  it("produces a stable decode across repeated calls (idempotent decoding)", () => {
    const raw = toRawHorizonEvent(fixture.valid);
    const first = defaultXdrDecoder.decode(raw);
    const second = defaultXdrDecoder.decode(raw);
    expect(second).toEqual(first);
  });

  it("derives a stable idempotency key (txHash) per event, distinct across event types", () => {
    const raw = toRawHorizonEvent(fixture.valid);
    // The ledger/indexer layer keys idempotency off of `txHash` (see
    // StellarIndexer.tick's `seenInBatch` set and LedgerService.reconcileEvent's
    // unique `pending_events.tx_hash` upsert). Fixtures must produce a distinct,
    // deterministic txHash per event so duplicate delivery of the *same* event
    // is recognized, while different event types are never conflated.
    expect(raw.txHash).toBe(`tx_${fixture.valid.topic}`);
  });
});
