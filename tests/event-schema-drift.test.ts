import { describe, it, expect, vi } from "vitest";
import {
  detectCrossServiceEventDrift,
  validateEventSchema,
  authorizeDriftInspection,
  SchemaDriftAuthError,
  CANONICAL_SOROBAN_SCHEMAS,
  CANONICAL_BACKEND_SCHEMAS,
  type EventEnvelope,
  type DriftAuthContext,
} from "../lib/event-schema-drift";

describe("Cross-Service Event Schema Drift Detection (#1090)", () => {
  const validStellarAddress = "GA2C5RFPE6GCKMY3US5PAB6UZLKIGAHWKXX2G2ZVOUSWJMGWMMZJOGX7";
  const validTxHash = "a".repeat(64);

  const authAdmin: DriftAuthContext = {
    caller: "admin-worker",
    role: "admin",
  };

  describe("Normal Path", () => {
    it("validates conforming Soroban contract events with zero drift", async () => {
      const sorobanEvent: EventEnvelope = {
        topics: ["vaultquest", "v1", "pool_created", "pool_101"],
        payload: {
          pool_id: "pool_101",
          creator: validStellarAddress,
          asset: "XLM",
          target_amount: "500000000",
          opens_at: 1780000000,
          locks_at: 1780100000,
          draws_at: 1780200000,
          admin: validStellarAddress,
          idempotency_key: "idem-create-1",
        },
      };

      const result = await detectCrossServiceEventDrift(
        [{ event: sorobanEvent, schemaKey: "pool_created" }],
        { auth: authAdmin },
      );

      expect(result.passed).toBe(true);
      expect(result.driftCount).toBe(0);
      expect(result.totalEventsChecked).toBe(1);
    });

    it("validates conforming Backend domain events with zero drift", async () => {
      const backendEvent: EventEnvelope = {
        version: "1",
        event_id: "evt_dep_100",
        event_type: "vault_deposit_submitted",
        timestamp: "2026-05-01T12:00:00.000Z",
        wallet_address: validStellarAddress,
        vault_id: "vault_main",
        amount: "10000000",
        tx_hash: validTxHash,
        action_id: "act_999",
        idempotency_key: "idem_submit_999",
      };

      const result = await detectCrossServiceEventDrift(
        [{ event: backendEvent, schemaKey: "vault_deposit_submitted" }],
        { auth: authAdmin },
      );

      expect(result.passed).toBe(true);
      expect(result.driftCount).toBe(0);
    });
  });

  describe("Failure Paths (Drift Types & Severity)", () => {
    it("flags missing required financial fields as critical drift", async () => {
      const brokenDeposit: EventEnvelope = {
        topics: ["vaultquest", "v1", "drip_deposited", "pool_101"],
        payload: {
          pool_id: "pool_101",
          wallet: validStellarAddress,
          // Missing 'amount', 'shares_delta', 'total_deposited', 'tvl'
        },
      };

      const result = await detectCrossServiceEventDrift([
        { event: brokenDeposit, schemaKey: "drip_deposited" },
      ]);

      expect(result.passed).toBe(false);
      expect(result.driftCount).toBeGreaterThanOrEqual(4);

      const amountDrift = result.drifts.find((d) => d.field === "amount");
      expect(amountDrift).toBeDefined();
      expect(amountDrift?.driftType).toBe("MISSING_REQUIRED_FIELD");
      expect(amountDrift?.severity).toBe("critical");
    });

    it("detects field type mismatches", async () => {
      const typeMismatchedEvent: EventEnvelope = {
        topics: ["vaultquest", "v1", "payout_selected", "pool_101"],
        payload: {
          pool_id: "pool_101",
          winner: validStellarAddress,
          round_id: "FOUR", // Should be number!
          amount: 10000, // Should be numeric string!
          asset: "XLM",
          cycle: 1,
        },
      };

      const result = await detectCrossServiceEventDrift([
        { event: typeMismatchedEvent, schemaKey: "payout_selected" },
      ]);

      expect(result.passed).toBe(false);
      const roundIdDrift = result.drifts.find((d) => d.field === "round_id");
      expect(roundIdDrift?.driftType).toBe("TYPE_MISMATCH");

      const amountDrift = result.drifts.find((d) => d.field === "amount");
      expect(amountDrift?.driftType).toBe("TYPE_MISMATCH");
    });

    it("detects Soroban envelope topic divergence", async () => {
      const badEnvelope: EventEnvelope = {
        topics: ["wrong_prefix", "v1", "pool_created"],
        payload: {
          pool_id: "pool_101",
          creator: validStellarAddress,
          asset: "XLM",
          target_amount: "500000000",
          opens_at: 1780000000,
          locks_at: 1780100000,
          draws_at: 1780200000,
          admin: validStellarAddress,
        },
      };

      const drifts = validateEventSchema(badEnvelope, CANONICAL_SOROBAN_SCHEMAS.pool_created);
      const topicDrift = drifts.find((d) => d.driftType === "ENVELOPE_TOPIC_MISMATCH");
      expect(topicDrift).toBeDefined();
      expect(topicDrift?.expected).toBe("vaultquest");
    });

    it("detects unsupported ancient schema version", async () => {
      const oldVersionEvent: EventEnvelope = {
        topics: ["vaultquest", "v0.8.0", "pool_created"],
        payload: {},
      };

      const drifts = validateEventSchema(oldVersionEvent, CANONICAL_SOROBAN_SCHEMAS.pool_created);
      const versionDrift = drifts.find((d) => d.driftType === "UNSUPPORTED_VERSION");
      expect(versionDrift).toBeDefined();
      expect(versionDrift?.severity).toBe("high");
    });

    it("identifies unexpected unversioned fields in strict mode", async () => {
      const extraFieldEvent: EventEnvelope = {
        topics: ["vaultquest", "v1", "paused"],
        payload: {
          scope: "global",
          admin: validStellarAddress,
          reason: "Emergency",
          paused_at: 1780000000,
          unauthorized_secret_field: "injected",
        },
      };

      const drifts = validateEventSchema(extraFieldEvent, CANONICAL_SOROBAN_SCHEMAS.paused, true);
      const extraDrift = drifts.find((d) => d.field === "unauthorized_secret_field");
      expect(extraDrift).toBeDefined();
      expect(extraDrift?.driftType).toBe("UNAUTHORIZED_FIELD");
    });
  });

  describe("Retry Path", () => {
    it("retries transient inspection errors and resolves successfully", async () => {
      let attempts = 0;
      const events = [
        {
          get event() {
            attempts++;
            if (attempts === 1) throw new Error("Transient buffer lock");
            return {
              version: "1",
              event_id: "evt_1",
              event_type: "prize_round_drawn",
              timestamp: "2026-05-01T12:00:00.000Z",
              pool_id: "pool_1",
              round_id: 1,
              winner_wallet: validStellarAddress,
              prize_amount: "5000000",
              randomness_tx_hash: validTxHash,
              eligible_participants: 10,
            };
          },
          schemaKey: "prize_round_drawn",
        },
      ];

      const result = await detectCrossServiceEventDrift(events, {
        maxRetries: 2,
        retryDelayMs: 5,
      });

      expect(result.passed).toBe(true);
      expect(attempts).toBe(2);
    });
  });

  describe("Authorization Path", () => {
    it("allows authorized roles: admin, service, auditor", () => {
      const roles: Array<DriftAuthContext["role"]> = ["admin", "service", "auditor"];
      for (const role of roles) {
        expect(() => authorizeDriftInspection({ caller: "worker", role })).not.toThrow();
      }
    });

    it("throws SchemaDriftAuthError for unauthorized callers", async () => {
      expect(() =>
        authorizeDriftInspection({ caller: "attacker", role: "unauthorized" }),
      ).toThrowError(SchemaDriftAuthError);

      await expect(
        detectCrossServiceEventDrift([], {
          auth: { caller: "attacker", role: "unauthorized" },
        }),
      ).rejects.toThrowError(SchemaDriftAuthError);
    });
  });

  describe("Edge Cases", () => {
    it("handles null or non-object event payload without crashing", () => {
      const malformedEvent: EventEnvelope = {
        topics: ["vaultquest", "v1", "pool_created"],
        payload: null as any,
      };

      const drifts = validateEventSchema(malformedEvent, CANONICAL_SOROBAN_SCHEMAS.pool_created);
      expect(drifts.some((d) => d.driftType === "MALFORMED_PAYLOAD")).toBe(true);
    });

    it("reports unregistered events as medium severity drift", async () => {
      const unknownEvent: EventEnvelope = {
        event_type: "completely_unknown_event_type",
      };

      const result = await detectCrossServiceEventDrift([{ event: unknownEvent }]);
      expect(result.drifts.some((d) => d.driftType === "UNSUPPORTED_VERSION")).toBe(true);
    });
  });
});

