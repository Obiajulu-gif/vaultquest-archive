import { describe, it, expect } from "vitest";
import {
  TransitionInvariantService,
  InvariantViolationError
} from "../src/services/transitionInvariants.js";
import { ERROR_CODES } from "../src/constants.js";

const WALLET_A = "GA2C5RFPE6GCKMY3US5PAB6UZLKIGAHWKXX2GIOVPWW27NOUJFBDYVIU";
const WALLET_B = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const WALLET_C = "GCX6AZ5P5P4P6EZ4RQUFHY2K6V7ZLXW2QO3G523A7YF36GTR4YI7MN76";

describe("TransitionInvariantService", () => {
  describe("Balance Invariants", () => {
    it("preserves balance conservation when debits equal credits plus fee", () => {
      expect(() =>
        TransitionInvariantService.assertBalanceConservation({
          debits: [1000n, 500n],
          credits: [1400n],
          fee: 100n,
          assetCode: "USDC"
        })
      ).not.toThrow();
    });

    it("rejects balance transitions where debits do not match credits + fee", () => {
      expect(() =>
        TransitionInvariantService.assertBalanceConservation({
          debits: [1000n],
          credits: [900n],
          fee: 50n // total 950 != 1000
        })
      ).toThrow(InvariantViolationError);

      try {
        TransitionInvariantService.assertBalanceConservation({
          debits: [1000n],
          credits: [900n],
          fee: 50n
        });
      } catch (err: any) {
        expect(err.code).toBe(ERROR_CODES.BALANCE_INVARIANT_VIOLATION);
        expect(err.statusCode).toBe(409);
        expect(err.details.rule).toBe("CONSERVATION_OF_BALANCE");
        expect(err.details.expected).toBe("950");
        expect(err.details.actual).toBe("1000");
      }
    });

    it("rejects negative debits, credits, or fees", () => {
      expect(() =>
        TransitionInvariantService.assertBalanceConservation({
          debits: [-50n],
          credits: [-50n]
        })
      ).toThrow("Debit amount cannot be negative");

      expect(() =>
        TransitionInvariantService.assertBalanceConservation({
          debits: [100n],
          credits: [-100n]
        })
      ).toThrow("Credit amount cannot be negative");

      expect(() =>
        TransitionInvariantService.assertBalanceConservation({
          debits: [100n],
          credits: [100n],
          fee: -10n
        })
      ).toThrow("Fee cannot be negative");
    });

    it("asserts non-negative balance", () => {
      expect(() => TransitionInvariantService.assertNonNegativeBalance(0n)).not.toThrow();
      expect(() => TransitionInvariantService.assertNonNegativeBalance(100n)).not.toThrow();
      expect(() => TransitionInvariantService.assertNonNegativeBalance(50)).not.toThrow();

      expect(() => TransitionInvariantService.assertNonNegativeBalance(-1n)).toThrow(
        InvariantViolationError
      );
      expect(() => TransitionInvariantService.assertNonNegativeBalance(-10)).toThrow(
        InvariantViolationError
      );
    });

    it("enforces pool capacity bounds", () => {
      const cap = 10_000n;
      expect(() => TransitionInvariantService.assertCapacityBounds(5000n, 3000n, cap)).not.toThrow();

      expect(() => TransitionInvariantService.assertCapacityBounds(8000n, 3000n, cap)).toThrow(
        InvariantViolationError
      );
      expect(() => TransitionInvariantService.assertCapacityBounds(8000n, -500n, cap)).toThrow(
        "Deposit delta cannot be negative"
      );
    });

    it("enforces liquidity solvency on withdrawals", () => {
      expect(() => TransitionInvariantService.assertLiquiditySolvency(500n, 1000n)).not.toThrow();

      expect(() => TransitionInvariantService.assertLiquiditySolvency(1500n, 1000n)).toThrow(
        InvariantViolationError
      );
      expect(() => TransitionInvariantService.assertLiquiditySolvency(0n, 1000n)).toThrow(
        "Withdrawal amount must be strictly positive"
      );
    });
  });

  describe("Ownership Invariants", () => {
    it("allows valid ownership transitions initiated by current owner", () => {
      expect(() =>
        TransitionInvariantService.assertOwnershipTransition({
          currentOwner: WALLET_A,
          newOwner: WALLET_B,
          initiator: WALLET_A
        })
      ).not.toThrow();
    });

    it("allows authorized system bypass for ownership transitions", () => {
      expect(() =>
        TransitionInvariantService.assertOwnershipTransition({
          currentOwner: WALLET_A,
          newOwner: WALLET_B,
          initiator: "system_admin",
          allowSystemBypass: true
        })
      ).not.toThrow();
    });

    it("rejects unauthorized initiators", () => {
      expect(() =>
        TransitionInvariantService.assertOwnershipTransition({
          currentOwner: WALLET_A,
          newOwner: WALLET_B,
          initiator: WALLET_C
        })
      ).toThrow(InvariantViolationError);

      try {
        TransitionInvariantService.assertOwnershipTransition({
          currentOwner: WALLET_A,
          newOwner: WALLET_B,
          initiator: WALLET_C
        });
      } catch (err: any) {
        expect(err.code).toBe(ERROR_CODES.OWNERSHIP_INVARIANT_VIOLATION);
        expect(err.details.rule).toBe("AUTHORIZED_OWNERSHIP_INITIATOR");
      }
    });

    it("rejects transitions to invalid or empty address", () => {
      expect(() =>
        TransitionInvariantService.assertOwnershipTransition({
          currentOwner: WALLET_A,
          newOwner: "",
          initiator: WALLET_A
        })
      ).toThrow("New owner address is invalid or empty");

      expect(() =>
        TransitionInvariantService.assertOwnershipTransition({
          currentOwner: "invalid-key",
          newOwner: WALLET_B,
          initiator: "invalid-key"
        })
      ).toThrow("Current owner address is invalid");
    });

    it("rejects ownership transitions to the same owner", () => {
      expect(() =>
        TransitionInvariantService.assertOwnershipTransition({
          currentOwner: WALLET_A,
          newOwner: WALLET_A,
          initiator: WALLET_A
        })
      ).toThrow("Cannot transfer ownership to existing owner");
    });

    it("asserts single-owner principle", () => {
      expect(() => TransitionInvariantService.assertSingleOwner("vault-1", [WALLET_A])).not.toThrow();

      expect(() => TransitionInvariantService.assertSingleOwner("vault-1", [])).toThrow(
        InvariantViolationError
      );
      expect(() =>
        TransitionInvariantService.assertSingleOwner("vault-1", [WALLET_A, WALLET_B])
      ).toThrow(InvariantViolationError);
    });
  });

  describe("Entitlement Invariants", () => {
    const defaultClaim = {
      entitlementId: "prize-123",
      claimant: WALLET_A,
      expectedBeneficiary: WALLET_A,
      allocatedAmount: 1000n,
      requestedAmount: 1000n,
      alreadyClaimed: false,
      deadline: new Date(Date.now() + 60_000),
      now: new Date()
    };

    it("allows valid entitlement claim", () => {
      expect(() => TransitionInvariantService.assertEntitlementClaim(defaultClaim)).not.toThrow();
    });

    it("rejects double claims (anti-double-claim)", () => {
      expect(() =>
        TransitionInvariantService.assertEntitlementClaim({
          ...defaultClaim,
          alreadyClaimed: true
        })
      ).toThrow(InvariantViolationError);

      try {
        TransitionInvariantService.assertEntitlementClaim({
          ...defaultClaim,
          alreadyClaimed: true
        });
      } catch (err: any) {
        expect(err.code).toBe(ERROR_CODES.ENTITLEMENT_INVARIANT_VIOLATION);
        expect(err.details.rule).toBe("ANTI_DOUBLE_CLAIM");
      }
    });

    it("rejects claims where claimant does not match entitled beneficiary", () => {
      expect(() =>
        TransitionInvariantService.assertEntitlementClaim({
          ...defaultClaim,
          claimant: WALLET_B
        })
      ).toThrow("does not match entitled beneficiary");
    });

    it("rejects claims after deadline has expired", () => {
      expect(() =>
        TransitionInvariantService.assertEntitlementClaim({
          ...defaultClaim,
          deadline: new Date(Date.now() - 10_000),
          now: new Date()
        })
      ).toThrow("Claim deadline passed");
    });

    it("rejects requested amounts exceeding allocation or non-positive amounts", () => {
      expect(() =>
        TransitionInvariantService.assertEntitlementClaim({
          ...defaultClaim,
          requestedAmount: 1500n
        })
      ).toThrow("exceeds allocated entitlement");

      expect(() =>
        TransitionInvariantService.assertEntitlementClaim({
          ...defaultClaim,
          requestedAmount: 0n
        })
      ).toThrow("greater than zero");
    });

    it("asserts valid entitlement lifecycle transitions", () => {
      expect(() =>
        TransitionInvariantService.assertEntitlementTransition("pending", "eligible")
      ).not.toThrow();
      expect(() =>
        TransitionInvariantService.assertEntitlementTransition("eligible", "claimed")
      ).not.toThrow();
      expect(() =>
        TransitionInvariantService.assertEntitlementTransition("eligible", "expired")
      ).not.toThrow();

      // Illegal transitions
      expect(() =>
        TransitionInvariantService.assertEntitlementTransition("claimed", "eligible")
      ).toThrow(InvariantViolationError);
      expect(() =>
        TransitionInvariantService.assertEntitlementTransition("expired", "claimed")
      ).toThrow(InvariantViolationError);
    });
  });
});
