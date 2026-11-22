import { describe, it, expect } from "vitest";
import { Amount, InvalidAmountError } from "../src/amount.js";

const POOL_ASSET = "XLM";
const DECIMALS = 7;
const ITERATIONS = 500;
const DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];
const MALFORMED_CHARS = [" ", "-", "+", ".", "e", "E", "x", "a", "\t", "\n", "\u0000"];

function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function pick<T>(items: readonly T[], random: () => number): T {
  return items[Math.floor(random() * items.length)];
}

function randomDigits(random: () => number): string {
  const length = 1 + Math.floor(random() * 30);
  let value = "";
  for (let i = 0; i < length; i++) value += pick(DIGITS, random);
  return value;
}

function mutate(value: string, random: () => number): string {
  const position = Math.floor(random() * (value.length + 1));
  return value.slice(0, position) + pick(MALFORMED_CHARS, random) + value.slice(position);
}

function randomMalformedString(random: () => number): string {
  const length = Math.floor(random() * 20);
  let value = "";
  for (let i = 0; i < length; i++) value += pick(MALFORMED_CHARS, random);
  return value;
}

function expectAmountOrInvalidAmount(amount: unknown): void {
  try {
    const parsed = Amount.fromPayload({ amount: amount as string }, POOL_ASSET, DECIMALS);
    expect(parsed.raw >= 0n).toBe(true);
  } catch (err) {
    expect(err).toBeInstanceOf(InvalidAmountError);
  }
}

describe("Amount.fromPayload fuzzing (#963)", () => {
  it("accepts or rejects random malformed strings without throwing anything else", () => {
    const random = createSeededRandom(0x5eed);

    for (let i = 0; i < ITERATIONS; i++) {
      expectAmountOrInvalidAmount(randomMalformedString(random));
    }
  });

  it("accepts or rejects single-character mutations of valid amounts without throwing anything else", () => {
    const random = createSeededRandom(0xc0ffee);

    for (let i = 0; i < ITERATIONS; i++) {
      expectAmountOrInvalidAmount(mutate(randomDigits(random), random));
    }
  });

  it("accepts boundary numeric values as exact minor units", () => {
    expect(Amount.fromPayload({ amount: 0 }, POOL_ASSET, DECIMALS).raw).toBe(0n);
    expect(Amount.fromPayload({ amount: Number.MAX_SAFE_INTEGER }, POOL_ASSET, DECIMALS).raw).toBe(
      9007199254740991n,
    );
    expect(Amount.fromPayload({ amount: "18446744073709551616" }, POOL_ASSET, DECIMALS).raw).toBe(
      2n ** 64n,
    );
  });

  it("rejects non-finite, exponent, fractional, and negative boundary values", () => {
    const rejected: unknown[] = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.MAX_VALUE,
      Number.MIN_VALUE,
      1e21,
      1.5,
      -1,
      "-0.0000001",
      "1e3",
      "",
      " ",
    ];

    for (const amount of rejected) {
      expect(() => Amount.fromPayload({ amount: amount as string }, POOL_ASSET, DECIMALS), String(amount)).toThrow(
        InvalidAmountError,
      );
    }
  });

  it("rejects missing payloads, non-scalar amounts, and an empty asset code", () => {
    expect(() => Amount.fromPayload(null, POOL_ASSET, DECIMALS)).toThrow(InvalidAmountError);
    expect(() => Amount.fromPayload({ amount: null }, POOL_ASSET, DECIMALS)).toThrow(InvalidAmountError);
    expect(() => Amount.fromPayload({ amount: true }, POOL_ASSET, DECIMALS)).toThrow(InvalidAmountError);
    expect(() => Amount.fromPayload({ amount: [] }, POOL_ASSET, DECIMALS)).toThrow(InvalidAmountError);
    expect(() => Amount.fromPayload({ amount: {} }, POOL_ASSET, DECIMALS)).toThrow(InvalidAmountError);
    expect(() => Amount.fromPayload({ amount: "1" }, "", DECIMALS)).toThrow(InvalidAmountError);
  });
});
