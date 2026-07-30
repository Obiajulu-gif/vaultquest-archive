/**
 * Loads the contract-event fixtures in `tests/fixtures/indexer-events/` and
 * turns them into `RawHorizonEvent`s the same way the real Soroban RPC event
 * source would (topic/value base64-encoded XDR blobs).
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { RawHorizonEvent } from "../../src/services/stellarIndexer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "..", "fixtures", "indexer-events");

export type FixtureVariant = "valid" | "malformed" | "legacyVersion" | "unknownVersion";

export interface EventFixtureEntry {
  topic: string;
  value?: Record<string, unknown>;
  rawValue?: string;
  successful: boolean;
}

export interface EventFixtureFile {
  eventType: string;
  valid: EventFixtureEntry;
  malformed: EventFixtureEntry;
  legacyVersion: EventFixtureEntry;
  unknownVersion: EventFixtureEntry;
}

function b64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

/** Lists every fixture file's event type (`pool_created`, `deposit`, ...). */
export function listFixtureEventTypes(): string[] {
  return readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
}

export function loadFixture(eventType: string): EventFixtureFile {
  const raw = readFileSync(path.join(FIXTURES_DIR, `${eventType}.json`), "utf8");
  return JSON.parse(raw) as EventFixtureFile;
}

/**
 * Converts a fixture entry into a `RawHorizonEvent`, base64-encoding the
 * topic and value the same way production XDR payloads are encoded before
 * `defaultXdrDecoder` decodes them.
 */
export function toRawHorizonEvent(
  entry: EventFixtureEntry,
  overrides: Partial<RawHorizonEvent> = {}
): RawHorizonEvent {
  const valueString = entry.rawValue ?? JSON.stringify(entry.value ?? {});
  return {
    id: overrides.id ?? "1",
    ledger: overrides.ledger ?? 100,
    txHash: overrides.txHash ?? `tx_${entry.topic}`,
    contractId: overrides.contractId ?? "CDRIPPOOL",
    topicXdr: overrides.topicXdr ?? [b64(entry.topic)],
    valueXdr: overrides.valueXdr ?? b64(valueString),
    successful: overrides.successful ?? entry.successful
  };
}
