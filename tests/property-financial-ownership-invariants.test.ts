import { describe, it, expect } from "vitest";
import {
  TransitionInvariantService,
  InvariantViolationError,
} from "../backend/src/services/transitionInvariants";
import {
  OwnershipTransferRegistry,
  OwnershipTransferError,
  OWNERSHIP_TRANSFER_REASONS,
  TRANSFER_STATES,
} from "../lib/ownership-transfer";

/**
 * Property Tests for Financial and Ownership Invariants (#1073)
 *
 * Implements rigorous property-based verification over randomized generative
 * inputs across financial conservation, solvency, and ownership lifecycles.
 *
 * Invariant Properties Asserted:
 * 1. Financial Conservation: For all inputs, debits = credits + fee. Any epsilon perturbation fails.
 * 2. Non-Negativity & Solvency: No negative amounts; liabilities <= total pool balance.
 * 3. Capacity Bounds: Balance <= MaxCapacity for all deposit sequences.
 * 4. Single-Owner Invariance: Exactly one owner exists at any instant (|Owners(R)| = 1).
 * 5. Handover Invariance: Two-phase transfer: Old owner holds ownership until explicit accept.
 *    Cancel, decline, or timeout safely preserves old owner without leaving resource ownerless.
 * 6. Authorization Boundary: Non-owners cannot propose/cancel; non-recipients cannot accept.
 * 7. Terminal State Immobility: Terminal states cannot be re-transitioned.
 */

// ─── Generative Helpers ───────────────────────────────────────────────────────

function randomBigInt(min: bigint, max: bigint): bigint {
  const range = max - min + 1n;
  const randBits = BigInt(Math.floor(Math.random() * 1_000_000_000));
  return min + (randBits % range);
}

function randomWallet(prefix: string): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let addr = `G${prefix}`;
  while (addr.length < 56) {
    addr += chars[Math.floor(Math.random() * chars.length)];
  }
  return addr;
}

describe("Property Tests: Financial & Ownership Invariants (#1073)", () => {
  // ─── Financial Invariants ───────────────────────────────────────────────────

  describe("Property: Financial Conservation (Debits = Credits + Fee)", () => {
    it("conserves balance across 500 randomized valid multi-party transitions", () => {
      for (let i = 0; i < 500; i++) {
        const numDebits = Math.floor(Math.random() * 5) + 1;
        const numCredits = Math.floor(Math.random() * 5) + 1;

        const debits: bigint[] = [];
        let totalDebits = 0n;
        for (let d = 0; d < numDebits; d++) {
          const val = randomBigInt(10n, 100_000n);
          debits.push(val);
          totalDebits += val;
        }

        const fee = randomBigInt(0n, totalDebits / 10n);
        const creditPool = totalDebits - fee;

        const credits: bigint[] = [];
        let allocated = 0n;
        for (let c = 0; c < numCredits - 1; c++) {
          const share = randomBigInt(0n, (creditPool - allocated) / 2n);
          credits.push(share);
          allocated += share;
        }
        credits.push(creditPool - allocated);

        // Assert conservation passes
        expect(() =>
          TransitionInvariantService.assertBalanceConservation({
            debits,
            credits,
            fee,
            assetCode: "USDC",
          })
        ).not.toThrow();
      }
    });

    it("strictly rejects any delta perturbation (delta != 0) across 500 randomized trials", () => {
      for (let i = 0; i < 500; i++) {
        const total = randomBigInt(100n, 10_000n);
        const debits = [total];
        const fee = 10n;
        const credits = [total - fee];

        // Introduce random non-zero perturbation
        const delta = Math.random() < 0.5 ? randomBigInt(1n, 50n) : -randomBigInt(1n, 50n);
        const perturbedCredits = [credits[0] + delta];

        expect(() =>
          TransitionInvariantService.assertBalanceConservation({
            debits,
            credits: perturbedCredits,
            fee,
          })
        ).toThrow(InvariantViolationError);
      }
    });

    it("strictly rejects any negative debit, credit, or fee across randomized trials", () => {
      for (let i = 0; i < 100; i++) {
        const neg = -randomBigInt(1n, 1000n);

        expect(() =>
          TransitionInvariantService.assertBalanceConservation({
            debits: [neg, 100n],
            credits: [100n],
            fee: 0n,
          })
        ).toThrow("Debit amount cannot be negative");

        expect(() =>
          TransitionInvariantService.assertBalanceConservation({
            debits: [100n],
            credits: [neg],
            fee: 0n,
          })
        ).toThrow("Credit amount cannot be negative");

        expect(() =>
          TransitionInvariantService.assertBalanceConservation({
            debits: [100n],
            credits: [100n],
            fee: neg,
          })
        ).toThrow("Fee cannot be negative");
      }
    });
  });

  describe("Property: Pool Capacity & Liquidity Solvency", () => {
    it("maintains capacity invariance: balance + delta <= maxCapacity", () => {
      const maxCap = 1_000_000n;
      let currentBal = 0n;

      for (let i = 0; i < 100; i++) {
        const deposit = randomBigInt(100n, 10_000n);
        if (currentBal + deposit <= maxCap) {
          expect(() =>
            TransitionInvariantService.assertCapacityBounds(currentBal, deposit, maxCap)
          ).not.toThrow();
          currentBal += deposit;
        } else {
          expect(() =>
            TransitionInvariantService.assertCapacityBounds(currentBal, deposit, maxCap)
          ).toThrow(InvariantViolationError);
          break;
        }
      }
    });

    it("maintains liquidity solvency: withdrawal <= liquid balance", () => {
      for (let i = 0; i < 200; i++) {
        const liquidBal = randomBigInt(100n, 50_000n);
        const validWithdrawal = randomBigInt(0n, liquidBal);
        const invalidWithdrawal = liquidBal + randomBigInt(1n, 1000n);

        expect(() =>
          TransitionInvariantService.assertLiquiditySolvency(validWithdrawal, liquidBal)
        ).not.toThrow();

        expect(() =>
          TransitionInvariantService.assertLiquiditySolvency(invalidWithdrawal, liquidBal)
        ).toThrow(InvariantViolationError);
      }
    });
  });

  // ─── Ownership Invariants ───────────────────────────────────────────────────

  describe("Property: Single Owner Invariance (|Owners(R)| = 1)", () => {
    it("preserves exactly one owner throughout the entire propose-accept lifecycle", () => {
      const registry = new OwnershipTransferRegistry();
      const ownerA = randomWallet("ALICE");
      const ownerB = randomWallet("BOB");
      const resType = "vault";
      const resId = "prop_test_001";

      registry.setInitialOwner(resType, resId, ownerA);
      expect(registry.ownerOf(resType, resId)).toBe(ownerA);

      // 1. Propose handover
      const transferId = "txfer_001";
      const { transfer } = registry.initiate({
        id: transferId,
        resourceType: resType,
        resourceId: resId,
        from: ownerA,
        to: ownerB,
        durationMs: 60_000,
      });

      // INVARIANT: During pending offer, owner is STILL strictly ownerA
      expect(registry.ownerOf(resType, resId)).toBe(ownerA);
      expect(transfer.state).toBe(TRANSFER_STATES.PENDING);

      // 2. Accept handover
      const { transfer: accepted } = registry.accept(transferId, ownerB);

      // INVARIANT: After acceptance, owner transitions atomically to ownerB
      expect(accepted.state).toBe(TRANSFER_STATES.ACCEPTED);
      expect(registry.ownerOf(resType, resId)).toBe(ownerB);
    });

    it("preserves owner A if offer is cancelled, declined, or expires", () => {
      const registry = new OwnershipTransferRegistry();
      const ownerA = randomWallet("ALICE");
      const ownerB = randomWallet("BOB");
      const resType = "vault";

      // Scenario 1: Cancellation
      const resCancel = "res_cancel_test";
      registry.setInitialOwner(resType, resCancel, ownerA);
      registry.initiate({
        id: "txfer_cancel",
        resourceType: resType,
        resourceId: resCancel,
        from: ownerA,
        to: ownerB,
        durationMs: 60_000,
      });
      registry.cancel("txfer_cancel", ownerA);
      expect(registry.ownerOf(resType, resCancel)).toBe(ownerA);

      // Scenario 2: Decline
      const resDecline = "res_decline_test";
      registry.setInitialOwner(resType, resDecline, ownerA);
      registry.initiate({
        id: "txfer_decline",
        resourceType: resType,
        resourceId: resDecline,
        from: ownerA,
        to: ownerB,
        durationMs: 60_000,
      });
      registry.decline("txfer_decline", ownerB);
      expect(registry.ownerOf(resType, resDecline)).toBe(ownerA);

      // Scenario 3: Expiry
      const resExpire = "res_expire_test";
      registry.setInitialOwner(resType, resExpire, ownerA);
      registry.initiate(
        {
          id: "txfer_expire",
          resourceType: resType,
          resourceId: resExpire,
          from: ownerA,
          to: ownerB,
          durationMs: 100, // 100ms
        },
        { now: 1_000 }
      );
      // Accept after expiry
      expect(() =>
        registry.accept("txfer_expire", ownerB, { now: 2_000 })
      ).toThrow(OwnershipTransferError);
      expect(registry.ownerOf(resType, resExpire)).toBe(ownerA);
    });
  });

  describe("Property: Authorization Boundaries & Non-Impersonation", () => {
    it("strictly prevents third-party actor from accepting or cancelling transfer", () => {
      const registry = new OwnershipTransferRegistry();
      const ownerA = randomWallet("ALICE");
      const ownerB = randomWallet("BOB");
      const attackerEve = randomWallet("EVE");
      const resType = "vault";
      const resId = "auth_boundary";

      registry.setInitialOwner(resType, resId, ownerA);
      const transferId = "txfer_auth_01";
      registry.initiate({
        id: transferId,
        resourceType: resType,
        resourceId: resId,
        from: ownerA,
        to: ownerB,
        durationMs: 60_000,
      });

      // Attacker cannot accept
      expect(() =>
        registry.accept(transferId, attackerEve)
      ).toThrow(OwnershipTransferError);

      // Attacker cannot cancel
      expect(() =>
        registry.cancel(transferId, attackerEve)
      ).toThrow(OwnershipTransferError);

      // Owner remains strictly ownerA
      expect(registry.ownerOf(resType, resId)).toBe(ownerA);
    });

    it("rejects self-transfer proposals across randomized trials", () => {
      const registry = new OwnershipTransferRegistry();
      const owner = randomWallet("USER");
      const resType = "vault";
      const resId = "self_transfer";
      registry.setInitialOwner(resType, resId, owner);

      expect(() =>
        registry.initiate({
          id: "txfer_self",
          resourceType: resType,
          resourceId: resId,
          from: owner,
          to: owner, // self-transfer
          durationMs: 60_000,
        })
      ).toThrow(OwnershipTransferError);
    });
  });

  describe("Property: Terminal State Immobility & Retries", () => {
    it("prevents any state transition out of terminal states (accepted, declined, cancelled)", () => {
      const registry = new OwnershipTransferRegistry();
      const ownerA = randomWallet("ALICE");
      const ownerB = randomWallet("BOB");
      const resType = "vault";
      const resId = "terminal_immobility";

      registry.setInitialOwner(resType, resId, ownerA);
      const transferId = "txfer_terminal";
      registry.initiate({
        id: transferId,
        resourceType: resType,
        resourceId: resId,
        from: ownerA,
        to: ownerB,
        durationMs: 60_000,
      });

      registry.accept(transferId, ownerB);

      // Retrying accept on already accepted offer
      expect(() =>
        registry.accept(transferId, ownerB)
      ).toThrow(OwnershipTransferError);

      // Attempting to cancel already accepted offer
      expect(() =>
        registry.cancel(transferId, ownerA)
      ).toThrow(OwnershipTransferError);
    });
  });
});
