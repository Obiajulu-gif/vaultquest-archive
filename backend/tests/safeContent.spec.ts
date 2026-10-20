import { describe, expect, it } from "vitest";
import { safeRequiredText, safeText, safeUrl } from "../src/schemas/safeContent.js";
import { savedPoolRecord } from "../src/schemas/savedPools.js";

describe("safeText", () => {
  it("strips markup and invisible characters", () => {
    expect(safeText(50).parse("Hi <b>there</b>‮!")).toBe("Hi there!");
  });
  it("truncates to the declared max and caps raw input at 4x", () => {
    expect(safeText(5).parse("abcdefgh")).toBe("abcde");
    expect(safeText(5).safeParse("x".repeat(21)).success).toBe(false);
  });
  it("preserves newlines only when multiline", () => {
    expect(safeText(20, { multiline: true }).parse("a\nb")).toBe("a\nb");
    expect(safeText(20).parse("a\nb")).toBe("a b");
  });
});

describe("safeRequiredText", () => {
  it("rejects input that is empty after sanitization", () => {
    expect(safeRequiredText(20).safeParse("<script>x</script>").success).toBe(false);
    expect(safeRequiredText(20).safeParse("   ").success).toBe(false);
    expect(safeRequiredText(20).parse("ok")).toBe("ok");
  });
});

describe("safeUrl", () => {
  it("normalizes safe URLs and rejects unsafe ones", () => {
    expect(safeUrl().parse("https://example.com")).toBe("https://example.com/");
    expect(safeUrl().safeParse("javascript:alert(1)").success).toBe(false);
    expect(safeUrl({ allowedHosts: ["example.com"] }).safeParse("https://evil.com").success).toBe(false);
  });
});

describe("savedPoolRecord.pool_name", () => {
  const base = {
    pool_id: "p",
    pool_name: "Name",
    status: "open",
    tvl: "1",
    asset: "USDC",
    participant_count: 1,
    expected_yield: "4%",
  };
  it("sanitizes markup from pool names", () => {
    expect(savedPoolRecord.parse({ ...base, pool_name: "A<script>x</script>B" }).pool_name).toBe("AB");
  });
  it("rejects names that sanitize to nothing", () => {
    expect(savedPoolRecord.safeParse({ ...base, pool_name: "<img src=x>" }).success).toBe(false);
  });
});
