import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface EventSchemaSnapshot {
  namespace: string;
  version: string;
  topics: string[];
  events: Record<string, string[]>;
  optionalFields: Record<string, string[]>;
}

const here = dirname(fileURLToPath(import.meta.url));
const schemaDocPath = resolve(here, "../../contracts/docs/EVENT_SCHEMA.md");
const snapshotPath = resolve(here, "../../contracts/docs/EVENT_SCHEMA.snapshot.json");

function parseRequiredEventRows(markdown: string): Record<string, string[]> {
  const rows = markdown
    .split("\n")
    .filter((line) => /^\| `[^`]+` \|/.test(line));

  return Object.fromEntries(
    rows.map((line) => {
      const columns = line.split("|").map((column) => column.trim());
      const name = columns[1].replaceAll("`", "");
      const fields = columns[3]
        .split(",")
        .map((field) => field.trim().replaceAll("`", ""))
        .filter(Boolean);
      return [name, fields];
    }),
  );
}

function splitRequiredAndOptional(fields: string[]) {
  return {
    required: fields.filter((field) => !field.endsWith("?")),
    optional: fields.filter((field) => field.endsWith("?")).map((field) => field.slice(0, -1)),
  };
}

describe("EVENT_SCHEMA contract", () => {
  it("keeps the documented event table aligned with the checked-in snapshot", async () => {
    const [markdown, snapshotRaw] = await Promise.all([
      readFile(schemaDocPath, "utf8"),
      readFile(snapshotPath, "utf8"),
    ]);
    const snapshot = JSON.parse(snapshotRaw) as EventSchemaSnapshot;
    const documented = parseRequiredEventRows(markdown);

    expect(markdown).toContain(`| \`0\` | \"${snapshot.namespace}\" |`);
    expect(markdown).toContain(`| \`1\` | schema version, currently \"${snapshot.version}\" |`);
    expect(snapshot.topics).toEqual(["namespace", "version", "event_name", "scope"]);

    expect(Object.keys(documented).sort()).toEqual(Object.keys(snapshot.events).sort());

    for (const [eventName, documentedFields] of Object.entries(documented)) {
      const { required, optional } = splitRequiredAndOptional(documentedFields);
      expect(required, `${eventName} required fields changed`).toEqual(snapshot.events[eventName]);
      expect(optional, `${eventName} optional fields changed`).toEqual(
        snapshot.optionalFields[eventName] ?? [],
      );
    }
  });

  it("contains the event groups consumed by the backend indexer and wallet UI", async () => {
    const snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as EventSchemaSnapshot;

    expect(Object.keys(snapshot.events)).toEqual(
      expect.arrayContaining([
        "pool_joined",
        "drip_deposited",
        "withdrawn",
        "payout_selected",
        "paused",
        "recovered",
        "config_changed",
      ]),
    );
  });

  it("requires identity and amount fields for money-moving events", async () => {
    const snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as EventSchemaSnapshot;

    expect(snapshot.events.drip_deposited).toEqual(
      expect.arrayContaining(["pool_id", "wallet", "amount"]),
    );
    expect(snapshot.events.withdrawn).toEqual(
      expect.arrayContaining(["pool_id", "wallet", "amount"]),
    );
    expect(snapshot.events.payout_selected).toEqual(
      expect.arrayContaining(["pool_id", "winner", "amount", "asset", "cycle"]),
    );
  });
});
