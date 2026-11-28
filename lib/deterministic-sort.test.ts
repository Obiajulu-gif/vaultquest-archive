import { describe, it, expect } from "vitest";
import {
  deterministicSort,
  sortEventEntries,
  sortStatusEntries,
  type EventEntryLike,
  type StatusEntryLike,
} from "./deterministic-sort";

describe("deterministicSort (normal path)", () => {
  it("orders ascending by the primary key", () => {
    const items = [{ id: "b", key: 2 }, { id: "a", key: 1 }, { id: "c", key: 3 }];
    const sorted = deterministicSort(items, { primary: (i) => i.key, tieBreaker: (i) => i.id });
    expect(sorted.map((i) => i.id)).toEqual(["a", "b", "c"]);
  });

  it("orders descending when requested", () => {
    const items = [{ id: "a", key: 1 }, { id: "b", key: 2 }, { id: "c", key: 3 }];
    const sorted = deterministicSort(items, {
      primary: (i) => i.key,
      primaryOrder: "desc",
      tieBreaker: (i) => i.id,
    });
    expect(sorted.map((i) => i.id)).toEqual(["c", "b", "a"]);
  });

  it("breaks a tie on the primary key using the tie-breaker, not input order", () => {
    // Deliberately fed in an order that would mislead a plain stable sort
    // with no tie-breaker: z before a, both sharing the same primary key.
    const items = [{ id: "z", key: 5 }, { id: "a", key: 5 }, { id: "m", key: 5 }];
    const sorted = deterministicSort(items, { primary: (i) => i.key, tieBreaker: (i) => i.id });
    expect(sorted.map((i) => i.id)).toEqual(["a", "m", "z"]);
  });

  it("does not mutate the input array", () => {
    const items = [{ id: "b", key: 2 }, { id: "a", key: 1 }];
    const copy = [...items];
    deterministicSort(items, { primary: (i) => i.key, tieBreaker: (i) => i.id });
    expect(items).toEqual(copy);
  });
});

describe("deterministicSort (failure path: malformed/missing primary keys)", () => {
  it("sorts an entry with an undefined primary key after every known value", () => {
    const items = [
      { id: "unknown", key: undefined },
      { id: "known-2", key: 2 },
      { id: "known-1", key: 1 },
    ];
    const sorted = deterministicSort(items, { primary: (i) => i.key, tieBreaker: (i) => i.id });
    expect(sorted.map((i) => i.id)).toEqual(["known-1", "known-2", "unknown"]);
  });

  it("sorts an entry with NaN as its primary key after every known value, not at the start", () => {
    const items = [
      { id: "nan", key: Number.NaN },
      { id: "known", key: 0 },
    ];
    const sorted = deterministicSort(items, { primary: (i) => i.key, tieBreaker: (i) => i.id });
    expect(sorted.map((i) => i.id)).toEqual(["known", "nan"]);
  });

  it("falls back to the tie-breaker alone when every primary key is unknown", () => {
    const items = [
      { id: "z", key: undefined },
      { id: "a", key: undefined },
    ];
    const sorted = deterministicSort(items, { primary: (i) => i.key, tieBreaker: (i) => i.id });
    expect(sorted.map((i) => i.id)).toEqual(["a", "z"]);
  });

  it("never throws for an empty list", () => {
    expect(deterministicSort([], { primary: () => 0, tieBreaker: () => "" })).toEqual([]);
  });
});

describe("deterministicSort (retry path: idempotent and order-independent)", () => {
  it("produces the same output whatever order the same items arrive in", () => {
    const options = { primary: (i: { id: string; key: number }) => i.key, tieBreaker: (i: { id: string }) => i.id };
    const a = { id: "a", key: 1 };
    const b = { id: "b", key: 1 };
    const c = { id: "c", key: 2 };

    const first = deterministicSort([c, a, b], options).map((i) => i.id);
    const second = deterministicSort([b, c, a], options).map((i) => i.id);
    const third = deterministicSort([a, b, c], options).map((i) => i.id);

    expect(first).toEqual(["a", "b", "c"]);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  it("sorting an already-sorted result again changes nothing", () => {
    const options = { primary: (i: { key: number }) => i.key, tieBreaker: (i: { id: string }) => i.id };
    const items = [{ id: "a", key: 1 }, { id: "b", key: 2 }];
    const once = deterministicSort(items, options);
    const twice = deterministicSort(once, options);
    expect(twice).toEqual(once);
  });
});

describe("sortStatusEntries", () => {
  const entry = (id: string, statusChangedAt: number): StatusEntryLike => ({ id, statusChangedAt });

  it("orders newest-first", () => {
    const entries = [entry("old", 100), entry("new", 300), entry("mid", 200)];
    expect(sortStatusEntries(entries).map((e) => e.id)).toEqual(["new", "mid", "old"]);
  });

  it("breaks a same-instant tie by id, deterministically", () => {
    const entries = [entry("z", 100), entry("a", 100)];
    expect(sortStatusEntries(entries).map((e) => e.id)).toEqual(["a", "z"]);
  });
});

describe("sortEventEntries", () => {
  const entry = (id: string, occurredAt: number): EventEntryLike => ({ id, occurredAt });

  it("orders oldest-first (reading order for a history log)", () => {
    const entries = [entry("third", 300), entry("first", 100), entry("second", 200)];
    expect(sortEventEntries(entries).map((e) => e.id)).toEqual(["first", "second", "third"]);
  });

  it("breaks a same-instant tie by id, deterministically", () => {
    const entries = [entry("z", 500), entry("a", 500)];
    expect(sortEventEntries(entries).map((e) => e.id)).toEqual(["a", "z"]);
  });
});
