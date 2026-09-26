import { describe, it, expect } from "vitest";
import { Amount, InvalidAmountError, MixedAssetSumError } from "../src/amount.js";

describe("Amount.fromPayload (#504)", () => {
  it("parses a plain integer string amount", () => {
    const amount = Amount.fromPayload({ amount: "1000000" }, "USDC", 7);
    expect(amount.raw).toBe(1000000n);
    expect(amount.assetCode).toBe("USDC");
    expect(amount.decimals).toBe(7);
  });

  it("parses a plain integer number amount", () => {
    const amount = Amount.fromPayload({ amount: 42 }, "USDC", 7);
    expect(amount.raw).toBe(42n);
  });

  it("handles amounts beyond Number.MAX_SAFE_INTEGER without precision loss", () => {
    // i128 stroop values can exceed 2^53 - 1 (Number.MAX_SAFE_INTEGER).
    const huge = "123456789012345678901234567890";
    const amount = Amount.fromPayload({ amount: huge }, "USDC", 7);
    expect(amount.raw).toBe(BigInt(huge));
    expect(amount.raw.toString()).toBe(huge);
  });

  it("rejects a fractional/decimal amount instead of truncating it", () => {
    // The old parseInt-based code silently truncated "12.75" to 12 — that
    // must now be a hard rejection, not a silent floor.
    expect(() => Amount.fromPayload({ amount: "12.75" }, "USDC", 7)).toThrow(InvalidAmountError);
  });

  it("rejects a missing amount field", () => {
    expect(() => Amount.fromPayload({}, "USDC", 7)).toThrow(InvalidAmountError);
  });

  it("rejects a missing payload entirely", () => {
    expect(() => Amount.fromPayload(null, "USDC", 7)).toThrow(InvalidAmountError);
    expect(() => Amount.fromPayload(undefined, "USDC", 7)).toThrow(InvalidAmountError);
  });

  it("rejects a malformed/partial amount string", () => {
    // parseInt("12abc", 10) === 12 (partial parse) — must be rejected, not accepted as 12.
    expect(() => Amount.fromPayload({ amount: "12abc" }, "USDC", 7)).toThrow(InvalidAmountError);
    expect(() => Amount.fromPayload({ amount: "abc" }, "USDC", 7)).toThrow(InvalidAmountError);
    expect(() => Amount.fromPayload({ amount: "" }, "USDC", 7)).toThrow(InvalidAmountError);
  });

  it("rejects a non-string/number amount type", () => {
    expect(() => Amount.fromPayload({ amount: {} }, "USDC", 7)).toThrow(InvalidAmountError);
    expect(() => Amount.fromPayload({ amount: [1, 2] }, "USDC", 7)).toThrow(InvalidAmountError);
    expect(() => Amount.fromPayload({ amount: true }, "USDC", 7)).toThrow(InvalidAmountError);
  });

  it("rejects a negative amount", () => {
    expect(() => Amount.fromPayload({ amount: "-100" }, "USDC", 7)).toThrow(InvalidAmountError);
  });

  it("rejects when poolAssetCode is empty", () => {
    expect(() => Amount.fromPayload({ amount: "100" }, "", 7)).toThrow(InvalidAmountError);
  });
});

describe("Amount arithmetic (#504)", () => {
  it("adds two amounts of the same asset", () => {
    const a = Amount.fromPayload({ amount: "100" }, "USDC", 7);
    const b = Amount.fromPayload({ amount: "50" }, "USDC", 7);
    expect(a.add(b).raw).toBe(150n);
  });

  it("subtracts two amounts of the same asset", () => {
    const a = Amount.fromPayload({ amount: "100" }, "USDC", 7);
    const b = Amount.fromPayload({ amount: "30" }, "USDC", 7);
    expect(a.subtract(b).raw).toBe(70n);
  });

  it("throws MixedAssetSumError when adding amounts of different assets", () => {
    const usdc = Amount.fromPayload({ amount: "100" }, "USDC", 7);
    const xlm = Amount.fromPayload({ amount: "100" }, "XLM", 7);
    expect(() => usdc.add(xlm)).toThrow(MixedAssetSumError);
  });

  it("throws MixedAssetSumError when subtracting amounts of different assets", () => {
    const usdc = Amount.fromPayload({ amount: "100" }, "USDC", 7);
    const xlm = Amount.fromPayload({ amount: "100" }, "XLM", 7);
    expect(() => usdc.subtract(xlm)).toThrow(MixedAssetSumError);
  });

  it("throws MixedAssetSumError when comparing amounts of different assets", () => {
    const usdc = Amount.fromPayload({ amount: "100" }, "USDC", 7);
    const xlm = Amount.fromPayload({ amount: "100" }, "XLM", 7);
    expect(() => usdc.compare(xlm)).toThrow(MixedAssetSumError);
  });

  it("Amount.sum adds a list of same-asset amounts", () => {
    const amounts = [
      Amount.fromPayload({ amount: "10" }, "USDC", 7),
      Amount.fromPayload({ amount: "20" }, "USDC", 7),
      Amount.fromPayload({ amount: "30" }, "USDC", 7),
    ];
    expect(Amount.sum(amounts, "USDC", 7).raw).toBe(60n);
  });

  it("Amount.sum of an empty list returns zero", () => {
    expect(Amount.sum([], "USDC", 7).raw).toBe(0n);
  });

  it("Amount.sum throws when the list contains mixed assets", () => {
    const amounts = [
      Amount.fromPayload({ amount: "10" }, "USDC", 7),
      Amount.fromPayload({ amount: "20" }, "XLM", 7),
    ];
    expect(() => Amount.sum(amounts, "USDC", 7)).toThrow(MixedAssetSumError);
  });

  it("isPositive reflects the sign of raw", () => {
    expect(Amount.fromPayload({ amount: "1" }, "USDC", 7).isPositive()).toBe(true);
    expect(Amount.fromPayload({ amount: "0" }, "USDC", 7).isPositive()).toBe(false);
  });

  it("compare returns -1, 0, 1 correctly", () => {
    const a = Amount.fromPayload({ amount: "10" }, "USDC", 7);
    const b = Amount.fromPayload({ amount: "20" }, "USDC", 7);
    expect(a.compare(b)).toBe(-1);
    expect(b.compare(a)).toBe(1);
    expect(a.compare(a)).toBe(0);
  });
});

describe("Amount.toDisplayString (#504)", () => {
  it("formats a whole number, still showing the asset's full decimal precision", () => {
    expect(Amount.fromPayload({ amount: "50000000" }, "USDC", 7).toDisplayString()).toBe(
      "5.0000000",
    );
  });

  it("formats a value with a fractional part", () => {
    expect(Amount.fromPayload({ amount: "12345678" }, "USDC", 7).toDisplayString()).toBe(
      "1.2345678",
    );
  });

  it("formats zero decimals correctly", () => {
    expect(Amount.fromPayload({ amount: "42" }, "USDC", 0).toDisplayString()).toBe("42");
  });

  it("formats zero, still showing the asset's full decimal precision", () => {
    expect(Amount.fromPayload({ amount: "0" }, "USDC", 7).toDisplayString()).toBe("0.0000000");
  });
});
