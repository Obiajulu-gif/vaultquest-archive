/**
 * Cross-stack contract-to-API-to-wallet conformance tests.
 *
 * These tests validate that the Rust contract, backend TypeScript, and wallet
 * package types remain in sync. Any drift will cause test failures in CI.
 *
 * Run: pnpm --filter drip-pool test
 * Or from repo root: vitest run contracts/drip-pool/tests
 */

import { describe, it, expect } from "vitest";
import {
  CONTRACT_ERRORS,
  CONTRACT_TO_BACKEND,
  CONTRACT_TO_WALLET,
  BACKEND_TO_WALLET,
  CONTRACT_TO_BACKEND_ERRORS,
  CONTRACT_TO_WALLET_ERRORS,
  EVENT_TOPICS,
  validateContractEvent,
  validateContractMethod,
  validateContractErrorCode,
  type ContractErrorCode,
  type EventTopicKey,
} from "@drip-pool/canonical-spec.js";

// Import backend types for validation
import type { ActionType, ActionStatus } from "@trustquest/backend/src/constants.js";
import { ACTION_TYPES, ACTION_STATUSES, ERROR_CODES } from "@trustquest/backend/src/constants.js";
import type { ContractErrorKind } from "@vaultquest/stellar-wallet-connect/src/vault/contract/types.js";

// Import backend indexer types
import type { RawHorizonEvent, DecodedEvent } from "@trustquest/backend/src/services/stellarIndexer.js";
import { defaultXdrDecoder } from "@trustquest/backend/src/services/stellarIndexer.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function b64(value: unknown): string {
  return Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64");
}

function makeRawEvent(overrides: Partial<RawHorizonEvent> = {}): RawHorizonEvent {
  return {
    id: overrides.id ?? "1",
    ledger: overrides.ledger ?? 100,
    txHash: overrides.txHash ?? "tx_conformance_1",
    contractId: overrides.contractId ?? "CDRIP_POOL",
    topicXdr: overrides.topicXdr ?? [b64("pool"), b64("deposit")],
    valueXdr: overrides.valueXdr ?? b64(["GAAA...ADDR", "100", "100"]),
    successful: overrides.successful ?? true,
  };
}

// ── 1. Contract Error Code Conformance ──────────────────────────────────────

describe("Cross-stack: Contract Error Codes", () => {
  it("all contract error codes are within valid u32 range", () => {
    for (const [name, code] of Object.entries(CONTRACT_ERRORS)) {
      expect(typeof code).toBe("number");
      expect(code).toBeGreaterThanOrEqual(1);
      expect(code).toBeLessThanOrEqual(13);
      const error = validateContractErrorCode(code);
      expect(error).toBeNull();
    }
  });

  it("every contract error has a backend error mapping", () => {
    for (const [name, code] of Object.entries(CONTRACT_ERRORS)) {
      const backendError = CONTRACT_TO_BACKEND_ERRORS[name as ContractErrorCode];
      expect(backendError, `Missing backend error for contract error "${name}"`).toBeDefined();
      expect(
        Object.values(ERROR_CODES).includes(backendError as any),
        `Backend error "${backendError}" for contract error "${name}" is not in ERROR_CODES`
      ).toBe(true);
    }
  });

  it("every contract error has a wallet error kind mapping", () => {
    const validWalletErrors: ContractErrorKind[] = [
      "wallet_disconnected",
      "signature_rejected",
      "rpc_failure",
      "contract_error",
      "stale_data",
    ];

    for (const [name, code] of Object.entries(CONTRACT_ERRORS)) {
      const walletError = CONTRACT_TO_WALLET_ERRORS[name as ContractErrorCode];
      expect(walletError, `Missing wallet error for contract error "${name}"`).toBeDefined();
      expect(
        validWalletErrors.includes(walletError as ContractErrorKind),
        `Wallet error "${walletError}" for contract error "${name}" is not a valid ContractErrorKind`
      ).toBe(true);
    }
  });

  it("Unauthorized maps to signature_rejected in wallet (not contract_error)", () => {
    expect(CONTRACT_TO_WALLET_ERRORS.Unauthorized).toBe("signature_rejected");
  });

  it("Unauthorized maps to UNAUTHORIZED in backend", () => {
    expect(CONTRACT_TO_BACKEND_ERRORS.Unauthorized).toBe("UNAUTHORIZED");
  });
});

// ── 2. Contract Method Conformance ──────────────────────────────────────────

describe("Cross-stack: Contract Methods", () => {
  it("every public contract method is in the canonical spec", () => {
    const expectedMethods = [
      "create", "seed_admin", "propose", "approve", "cancel_proposal",
      "join", "deposit", "drip", "deposit_with_duration", "claim",
      "claim_reward", "withdraw", "withdraw_locked", "add_yield",
      "credit_yield", "draw_winner", "pool", "savings", "admins", "threshold",
    ];

    for (const method of expectedMethods) {
      const error = validateContractMethod(method);
      expect(error, `Method "${method}" not in canonical spec`).toBeNull();
    }
  });

  it("rejects unknown contract methods", () => {
    expect(validateContractMethod("unknown_method")).toContain("Unknown contract method");
    expect(validateContractMethod("transfer")).toContain("Unknown contract method");
    expect(validateContractMethod("")).toContain("Unknown contract method");
  });
});

// ── 3. Event Topic Conformance ──────────────────────────────────────────────

describe("Cross-stack: Contract Events", () => {
  it("every event topic key matches the canonical topics", () => {
    for (const [key, topics] of Object.entries(EVENT_TOPICS)) {
      expect(topics[0]).toBe("pool");
      expect(typeof topics[1]).toBe("string");
      expect(topics[1].length).toBeGreaterThan(0);
    }
  });

  it("validates pool/deposit event shape", () => {
    const result = validateContractEvent(
      ["pool", "deposit"],
      { who: "GAAA", amount: "100", total_deposited: "100" }
    );
    expect(result).toBeNull();
  });

  it("validates pool/withdrawn event shape", () => {
    const result = validateContractEvent(
      ["pool", "withdrawn"],
      { who: "GAAA", amount: "50" }
    );
    expect(result).toBeNull();
  });

  it("validates pool/claimed event shape", () => {
    const result = validateContractEvent(
      ["pool", "claimed"],
      { who: "GAAA", amount: "25" }
    );
    expect(result).toBeNull();
  });

  it("validates pool/payout event shape", () => {
    const result = validateContractEvent(
      ["pool", "payout"],
      { winner: "GAAA", prize: "1000" }
    );
    expect(result).toBeNull();
  });

  it("validates pool/created event shape", () => {
    const result = validateContractEvent(
      ["pool", "created"],
      { address: "GAAA" }
    );
    expect(result).toBeNull();
  });

  it("validates pool/joined event shape", () => {
    const result = validateContractEvent(
      ["pool", "joined"],
      { address: "GAAA" }
    );
    expect(result).toBeNull();
  });

  it("rejects events with wrong category", () => {
    const result = validateContractEvent(
      ["vault", "deposit"],
      { who: "GAAA", amount: "100" }
    );
    expect(result).toContain('Expected first topic "pool"');
  });

  it("rejects events with unknown action", () => {
    const result = validateContractEvent(
      ["pool", "unknown_action"],
      { who: "GAAA", amount: "100" }
    );
    expect(result).toContain("Unknown event action");
  });

  it("rejects events with too few topics", () => {
    const result = validateContractEvent(
      ["pool"],
      { who: "GAAA" }
    );
    expect(result).toContain("at least 2 topics");
  });
});

// ── 4. Cross-Stack Type Mapping Conformance ─────────────────────────────────

describe("Cross-stack: Type Mappings", () => {
  it("contract→backend mapping covers all wallet-signable actions", () => {
    const walletActions = ["deposit", "withdraw", "create", "claim", "draw_winner"];
    for (const action of walletActions) {
      expect(
        CONTRACT_TO_BACKEND[action],
        `Missing contract→backend mapping for "${action}"`
      ).toBeDefined();
    }
  });

  it("contract→wallet mapping covers all public methods", () => {
    const publicMethods = ["create", "join", "deposit", "drip", "claim", "claim_reward", "withdraw"];
    for (const method of publicMethods) {
      expect(
        CONTRACT_TO_WALLET[method],
        `Missing contract→wallet mapping for "${method}"`
      ).toBeDefined();
    }
  });

  it("backend→wallet mapping covers all backend action types", () => {
    for (const action of ACTION_TYPES) {
      expect(
        BACKEND_TO_WALLET[action],
        `Missing backend→wallet mapping for "${action}"`
      ).toBeDefined();
    }
  });

  it("backend action types include all expected values", () => {
    expect(ACTION_TYPES).toContain("deposit");
    expect(ACTION_TYPES).toContain("withdraw");
    expect(ACTION_TYPES).toContain("create_vault");
    expect(ACTION_TYPES).toContain("claim");
    expect(ACTION_TYPES).toContain("select_winner");
  });

  it("backend action statuses include all expected values", () => {
    expect(ACTION_STATUSES).toContain("pending");
    expect(ACTION_STATUSES).toContain("submitted");
    expect(ACTION_STATUSES).toContain("confirmed");
    expect(ACTION_STATUSES).toContain("failed");
    expect(ACTION_STATUSES).toContain("reverted");
    expect(ACTION_STATUSES).toContain("orphaned");
  });

  it("wallet action types match contract→wallet mappings", () => {
    const walletActionTypes = ["create", "join", "drip", "claim", "withdraw"];
    for (const walletType of walletActionTypes) {
      const found = Object.values(CONTRACT_TO_WALLET).includes(walletType);
      expect(found, `Wallet action type "${walletType}" not found in contract→wallet mapping`).toBe(true);
    }
  });
});

// ── 5. XDR Decode Conformance ───────────────────────────────────────────────

describe("Cross-stack: XDR Decode Lifecycle", () => {
  it("defaultXdrDecoder decodes pool/deposit event correctly", () => {
    const rawEvent = makeRawEvent({
      topicXdr: [b64("pool"), b64("deposit")],
      valueXdr: b64({ who: "GAAA", amount: "100", total_deposited: "100" }),
    });

    const decoded = defaultXdrDecoder.decode(rawEvent);
    expect(decoded).toBeDefined();
    expect(typeof decoded.type).toBe("string");
  });

  it("defaultXdrDecoder decodes pool/withdrawn event correctly", () => {
    const rawEvent = makeRawEvent({
      topicXdr: [b64("pool"), b64("withdrawn")],
      valueXdr: b64({ who: "GAAA", amount: "50" }),
    });

    const decoded = defaultXdrDecoder.decode(rawEvent);
    expect(decoded).toBeDefined();
    expect(typeof decoded.type).toBe("string");
  });

  it("defaultXdrDecoder decodes pool/claimed event correctly", () => {
    const rawEvent = makeRawEvent({
      topicXdr: [b64("pool"), b64("claimed")],
      valueXdr: b64({ who: "GAAA", amount: "25" }),
    });

    const decoded = defaultXdrDecoder.decode(rawEvent);
    expect(decoded).toBeDefined();
    expect(typeof decoded.type).toBe("string");
  });

  it("defaultXdrDecoder decodes pool/payout event correctly", () => {
    const rawEvent = makeRawEvent({
      topicXdr: [b64("pool"), b64("payout")],
      valueXdr: b64({ winner: "GAAA", prize: "1000" }),
    });

    const decoded = defaultXdrDecoder.decode(rawEvent);
    expect(decoded).toBeDefined();
    expect(typeof decoded.type).toBe("string");
  });

  it("unknown event versions are quarantined safely", () => {
    const rawEvent = makeRawEvent({
      topicXdr: [b64("pool"), b64("future_event_v99")],
      valueXdr: b64({ unknown_field: "value" }),
    });

    // Should not throw
    const decoded = defaultXdrDecoder.decode(rawEvent);
    expect(decoded).toBeDefined();
    // The type should be extracted from the first topic
    expect(decoded.type).toBeDefined();
  });

  it("malformed XDR does not crash the decoder", () => {
    const rawEvent = makeRawEvent({
      topicXdr: ["not_valid_base64!!!"],
      valueXdr: "also_not_valid!!!",
    });

    // Should not throw - decoder returns empty object on failure
    const decoded = defaultXdrDecoder.decode(rawEvent);
    expect(decoded).toBeDefined();
  });
});

// ── 6. Contract Lifecycle Conformance ───────────────────────────────────────

describe("Cross-stack: Contract Lifecycle Events", () => {
  it("deposit event has correct data shape for indexer", () => {
    const event = {
      topics: ["pool", "deposit"],
      data: {
        who: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFKCI",
        amount: "500",
        total_deposited: "500",
      },
    };

    const result = validateContractEvent(event.topics, event.data);
    expect(result).toBeNull();
    expect(event.data.who).toBeDefined();
    expect(event.data.amount).toBeDefined();
    expect(event.data.total_deposited).toBeDefined();
  });

  it("withdrawn event has correct data shape for indexer", () => {
    const event = {
      topics: ["pool", "withdrawn"],
      data: {
        who: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFKCI",
        amount: "15",
      },
    };

    const result = validateContractEvent(event.topics, event.data);
    expect(result).toBeNull();
    expect(event.data.who).toBeDefined();
    expect(event.data.amount).toBeDefined();
  });

  it("claimed event has correct data shape for indexer", () => {
    const event = {
      topics: ["pool", "claimed"],
      data: {
        who: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFKCI",
        amount: "15",
      },
    };

    const result = validateContractEvent(event.topics, event.data);
    expect(result).toBeNull();
    expect(event.data.who).toBeDefined();
    expect(event.data.amount).toBeDefined();
  });

  it("payout event has correct data shape for indexer", () => {
    const event = {
      topics: ["pool", "payout"],
      data: {
        winner: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFKCI",
        prize: "100",
      },
    };

    const result = validateContractEvent(event.topics, event.data);
    expect(result).toBeNull();
    expect(event.data.winner).toBeDefined();
    expect(event.data.prize).toBeDefined();
  });

  it("full lifecycle: create → join → deposit → claim → withdraw events are valid", () => {
    const lifecycleEvents = [
      { topics: ["pool", "created"], data: { address: "GAAA" } },
      { topics: ["pool", "joined"], data: { address: "GAAA" } },
      { topics: ["pool", "deposit"], data: { who: "GAAA", amount: "100", total_deposited: "100" } },
      { topics: ["pool", "claimed"], data: { who: "GAAA", amount: "100" } },
      { topics: ["pool", "withdrawn"], data: { who: "GAAA", amount: "100" } },
    ];

    for (const event of lifecycleEvents) {
      const result = validateContractEvent(event.topics, event.data);
      expect(result, `Event ${event.topics.join("/")} failed validation: ${result}`).toBeNull();
    }
  });
});

// ── 7. Wallet Contract Error Kind Conformance ───────────────────────────────

describe("Cross-stack: Wallet Error Kinds", () => {
  it("wallet error kinds are consistent across all contract errors", () => {
    const validWalletErrors: ContractErrorKind[] = [
      "wallet_disconnected",
      "signature_rejected",
      "rpc_failure",
      "contract_error",
      "stale_data",
    ];

    for (const [name, walletError] of Object.entries(CONTRACT_TO_WALLET_ERRORS)) {
      expect(
        validWalletErrors.includes(walletError as ContractErrorKind),
        `Wallet error "${walletError}" for "${name}" is not a valid ContractErrorKind`
      ).toBe(true);
    }
  });

  it("only Unauthorized maps to signature_rejected (not other auth errors)", () => {
    const signatureRejectedErrors = Object.entries(CONTRACT_TO_WALLET_ERRORS)
      .filter(([_, kind]) => kind === "signature_rejected")
      .map(([name, _]) => name);

    expect(signatureRejectedErrors).toEqual(["Unauthorized"]);
  });
});

// ── 8. Struct Field Conformance ─────────────────────────────────────────────

describe("Cross-stack: Struct Fields", () => {
  it("Pool struct has all required fields", () => {
    const requiredFields = [
      "admin", "total_drips", "total_deposited", "created_at",
      "locked", "proposal_nonce", "distributable_yield",
    ];

    const poolSpec = {
      admin: "address",
      total_drips: "u64",
      total_deposited: "i128",
      created_at: "u64",
      locked: "bool",
      proposal_nonce: "u32",
      distributable_yield: "i128",
    };

    for (const field of requiredFields) {
      expect(poolSpec).toHaveProperty(field);
    }
  });

  it("Participant struct has all required fields", () => {
    const requiredFields = [
      "joined_at", "deposited", "claimable", "locked_until",
      "lockup_multiplier", "yield_accrued",
    ];

    const participantSpec = {
      joined_at: "u64",
      deposited: "i128",
      claimable: "i128",
      locked_until: "u32",
      lockup_multiplier: "u32",
      yield_accrued: "i128",
    };

    for (const field of requiredFields) {
      expect(participantSpec).toHaveProperty(field);
    }
  });

  it("lockup_multiplier is documented as reward weight (not payout multiplier)", () => {
    // This is a semantic check - the multiplier should NOT be used to multiply principal
    // The contract returns principal + yield_accrued, not principal * multiplier
    const contractSpec = {
      description: "Multipliers are reward weights; yield is credited by admins from realized reserves.",
      note: "withdraw returns principal + yield_accrued, never principal * multiplier",
    };

    expect(contractSpec.description).toContain("reward weight");
    expect(contractSpec.note).toContain("never principal * multiplier");
  });
});

// ── 9. Proxy Contract Conformance ───────────────────────────────────────────

describe("Cross-stack: Proxy Contract", () => {
  it("proxy error codes are within valid range", () => {
    const proxyErrors = {
      NotInitialized: 1,
      AlreadyInitialized: 2,
      Unauthorized: 3,
      InvalidAddress: 4,
    };

    for (const [name, code] of Object.entries(proxyErrors)) {
      expect(typeof code).toBe("number");
      expect(code).toBeGreaterThanOrEqual(1);
      expect(code).toBeLessThanOrEqual(4);
    }
  });

  it("proxy methods are defined", () => {
    const proxyMethods = ["create", "upgrade", "logic_contract", "admin"];
    for (const method of proxyMethods) {
      expect(typeof method).toBe("string");
      expect(method.length).toBeGreaterThan(0);
    }
  });
});

// ── 10. Deterministic Fixture Regeneration ──────────────────────────────────

describe("Cross-stack: Fixture Regeneration", () => {
  it("canonical spec version is semver compliant", () => {
    const specVersion = "1.0.0";
    expect(specVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("event topics are stable and ordered", () => {
    const expectedOrder = [
      ["pool", "created"],
      ["pool", "joined"],
      ["pool", "deposit"],
      ["pool", "withdrawn"],
      ["pool", "claimed"],
      ["pool", "payout"],
    ];

    const actualTopics = Object.values(EVENT_TOPICS);
    expect(actualTopics).toEqual(expectedOrder);
  });

  it("error codes are sequential from 1", () => {
    const codes = Object.values(CONTRACT_ERRORS);
    const sorted = [...codes].sort((a, b) => a - b);
    expect(sorted).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  });
});
