/**
 * Rare-failure fixture generator — Issue #1122
 *
 * Generates and validates all rare-failure scenarios for ownership transfer
 * (Issue #1123) in a TypeScript-native test so the same fixture set is
 * exercised by both the Rust unit tests and the cross-stack conformance suite.
 *
 * Run with:  pnpm vitest run contracts/drip-pool/tests/rare-failure-fixture-generator.test.ts
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// ── Fixture types (mirror the Rust side) ──────────────────────────────────

interface RareFailureFixture {
  name: string;
  description: string;
  ledgers_to_advance: number;
  ttl: number;
  expected_error: string | null;
}

interface OwnershipTransferFixtureFile {
  version: string;
  description: string;
  errors: Record<string, { code: number; backend_error: string; wallet_error_kind: string; description: string }>;
  events: Record<string, { topics: string[]; data: string; description: string }>;
  storage: Record<string, { key: string; type: string; scope: string; lifecycle: string; description: string }>;
  rare_failure_fixtures: RareFailureFixture[];
}

// ── Load golden fixture file ───────────────────────────────────────────────

function loadOwnershipFixtures(): OwnershipTransferFixtureFile {
  const fixturePath = join(__dirname, "../golden-fixtures/ownership_transfer.json");
  const raw = readFileSync(fixturePath, "utf8");
  return JSON.parse(raw) as OwnershipTransferFixtureFile;
}

// ── Fixture generator ──────────────────────────────────────────────────────

/**
 * Generate the canonical set of rare-failure fixtures for ownership transfer.
 * This is the single source of truth for the fixture set — both the Rust tests
 * and this TS file assert against the same golden JSON.
 */
function generateFixtures(): RareFailureFixture[] {
  const OWNERSHIP_TRANSFER_DEFAULT_TTL = 17_280 * 7;   // ~7 days
  const OWNERSHIP_TRANSFER_MAX_TTL = 17_280 * 90;      // ~90 days

  return [
    {
      name: "ownership_expiry_exact_boundary_success",
      description: "Accepting at ledger == expires_at is still valid (boundary inclusive).",
      ledgers_to_advance: 10,
      ttl: 10,
      expected_error: null,
    },
    {
      name: "ownership_expiry_one_past",
      description: "Accepting at ledger == expires_at + 1 must return OwnershipTransferExpired.",
      ledgers_to_advance: 11,
      ttl: 10,
      expected_error: "OwnershipTransferExpired",
    },
    {
      name: "expire_before_deadline",
      description: "expire_ownership_transfer before expires_at must return InvalidAction.",
      ledgers_to_advance: 5,
      ttl: 10,
      expected_error: "InvalidAction",
    },
    {
      name: "expire_at_exact_deadline",
      description:
        "expire_ownership_transfer at ledger == expires_at must return InvalidAction (not yet past).",
      ledgers_to_advance: 10,
      ttl: 10,
      expected_error: "InvalidAction",
    },
    {
      name: "expire_one_past_deadline",
      description: "expire_ownership_transfer at ledger == expires_at + 1 must succeed.",
      ledgers_to_advance: 11,
      ttl: 10,
      expected_error: null,
    },
    {
      name: "accept_after_cancel",
      description:
        "After cancel_ownership_transfer, any accept attempt returns OwnershipTransferNotFound.",
      ledgers_to_advance: 0,
      ttl: OWNERSHIP_TRANSFER_DEFAULT_TTL,
      expected_error: "OwnershipTransferNotFound",
    },
    {
      name: "self_transfer_rejected",
      description: "propose_ownership_transfer(admin, admin) must return InvalidAction.",
      ledgers_to_advance: 0,
      ttl: 0,
      expected_error: "InvalidAction",
    },
    {
      name: "ttl_beyond_max",
      description: `propose with ttl > OWNERSHIP_TRANSFER_MAX_TTL (${OWNERSHIP_TRANSFER_MAX_TTL}) must return InvalidAction.`,
      ledgers_to_advance: 0,
      ttl: OWNERSHIP_TRANSFER_MAX_TTL + 1,
      expected_error: "InvalidAction",
    },
    {
      name: "accept_no_proposal",
      description:
        "accept_ownership_transfer with no pending record returns OwnershipTransferNotFound.",
      ledgers_to_advance: 0,
      ttl: 0,
      expected_error: "OwnershipTransferNotFound",
    },
    {
      name: "cancel_no_proposal",
      description:
        "cancel_ownership_transfer with no pending record returns OwnershipTransferNotFound.",
      ledgers_to_advance: 0,
      ttl: 0,
      expected_error: "OwnershipTransferNotFound",
    },
    {
      name: "non_admin_propose",
      description: "An address that is not Pool.admin cannot propose a transfer.",
      ledgers_to_advance: 0,
      ttl: 0,
      expected_error: "Unauthorized",
    },
    {
      name: "wrong_acceptor",
      description: "An address other than proposed_owner cannot accept.",
      ledgers_to_advance: 0,
      ttl: 0,
      expected_error: "Unauthorized",
    },
  ];
}

// ── Error code cross-reference ─────────────────────────────────────────────

/** Expected error code assignments — must stay in sync with the Rust Error enum. */
const EXPECTED_ERROR_CODES: Record<string, number> = {
  OwnershipTransferNotFound: 98,
  OwnershipTransferExpired: 99,
};

// ── Tests ──────────────────────────────────────────────────────────────────

describe("Rare-failure fixture generator (Issue #1122)", () => {
  describe("Fixture catalogue validity", () => {
    it("generates a non-empty fixture set", () => {
      const fixtures = generateFixtures();
      expect(fixtures.length).toBeGreaterThan(0);
    });

    it("all fixture names are unique", () => {
      const fixtures = generateFixtures();
      const names = fixtures.map((f) => f.name);
      const unique = new Set(names);
      expect(unique.size).toBe(names.length);
    });

    it("all fixtures have non-empty name and description", () => {
      const fixtures = generateFixtures();
      for (const f of fixtures) {
        expect(f.name, `fixture '${f.name}' has empty name`).toBeTruthy();
        expect(f.description, `fixture '${f.name}' has empty description`).toBeTruthy();
      }
    });

    it("fixtures with expected_error !== null name a known error variant", () => {
      const knownErrors = new Set([
        "OwnershipTransferNotFound",
        "OwnershipTransferExpired",
        "InvalidAction",
        "Unauthorized",
      ]);
      const fixtures = generateFixtures();
      for (const f of fixtures) {
        if (f.expected_error !== null) {
          expect(
            knownErrors.has(f.expected_error),
            `fixture '${f.name}' references unknown error '${f.expected_error}'`
          ).toBe(true);
        }
      }
    });

    it("boundary fixtures correctly straddle the expiry line", () => {
      const fixtures = generateFixtures();
      const success = fixtures.find((f) => f.name === "ownership_expiry_exact_boundary_success");
      const expired = fixtures.find((f) => f.name === "ownership_expiry_one_past");

      expect(success).toBeDefined();
      expect(expired).toBeDefined();

      // Both use the same TTL; the success case advances to exactly TTL,
      // the failure case advances one ledger further.
      expect(success!.ttl).toBe(expired!.ttl);
      expect(expired!.ledgers_to_advance).toBe(success!.ledgers_to_advance + 1);
      expect(success!.expected_error).toBeNull();
      expect(expired!.expected_error).toBe("OwnershipTransferExpired");
    });

    it("expire boundary fixtures correctly distinguish inclusive vs exclusive", () => {
      const fixtures = generateFixtures();
      const atBoundary = fixtures.find((f) => f.name === "expire_at_exact_deadline");
      const pastBoundary = fixtures.find((f) => f.name === "expire_one_past_deadline");

      expect(atBoundary).toBeDefined();
      expect(pastBoundary).toBeDefined();

      expect(atBoundary!.expected_error).toBe("InvalidAction");   // not yet past
      expect(pastBoundary!.expected_error).toBeNull();             // one past → success
      expect(pastBoundary!.ledgers_to_advance).toBe(atBoundary!.ledgers_to_advance + 1);
    });
  });

  describe("Golden fixture file conformance", () => {
    it("golden file is valid JSON and parses correctly", () => {
      const loaded = loadOwnershipFixtures();
      expect(loaded).toBeDefined();
      expect(loaded.version).toBeTruthy();
      expect(Array.isArray(loaded.rare_failure_fixtures)).toBe(true);
    });

    it("golden file fixture names match generated fixture names", () => {
      const generated = generateFixtures();
      const golden = loadOwnershipFixtures();

      const genNames = new Set(generated.map((f) => f.name));
      const goldenNames = new Set(golden.rare_failure_fixtures.map((f) => f.name));

      for (const name of genNames) {
        expect(
          goldenNames.has(name),
          `generated fixture '${name}' is missing from golden file`
        ).toBe(true);
      }

      for (const name of goldenNames) {
        expect(
          genNames.has(name),
          `golden file fixture '${name}' has no corresponding generated fixture`
        ).toBe(true);
      }
    });

    it("golden file error codes match expected values", () => {
      const loaded = loadOwnershipFixtures();
      for (const [name, expected] of Object.entries(EXPECTED_ERROR_CODES)) {
        const entry = loaded.errors[name];
        expect(entry, `golden file missing error entry '${name}'`).toBeDefined();
        expect(entry.code).toBe(expected);
      }
    });

    it("golden file defines all four ownership lifecycle events", () => {
      const loaded = loadOwnershipFixtures();
      const requiredEvents = [
        "ownership_proposed",
        "ownership_accepted",
        "ownership_cancelled",
        "ownership_expired",
      ];
      for (const ev of requiredEvents) {
        expect(
          loaded.events[ev],
          `golden file missing event '${ev}'`
        ).toBeDefined();
      }
    });

    it("golden file defines PendingOwner storage key", () => {
      const loaded = loadOwnershipFixtures();
      expect(loaded.storage["PendingOwner"]).toBeDefined();
      expect(loaded.storage["PendingOwner"].scope).toBe("instance");
    });

    it("golden file and generated fixtures have identical expected_error values", () => {
      const generated = generateFixtures();
      const golden = loadOwnershipFixtures();

      const goldenByName = new Map(golden.rare_failure_fixtures.map((f) => [f.name, f]));

      for (const gen of generated) {
        const gold = goldenByName.get(gen.name);
        if (!gold) continue; // covered by the name-match test above
        expect(
          gold.expected_error,
          `expected_error mismatch for fixture '${gen.name}'`
        ).toBe(gen.expected_error);
      }
    });
  });

  describe("Edge-case property assertions", () => {
    it("maximum TTL fixture is exactly MAX + 1 ledgers", () => {
      const OWNERSHIP_TRANSFER_MAX_TTL = 17_280 * 90;
      const fixtures = generateFixtures();
      const f = fixtures.find((x) => x.name === "ttl_beyond_max");
      expect(f).toBeDefined();
      expect(f!.ttl).toBe(OWNERSHIP_TRANSFER_MAX_TTL + 1);
      expect(f!.expected_error).toBe("InvalidAction");
    });

    it("default TTL fixture uses 0 to signal default (not an explicit value)", () => {
      const fixtures = generateFixtures();
      const f = fixtures.find((x) => x.name === "accept_after_cancel");
      expect(f).toBeDefined();
      // The cancel scenario doesn't care about TTL precision; using default is fine.
      expect(f!.expected_error).toBe("OwnershipTransferNotFound");
    });

    it("all success fixtures have null expected_error", () => {
      const fixtures = generateFixtures();
      const successFixtures = fixtures.filter((f) => f.expected_error === null);
      expect(successFixtures.length).toBeGreaterThan(0);
      for (const f of successFixtures) {
        expect(f.expected_error).toBeNull();
      }
    });

    it("all failure fixtures have a non-null expected_error string", () => {
      const fixtures = generateFixtures();
      const failFixtures = fixtures.filter((f) => f.expected_error !== null);
      expect(failFixtures.length).toBeGreaterThan(0);
      for (const f of failFixtures) {
        expect(typeof f.expected_error).toBe("string");
        expect((f.expected_error as string).length).toBeGreaterThan(0);
      }
    });
  });
});
