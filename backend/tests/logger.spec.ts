import { describe, it, expect } from "vitest";
import { Writable } from "node:stream";
import { createLogger } from "../src/logger.js";

describe("createLogger", () => {
  it("returns a logger with child() support", () => {
    const log = createLogger("info");
    expect(typeof log.info).toBe("function");
    const child = log.child({ correlation_id: "abc" });
    expect(typeof child.info).toBe("function");
  });

  it("redacts user identifiers and payloads while preserving safe correlation IDs", async () => {
    let output = "";
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    const log = createLogger("info", destination);
    log.info({
      walletAddress: "G".repeat(56),
      tx_hash: "a".repeat(64),
      correlation_id: "corr-123",
      nested: { email: "person@example.test", payload: { privateNote: "do-not-log" }, authorization: "Bearer secret" },
    }, "safe event");
    await new Promise<void>((resolve) => log.flush(() => resolve()));

    expect(output).toContain("[REDACTED]");
    expect(output).toContain("corr-123");
    expect(output).not.toContain("G".repeat(56));
    expect(output).not.toContain("a".repeat(64));
    expect(output).not.toContain("person@example.test");
    expect(output).not.toContain("do-not-log");
    expect(output).not.toContain("Bearer secret");
  });
});
