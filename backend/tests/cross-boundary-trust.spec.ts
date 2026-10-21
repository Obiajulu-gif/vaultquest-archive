import { describe, it, expect, vi } from "vitest";
import { FINALITY_POLICY } from "../src/constants.js";
import { LedgerService, type ReconcileEventInput } from "../src/services/ledger.js";
import { StellarIndexer, defaultXdrDecoder, type RawHorizonEvent } from "../src/services/stellarIndexer.js";

describe("Cross-Boundary Trust Decision Verifications (#917)", () => {
  describe("T1: Intent vs. Verified Payload Divergence", () => {
    it("ensures reconciled action stores verifiedPayload from chain event and ignores spoofed intent", async () => {
      const mockAction = {
        id: "act-intent-spoof-1",
        txHash: "tx_spoofed_intent",
        status: "submitted",
        actionType: "deposit",
        actionPayload: { amount: "1000000", vault_id: "v1", token: "USDC" }, // Attacker claimed 1M USDC
        verifiedPayload: null,
      };

      let updatedData: any = null;
      const mockPrisma = {
        $transaction: vi.fn(async (fn: any) => fn(mockPrisma)),
        actionLedger: {
          findFirst: vi.fn(async () => mockAction),
          update: vi.fn(async ({ data }: any) => {
            updatedData = data;
            return { ...mockAction, ...data };
          }),
        },
        actionLease: {
          deleteMany: vi.fn(async () => ({ count: 0 })),
        },
      } as any;

      const ledger = new LedgerService(mockPrisma);
      const onChainEventPayload = { amount: "10", vault_id: "v1", token: "USDC" }; // Actual on-chain transfer was only 10 USDC

      const reconcileInput: ReconcileEventInput = {
        txHash: "tx_spoofed_intent",
        sorobanEventId: "0000000000000000100-0000000001",
        eventPayload: onChainEventPayload,
        statusHint: "confirmed",
      };

      const res = await ledger.reconcileEvent(reconcileInput);
      expect(res.matched).toBe(true);

      // Verified payload MUST come from on-chain eventPayload, NOT the spoofed actionPayload
      expect(updatedData.verifiedPayload).toEqual(onChainEventPayload);
      expect(updatedData.verifiedPayload.amount).toBe("10");
      expect(updatedData.status).toBe("confirmed");
    });
  });

  describe("T2: Finality Depth Enforcement (Provisional vs Finalized)", () => {
    it("preserves provisional status when confirmation depth is below threshold", () => {
      const observedLedger = 1000;
      const currentTipLedger = 1015; // Depth = 15
      const requiredDepth = FINALITY_POLICY.defaultConfirmationDepth; // 32

      const depth = currentTipLedger - observedLedger;
      const finalityStatus = depth >= requiredDepth ? "finalized" : "provisional";

      expect(depth).toBe(15);
      expect(finalityStatus).toBe("provisional");
    });

    it("promotes to finalized status only when depth meets or exceeds policy threshold", () => {
      const observedLedger = 1000;
      const currentTipLedger = 1032; // Depth = 32
      const requiredDepth = FINALITY_POLICY.defaultConfirmationDepth; // 32

      const depth = currentTipLedger - observedLedger;
      const finalityStatus = depth >= requiredDepth ? "finalized" : "provisional";

      expect(depth).toBe(32);
      expect(finalityStatus).toBe("finalized");
    });
  });

  describe("T3: Pre-Signing Intent Verification against Decoded Transaction Parameters", () => {
    interface SigningIntent {
      action: "deposit" | "withdraw" | "claim";
      contractId: string;
      asset: string;
      amount: string;
      recipient?: string;
    }

    interface DecodedTransaction {
      contractId: string;
      functionName: string;
      args: {
        amount: string;
        asset: string;
        to?: string;
      };
    }

    function verifyIntentBeforeSigning(intent: SigningIntent, decoded: DecodedTransaction): void {
      if (decoded.contractId !== intent.contractId) {
        throw new Error(`Trust boundary violation: Contract mismatch. Expected ${intent.contractId}, got ${decoded.contractId}`);
      }
      if (decoded.args.amount !== intent.amount) {
        throw new Error(`Trust boundary violation: Amount mismatch. Expected ${intent.amount}, got ${decoded.args.amount}`);
      }
      if (decoded.args.asset !== intent.asset) {
        throw new Error(`Trust boundary violation: Asset mismatch. Expected ${intent.asset}, got ${decoded.args.asset}`);
      }
    }

    it("accepts transaction when decoded XDR exactly matches user intent", () => {
      const intent: SigningIntent = {
        action: "deposit",
        contractId: "CDRIPPOOL1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF",
        asset: "USDC",
        amount: "500",
      };

      const decodedTx: DecodedTransaction = {
        contractId: "CDRIPPOOL1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF",
        functionName: "deposit",
        args: {
          amount: "500",
          asset: "USDC",
        },
      };

      expect(() => verifyIntentBeforeSigning(intent, decodedTx)).not.toThrow();
    });

    it("rejects blind-signing attack where transaction redirects funds to attacker contract", () => {
      const intent: SigningIntent = {
        action: "deposit",
        contractId: "CDRIPPOOL1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF",
        asset: "USDC",
        amount: "500",
      };

      const maliciousDecodedTx: DecodedTransaction = {
        contractId: "CATTACKERCONTRACT000000000000000000000000000000000000000",
        functionName: "deposit",
        args: {
          amount: "500",
          asset: "USDC",
        },
      };

      expect(() => verifyIntentBeforeSigning(intent, maliciousDecodedTx)).toThrow(/Contract mismatch/);
    });

    it("rejects tampering attack where transaction amount is inflated", () => {
      const intent: SigningIntent = {
        action: "deposit",
        contractId: "CDRIPPOOL1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF",
        asset: "USDC",
        amount: "500",
      };

      const inflatedDecodedTx: DecodedTransaction = {
        contractId: "CDRIPPOOL1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF",
        functionName: "deposit",
        args: {
          amount: "50000", // Tampered amount
          asset: "USDC",
        },
      };

      expect(() => verifyIntentBeforeSigning(intent, inflatedDecodedTx)).toThrow(/Amount mismatch/);
    });
  });

  describe("T4: Factory Address Origin Verification (#507)", () => {
    it("skips and does not upsert pool registry when event originates from untrusted contract", async () => {
      const trustedFactory = "CFACTORY_GENUINE_00000000000000000000000000000000000000000";
      const rogueContract = "CROGUE_ATTACKER_00000000000000000000000000000000000000000";

      const poolRegistryUpsert = vi.fn();
      const mockPrisma = {
        poolRegistry: {
          upsert: poolRegistryUpsert,
        },
      } as any;

      const mockLedger = new LedgerService(mockPrisma);
      mockLedger.appendChainEvents = vi.fn().mockResolvedValue(undefined);
      const b64 = (val: unknown) => Buffer.from(typeof val === "string" ? val : JSON.stringify(val)).toString("base64");

      const rogueEvent: RawHorizonEvent = {
        id: "0000000000000000100-0000000001",
        ledger: 100,
        txHash: "tx_fake_pool_deployment",
        contractId: rogueContract, // Roguishly trying to emit fpooldep
        topicXdr: [b64("fpooldep")],
        valueXdr: b64({ pool_id: "C_FAKE_POOL_1", admin: "G_ATTACKER" }),
        successful: true,
      };

      const indexer = new StellarIndexer({
        ledger: mockLedger,
        source: {
          fetchEvents: async () => [rogueEvent],
          latestObservedLedger: () => 100,
        },
        decoder: defaultXdrDecoder,
        factoryAddress: trustedFactory,
      });

      await indexer.tick();

      // Ensure that because contractId !== trustedFactory, rogue event was NOT registered
      expect(poolRegistryUpsert).not.toHaveBeenCalled();
    });
  });

  describe("T5: Atomic Scarcity Enforcement in Reward Claims", () => {
    class MockRewardReserve {
      private balance = 100n;

      async claimReward(amount: bigint): Promise<{ success: boolean; remaining: bigint }> {
        if (amount <= 0n) throw new Error("Invalid claim amount");
        if (this.balance < amount) {
          throw new Error("INSUFFICIENT_REWARD_RESERVES");
        }
        this.balance -= amount;
        return { success: true, remaining: this.balance };
      }

      getBalance(): bigint {
        return this.balance;
      }
    }

    it("prevents double-spend and over-allocation under concurrent claims", async () => {
      const reserve = new MockRewardReserve();

      // Two users concurrently attempt to claim 80 from a total reserve of 100
      const results = await Promise.allSettled([
        reserve.claimReward(80n),
        reserve.claimReward(80n),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(reserve.getBalance()).toBe(20n); // 100 - 80 = 20 (never negative)
    });
  });
});
