import { describe, expect, it } from "vitest";
import {
  EditResolutionError,
  compareStamps,
  resolveEdit,
  type FieldEdit,
  type VersionedRecord,
} from "../lib/conflict-resolver";

type Pool = { name: string; tvl: string; drawsAt: Date | null };

const base: VersionedRecord<Pool> = {
  values: { name: "Pool", tvl: "100", drawsAt: null },
  version: 0,
  clocks: {},
};

const edit = (changes: Partial<Pool>, at: number, clientId: string, baseVersion = 0): FieldEdit<Pool> => ({
  baseVersion,
  stamp: { at, clientId },
  changes,
});

/** Applies edits in order, as a server receiving them one by one would. */
const replay = (edits: FieldEdit<Pool>[]) =>
  edits.reduce<VersionedRecord<Pool>>((record, e) => {
    const r = resolveEdit(record, e);
    return { values: r.values, version: r.version, clocks: r.clocks };
  }, base);

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]));
}

describe("deterministic conflict resolver (#983)", () => {
  it("applies an edit composed against the current version", () => {
    const r = resolveEdit(base, edit({ name: "Renamed" }, 10, "tab-a"));
    expect(r).toMatchObject({ version: 1, applied: ["name"], rejected: [], unchanged: [] });
    expect(r.values.name).toBe("Renamed");
    expect(r.clocks.name).toEqual({ version: 1, stamp: { at: 10, clientId: "tab-a" } });
  });

  it("merges concurrent edits to different fields without a conflict", () => {
    const merged = replay([edit({ name: "A" }, 10, "tab-a"), edit({ tvl: "250" }, 5, "tab-b")]);
    expect(merged.values).toEqual({ name: "A", tvl: "250", drawsAt: null });
  });

  it("resolves a concurrent edit to the same field by stamp, not by arrival order", () => {
    const newer = edit({ name: "newer" }, 20, "tab-a");
    const older = edit({ name: "older" }, 10, "tab-b");
    expect(replay([newer, older]).values.name).toBe("newer");
    expect(replay([older, newer]).values.name).toBe("newer");

    const r = resolveEdit(replay([newer]), older);
    expect(r.rejected).toEqual([{ field: "name", winner: { at: 20, clientId: "tab-a" } }]);
    expect(r.version).toBe(1); // a losing edit writes nothing
  });

  it("breaks equal timestamps by client id", () => {
    const a = edit({ tvl: "1" }, 10, "device-a");
    const b = edit({ tvl: "2" }, 10, "device-b");
    expect(replay([a, b]).values.tvl).toBe("2");
    expect(replay([b, a]).values.tvl).toBe("2");
    expect(compareStamps({ at: 10, clientId: "device-a" }, { at: 10, clientId: "device-b" })).toBeLessThan(0);
  });

  it("lets an edit that saw the current value win even with an older (skewed) clock", () => {
    const first = replay([edit({ name: "A" }, 1_000, "tab-a")]);
    const r = resolveEdit(first, edit({ name: "B" }, 5, "tab-b", first.version));
    expect(r.applied).toEqual(["name"]);
    expect(r.values.name).toBe("B");
  });

  it("converges every arrival order of the same concurrent edits to one state", () => {
    const edits = [
      edit({ name: "a", tvl: "1" }, 30, "c1"),
      edit({ name: "b", drawsAt: new Date("2026-11-01T00:00:00Z") }, 40, "c2"),
      edit({ tvl: "3", drawsAt: new Date("2026-12-01T00:00:00Z") }, 35, "c3"),
      edit({ name: "d" }, 40, "c0"),
    ];
    const outcomes = new Set(
      permutations(edits).map((order) => {
        const { values, clocks } = replay(order);
        // Sorted: map key order reflects write order, which is not part of the state.
        const winners = Object.entries(clocks).map(([f, c]) => [f, c!.stamp]).sort(([a], [b]) => String(a).localeCompare(String(b)));
        return JSON.stringify({ values, winners });
      }),
    );
    expect(outcomes.size).toBe(1);
    // name: c2 and c0 tie at 40, "c2" > "c0"; tvl: c3 (35) > c1 (30); drawsAt: c2 (40) > c3 (35).
    expect(JSON.parse([...outcomes][0]!).values).toEqual({ name: "b", tvl: "3", drawsAt: "2026-11-01T00:00:00.000Z" });
  });

  it("treats a retried edit as a no-op", () => {
    const once = replay([edit({ name: "A", drawsAt: new Date("2026-11-01T00:00:00Z") }, 10, "tab-a")]);
    const retry = resolveEdit(once, edit({ name: "A", drawsAt: new Date("2026-11-01T00:00:00Z") }, 10, "tab-a"));
    expect(retry).toMatchObject({ version: once.version, applied: [], rejected: [], unchanged: ["drawsAt", "name"] });
  });

  it("does not let a stale retry resurrect a value another client replaced", () => {
    const first = edit({ name: "A" }, 10, "tab-a");
    const later = edit({ name: "B" }, 20, "tab-b", 1);
    const state = replay([first, later]);
    expect(resolveEdit(state, first).rejected.map((r) => r.field)).toEqual(["name"]);
  });

  it("ignores undefined entries and reports fields in sorted order", () => {
    const r = resolveEdit(base, edit({ tvl: "5", name: undefined, drawsAt: new Date(0) }, 1, "c"));
    expect(r.applied).toEqual(["drawsAt", "tvl"]);
  });

  it("rejects an edit based on a version the record never had", () => {
    expect(() => resolveEdit(base, edit({ name: "x" }, 1, "c", 3))).toThrow(EditResolutionError);
  });
});
