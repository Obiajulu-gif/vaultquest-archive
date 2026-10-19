import { describe, it, expect } from "vitest";
import { Writable } from "node:stream";
import { createLogger } from "../src/logger.js";
import { createRedactionMiddleware } from "../src/middleware/redaction.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { DataExportService } from "../src/services/dataExport.js";
import type { ActionRecord } from "../src/types.js";

const WALLET = "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW";
const SECRET = "sk_live_do_not_leak";

describe("redaction (#982)", () => {
  describe("logs", () => {
    it("redacts identifiers and secret-bearing keys but keeps safe correlation ids", () => {
      const lines: string[] = [];
      const stream = new Writable({
        write(chunk, _enc, cb) {
          lines.push(chunk.toString());
          cb();
        },
      });
      const logger = createLogger("info", stream);

      logger.info(
        {
          correlationId: "corr-safe-1",
          walletAddress: WALLET,
          payload: { secret: SECRET, amount: "10" },
          nested: { accessToken: SECRET },
        },
        "incoming request",
      );

      const out = lines.join("\n");
      expect(out).not.toContain(WALLET);
      expect(out).not.toContain(SECRET);
      expect(out).toContain("[REDACTED]");
      // Safe, non-identifying fields survive so logs stay useful.
      expect(out).toContain("corr-safe-1");
    });

    it("redacts wallet addresses and transaction hashes through the shared middleware", () => {
      const redact = createRedactionMiddleware({} as never);
      const out = redact({ walletAddress: WALLET, txHash: "a".repeat(64), status: "confirmed" });
      expect(out.walletAddress).toMatch(/^\[REDACTED_WALLET:[0-9a-f]{16}\]$/);
      expect(out.txHash).toMatch(/^\[REDACTED_TX:[0-9a-f]{16}\]$/);
      expect(out.status).toBe("confirmed");
    });
  });

  describe("error responses", () => {
    function makeReply() {
      const state: { statusCode: number; payload: unknown; headers: Record<string, string> } = {
        statusCode: 200,
        payload: undefined,
        headers: {},
      };
      const reply = {
        state,
        status(code: number) {
          state.statusCode = code;
          return this;
        },
        send(payload: unknown) {
          state.payload = payload;
          return this;
        },
        header(key: string, value: string) {
          state.headers[key] = value;
          return this;
        },
      };
      return reply;
    }

    it("never leaks an internal error message or secret to the client", () => {
      const reply = makeReply();
      const req = { correlationId: "corr-err-1", log: { error() {} }, url: "/api/pools" } as never;

      errorHandler(new Error(`failure at /etc/passwd token=${SECRET}`) as never, req, reply as never);

      const body = JSON.stringify(reply.state.payload);
      expect(reply.state.statusCode).toBe(500);
      expect(body).not.toContain(SECRET);
      expect(body).not.toContain("/etc/passwd");
      expect((reply.state.payload as { error: { error_id: string } }).error.error_id).toBe("corr-err-1");
    });
  });

  describe("exports", () => {
    it("drops scrubbed rows and only emits allowlisted fields", async () => {
      const live: ActionRecord = {
        id: "a1",
        walletAddress: WALLET,
        actionType: "deposit",
        actionPayload: { amount: "10", token: "USDC", vault_id: "p1" },
        status: "confirmed",
        txHash: "deadbeef",
        errorCode: null,
        idempotencyKey: "secret-idempotency-key",
        correlationId: "corr",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        submittedAt: null,
        confirmedAt: null,
        sorobanEventId: null,
        redactedAt: null,
      } as unknown as ActionRecord;
      const scrubbed = { ...live, id: "a2", redactedAt: new Date("2026-01-02T00:00:00.000Z") } as ActionRecord;

      const source = {
        listActions: async () => ({ items: [live, scrubbed], nextCursor: null }),
        listSavedPools: async () => ({ items: [], nextCursor: null }),
      };
      const service = new DataExportService(source as never, { logAccess() {} } as never);

      const bundle = await service.build({
        principal: { subject: "s1", role: "user", walletAddress: WALLET } as never,
        wallet: WALLET,
      });

      expect(bundle.data.actions).toHaveLength(1);
      const serialized = JSON.stringify(bundle.data);
      expect(serialized).not.toContain("secret-idempotency-key");
      expect(serialized).not.toContain("corr");
      expect(Object.keys(bundle.data.actions![0] as object)).not.toContain("idempotencyKey");
    });
  });
});
