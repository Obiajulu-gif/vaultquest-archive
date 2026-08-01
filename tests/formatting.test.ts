import { describe, it, expect } from "vitest";
import { parseAssetAmount, formatAssetAmount } from "@/lib/formatting";

describe("shared asset decimal formatting utility", () => {
  describe("parseAssetAmount", () => {
    it("parses asset amounts to bigint base units correctly based on asset decimals", () => {
      expect(parseAssetAmount("10.5", "XLM")).toBe(10500000n); // 7 decimals
      expect(parseAssetAmount("1.234567", "XLM")).toBe(1234567n);
      expect(parseAssetAmount("10.5", "USDC")).toBe(10500000n); // 6 decimals
      expect(parseAssetAmount("100", "ETH")).toBe(100000000000000000000n); // 18 decimals
    });

    it("handles boundary values and invalid inputs safely", () => {
      expect(parseAssetAmount("", "USDC")).toBe(0n);
      expect(parseAssetAmount("invalid", "XLM")).toBe(0n);
      expect(parseAssetAmount("0", "SOL")).toBe(0n);
    });
  });

  describe("formatAssetAmount", () => {
    it("formats bigint base units correctly", () => {
      expect(formatAssetAmount(10500000n, "XLM")).toBe("1.050000 XLM");
      expect(formatAssetAmount(10500000n, "USDC")).toBe("10.50 USDC");
    });

    it("formats number and string values correctly", () => {
      expect(formatAssetAmount(123.456, "USDC")).toBe("123.46 USDC");
      expect(formatAssetAmount("123.456", "XLM")).toBe("123.456000 XLM");
    });

    it("respects roundingMode options (floor, ceil, round)", () => {
      expect(formatAssetAmount(1.237, "USDC", { roundingMode: "floor" })).toBe("1.23 USDC");
      expect(formatAssetAmount(1.232, "USDC", { roundingMode: "ceil" })).toBe("1.24 USDC");
      expect(formatAssetAmount(1.235, "USDC", { roundingMode: "round" })).toBe("1.24 USDC");
    });

    it("respects showSymbol and custom digit options", () => {
      expect(formatAssetAmount(12.34, "USDC", { showSymbol: false })).toBe("12.34");
      expect(formatAssetAmount(12.34, "USDC", { minimumFractionDigits: 4 })).toBe("12.3400 USDC");
    });
  });
});
