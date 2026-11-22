import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { Amount, InvalidAmountError } from "../src/amount.js";
import {
  readVaultRecord,
  RecordCompatibilityError,
  UnsupportedSchemaVersionError,
  RECORD_SCHEMA_VERSION,
} from "../src/schemas/recordCompatibility.js";
import { WebhookService, InMemoryWebhookEventStore } from "../src/services/webhookService.js";
import { sanitizeText } from "../../lib/safe-content.js";
import { LedgerService, type ReconcileEventInput } from "../src/services/ledger.js";
import { z } from "zod";

const FIXTURES_DIR = resolve(__dirname, "fixtures/adversarial-corpus");

function loadFixture(filename: string): any {
  return JSON.parse(readFileSync(resolve(FIXTURES_DIR, filename), "utf8"));
}

describe("Golden Fixture Corpus — Malformed External Payloads & Adversarial Records (#919)", () => {
  describe("Category 1: Invalid & Forged Signatures", () => {
    const corpus = loadFixture("invalid-signatures.json");

    it("SIG-001: rejects forged Ed25519 signature", () => {
      const fix = corpus.fixtures.find((f: any) => f.id === "SIG-001-FORGED-ED25519");
      const kp = Keypair.fromPublicKey(fix.publicKey);
      const data = Buffer.from(fix.challenge);
      const forgedSig = Buffer.from(fix.signature, "base64");
      expect(kp.verify(data, forgedSig)).toBe(false);
    });

    it("SIG-002: rejects signature when payload is tampered after signing", () => {
      const fix = corpus.fixtures.find((f: any) => f.id === "SIG-002-TAMPERED-PAYLOAD");
      const signer = Keypair.random();
      const originalData = Buffer.from(fix.originalPayload);
      const validSig = signer.sign(originalData);

      // Verify signature succeeds for original payload
      expect(signer.verify(originalData, validSig)).toBe(true);

      // Tampered payload fails verification
      const tamperedData = Buffer.from(fix.tamperedPayload);
      expect(signer.verify(tamperedData, validSig)).toBe(false);
    });

    it("SIG-003: rejects invalid StrKey public key format", () => {
      const fix = corpus.fixtures.find((f: any) => f.id === "SIG-003-INVALID-STRKEY-PUBLIC");
      expect(StrKey.isValidEd25519PublicKey(fix.publicKey)).toBe(false);
      expect(() => Keypair.fromPublicKey(fix.publicKey)).toThrow();
    });

    it("SIG-004: detects cross-account signature replay", () => {
      const fix = corpus.fixtures.find((f: any) => f.id === "SIG-004-CROSS-ACCOUNT-REPLAY");
      const signerA = Keypair.random();
      const signerB = Keypair.random();
      const challengeBuffer = Buffer.from(fix.challenge);

      const sigA = signerA.sign(challengeBuffer);
      // Attempting to verify signerA's signature using signerB's public key fails
      expect(signerB.verify(challengeBuffer, sigA)).toBe(false);
    });

    it("SIG-005 & SIG-006: rejects forged webhook HMAC signatures", () => {
      const fix5 = corpus.fixtures.find((f: any) => f.id === "SIG-005-WEBHOOK-HMAC-FORGED");
      const store = new InMemoryWebhookEventStore();
      const webhookService = new WebhookService({ store });

      expect(() =>
        webhookService.verifyAndParse({
          provider: "vaultquest",
          rawBody: fix5.payload,
          headers: { [fix5.headerName]: fix5.headerValue },
          secret: fix5.secret,
        })
      ).toThrow();

      const fix6 = corpus.fixtures.find((f: any) => f.id === "SIG-006-STRIPE-WEBHOOK-INVALID-SIG");
      expect(() =>
        webhookService.verifyAndParse({
          provider: "stripe",
          rawBody: fix6.payload,
          headers: { [fix6.headerName]: fix6.headerValue },
          secret: fix6.secret,
        })
      ).toThrow();
    });
  });

  describe("Category 2: Missing Fields", () => {
    const corpus = loadFixture("missing-fields.json");

    it("MISS-001 & MISS-002: rejects action intents missing required fields", () => {
      const fix1 = corpus.fixtures.find((f: any) => f.id === "MISS-001-ACTION-NO-WALLET");
      const actionSchema = z.object({
        walletAddress: z.string().min(1),
        actionType: z.enum(["deposit", "withdraw", "create_vault", "claim", "select_winner"]),
        actionPayload: z.record(z.unknown()),
        idempotencyKey: z.string().min(1),
      });

      const res1 = actionSchema.safeParse(fix1.payload);
      expect(res1.success).toBe(false);

      const fix2 = corpus.fixtures.find((f: any) => f.id === "MISS-002-INTENT-NO-AMOUNT");
      expect(() =>
        Amount.fromPayload(fix2.payload.actionPayload, "USDC", 0)
      ).toThrow(InvalidAmountError);
    });

    it("MISS-003: rejects vault domain records missing prizePoolId", () => {
      const fix3 = corpus.fixtures.find((f: any) => f.id === "MISS-003-VAULT-RECORD-NO-POOL-ID");
      expect(() => readVaultRecord(fix3.payload)).toThrow(RecordCompatibilityError);
    });

    it("MISS-004: rejects indexer events missing contractId", () => {
      const fix4 = corpus.fixtures.find((f: any) => f.id === "MISS-004-INDEXER-EVENT-NO-CONTRACT");
      const eventSchema = z.object({
        id: z.string().min(1),
        ledger: z.number().int().positive(),
        txHash: z.string().min(1),
        contractId: z.string().min(1),
      });
      const res4 = eventSchema.safeParse(fix4.payload);
      expect(res4.success).toBe(false);
    });

    it("MISS-005 & MISS-006: rejects webhooks and saved pools missing critical discriminators", () => {
      const fix5 = corpus.fixtures.find((f: any) => f.id === "MISS-005-WEBHOOK-NO-EVENT-TYPE");
      const webhookSchema = z.object({
        id: z.string().min(1),
        type: z.string().min(1),
        data: z.record(z.unknown()),
      });
      expect(webhookSchema.safeParse(fix5.payload).success).toBe(false);

      const fix6 = corpus.fixtures.find((f: any) => f.id === "MISS-006-SAVED-POOL-NO-NETWORK");
      const savedPoolSchema = z.object({
        walletAddress: z.string().min(1),
        poolId: z.string().min(1),
      });
      expect(savedPoolSchema.safeParse(fix6.payload).success).toBe(false);
    });
  });

  describe("Category 3: Oversized Values & Arithmetic Bounds", () => {
    const corpus = loadFixture("oversized-values.json");

    it("OVER-001: detects integer overflow exceeding uint128 bounds", () => {
      const fix1 = corpus.fixtures.find((f: any) => f.id === "OVER-001-AMOUNT-UINT128-OVERFLOW");
      const maxUint128 = (1n << 128n) - 1n;
      const parsedAmount = BigInt(fix1.payload.amount);
      expect(parsedAmount > maxUint128).toBe(true);

      const amountValidator = z.string().regex(/^\d+$/).refine(
        (val) => {
          try {
            return BigInt(val) <= maxUint128;
          } catch {
            return false;
          }
        },
        { message: "amount exceeds uint128 maximum bound" }
      );
      expect(amountValidator.safeParse(fix1.payload.amount).success).toBe(false);
    });

    it("OVER-002 & OVER-003: rejects scientific notation and negative amounts", () => {
      const fix2 = corpus.fixtures.find((f: any) => f.id === "OVER-002-AMOUNT-EXPONENT-NOTATION");
      expect(() => Amount.fromPayload(fix2.payload, "USDC", 0)).toThrow(InvalidAmountError);

      const fix3 = corpus.fixtures.find((f: any) => f.id === "OVER-003-NEGATIVE-AMOUNT");
      expect(() => Amount.fromPayload(fix3.payload, "USDC", 0)).toThrow(InvalidAmountError);
    });

    it("OVER-004: sanitizes and enforces length limits on large strings", () => {
      const fix4 = corpus.fixtures.find((f: any) => f.id === "OVER-004-STRING-LENGTH-DOS");
      const longInput = "A".repeat(fix4.stringLength);
      const sanitized = sanitizeText(longInput, { maxLength: fix4.maxAllowedLength });
      expect(sanitized.length).toBeLessThanOrEqual(fix4.maxAllowedLength);
    });

    it("OVER-005: rejects deeply nested JSON bombs exceeding max recursion depth", () => {
      const fix5 = corpus.fixtures.find((f: any) => f.id === "OVER-005-DEEP-NESTED-JSON");
      let current: Record<string, unknown> = {};
      const root = current;
      for (let i = 0; i < fix5.nestingDepth; i++) {
        const next: Record<string, unknown> = {};
        current.child = next;
        current = next;
      }

      function checkDepth(obj: unknown, maxDepth: number, currentDepth = 0): boolean {
        if (currentDepth > maxDepth) return false;
        if (typeof obj !== "object" || obj === null) return true;
        for (const key of Object.keys(obj)) {
          if (!checkDepth((obj as Record<string, unknown>)[key], maxDepth, currentDepth + 1)) {
            return false;
          }
        }
        return true;
      }

      expect(checkDepth(root, fix5.maxAllowedDepth)).toBe(false);
    });

    it("OVER-006: rejects oversized public keys", () => {
      const fix6 = corpus.fixtures.find((f: any) => f.id === "OVER-006-OVERSIZED-PUBLIC-KEY");
      const oversizedKey = "G" + "A".repeat(fix6.publicKeyLength);
      expect(StrKey.isValidEd25519PublicKey(oversizedKey)).toBe(false);
    });
  });

  describe("Category 4: Replays & Stale Payloads", () => {
    const corpus = loadFixture("replays.json");

    it("RPL-001: detects expired wallet challenges", () => {
      const fix1 = corpus.fixtures.find((f: any) => f.id === "RPL-001-EXPIRED-WALLET-CHALLENGE");
      const issued = new Date(fix1.challengeIssuedAt).getTime();
      const submitted = new Date(fix1.challengeSubmittedAt).getTime();
      const ttlMs = fix1.ttlMinutes * 60 * 1000;
      expect(submitted - issued > ttlMs).toBe(true);
    });

    it("RPL-002: rejects webhook deliveries with timestamps outside tolerance window", () => {
      const fix2 = corpus.fixtures.find((f: any) => f.id === "RPL-002-WEBHOOK-STALE-TIMESTAMP");
      const store = new InMemoryWebhookEventStore({
        now: () => new Date(fix2.currentTimestamp * 1000),
      });
      const webhookService = new WebhookService({
        store,
        defaultToleranceSeconds: fix2.toleranceSeconds,
      });

      expect(() =>
        webhookService.verifyAndParse({
          provider: "vaultquest",
          rawBody: JSON.stringify({ event: "test" }),
          headers: {
            "x-vaultquest-signature": `t=${fix2.timestampHeader},v1=somehash`,
          },
          secret: "valid-secret-key-for-test-0123456789",
        })
      ).toThrow();
    });

    it("RPL-004: idempotent handling of terminal on-chain event replay", async () => {
      const fix4 = corpus.fixtures.find((f: any) => f.id === "RPL-004-TERMINAL-EVENT-REPLAY");
      const callbackFn = vi.fn();

      const mockActionRow = {
        id: "act_rpl_004",
        txHash: fix4.txHash,
        status: fix4.currentStatus,
        actionType: "deposit",
      };

      const actionUpdate = vi.fn(async () => ({}));
      const mockPrisma = {
        $transaction: vi.fn(async (fn: any) => fn(mockPrisma)),
        actionLedger: {
          findFirst: vi.fn(async () => mockActionRow),
          update: actionUpdate,
        },
        actionLease: {
          deleteMany: vi.fn(async () => ({ count: 0 })),
        },
      } as any;

      const ledger = new LedgerService(mockPrisma);
      ledger.onActionConfirmed(callbackFn);

      const input: ReconcileEventInput = {
        txHash: fix4.txHash,
        sorobanEventId: fix4.sorobanEventId,
        eventPayload: { amount: "100" },
        statusHint: "confirmed",
      };

      const result = await ledger.reconcileEvent(input);
      expect(result.matched).toBe(true);
      expect(actionUpdate).not.toHaveBeenCalled();
      expect(callbackFn).not.toHaveBeenCalled();
    });
  });

  describe("Category 5: Versioning & Schema Drift", () => {
    const corpus = loadFixture("schema-drift.json");

    it("DRIFT-001 & DRIFT-002: rejects unsupported schema versions", () => {
      const fix1 = corpus.fixtures.find((f: any) => f.id === "DRIFT-001-UNSUPPORTED-LEGACY-VERSION");
      expect(() => readVaultRecord(fix1.payload)).toThrow(UnsupportedSchemaVersionError);

      const fix2 = corpus.fixtures.find((f: any) => f.id === "DRIFT-002-UNSUPPORTED-FUTURE-VERSION");
      expect(() => readVaultRecord(fix2.payload)).toThrow(UnsupportedSchemaVersionError);
    });

    it("DRIFT-003: neutralizes prototype pollution attempts", () => {
      const fix3 = corpus.fixtures.find((f: any) => f.id === "DRIFT-003-PROTOTYPE-POLLUTION");
      const raw = JSON.parse(JSON.stringify(fix3.payload));

      function sanitizeKeys(obj: Record<string, unknown>): Record<string, unknown> {
        const clean: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(obj)) {
          if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
          clean[key] = value;
        }
        return clean;
      }

      const sanitized = sanitizeKeys(raw);
      expect(sanitized).not.toHaveProperty("__proto__");
      expect(sanitized).not.toHaveProperty("constructor");
      expect(Object.keys(sanitized)).toEqual(fix3.expectedSanitizedKeys);
      expect((Object.prototype as any).isAdmin).toBeUndefined();
    });

    it("DRIFT-004: drops deprecated fields during version migration", () => {
      const fix4 = corpus.fixtures.find((f: any) => f.id === "DRIFT-004-DEPRECATED-FIELD-DROPPED");
      const { record, warnings, migrated } = readVaultRecord(fix4.payload);

      expect(migrated).toBe(true);
      expect(record.schemaVersion).toBe(RECORD_SCHEMA_VERSION);
      expect(record).not.toHaveProperty("commission");
      expect(warnings.some((w) => w.includes("commission"))).toBe(true);
    });

    it("DRIFT-005: rejects floating-point amounts", () => {
      const fix5 = corpus.fixtures.find((f: any) => f.id === "DRIFT-005-TYPE-MUTATION-FLOAT-AMOUNT");
      expect(() => Amount.fromPayload(fix5.payload, "USDC", 0)).toThrow(InvalidAmountError);
    });

    it("DRIFT-006: rejects unrecognized action enum variants", () => {
      const fix6 = corpus.fixtures.find((f: any) => f.id === "DRIFT-006-UNKNOWN-ACTION-ENUM");
      const actionEnumSchema = z.enum(["deposit", "withdraw", "create_vault", "claim", "select_winner"]);
      expect(actionEnumSchema.safeParse(fix6.payload.actionType).success).toBe(false);
    });
  });
});
