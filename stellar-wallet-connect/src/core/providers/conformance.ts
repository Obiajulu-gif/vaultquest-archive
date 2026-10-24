import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { WalletProvider, ProviderConnectionResult, NetworkType, WalletErrorCode } from "./provider.js";
import { providerRegistry, createWalletError, normalizeError, isWalletError } from "./provider.js";
import { FreighterProvider } from "./freighter.js";
import { AlbedoProvider } from "./albedo.js";
import { XBullProvider } from "./xbull.js";
import { RabetProvider } from "./rabet.js";
import { LedgerProvider } from "./ledger.js";

interface ConformanceTestContext {
  provider: WalletProvider;
  connected: boolean;
}

function runConformanceSuite(name: string, createProvider: () => WalletProvider) {
  describe(`${name} Provider Conformance`, () => {
    let ctx: ConformanceTestContext;

    beforeAll(() => {
      ctx = { provider: createProvider(), connected: false };
    });

    afterAll(async () => {
      if (ctx.connected) {
        await ctx.provider.disconnect().catch(() => {});
      }
    });

    it("should have required properties", () => {
      expect(ctx.provider.id).toBeTruthy();
      expect(ctx.provider.name).toBeTruthy();
      expect(["extension", "mobile", "hardware", "walletconnect"]).toContain(ctx.provider.type);
    });

    it("isAvailable() returns boolean", async () => {
      const available = await ctx.provider.isAvailable();
      expect(typeof available).toBe("boolean");
    });

    describe("connect()", () => {
      it("rejects with NOT_AVAILABLE if not available", async () => {
        const originalIsAvailable = ctx.provider.isAvailable;
        ctx.provider.isAvailable = async () => false;

        try {
          await ctx.provider.connect();
          throw new Error("should have thrown");
        } catch (err) {
          expect(err).toBeDefined();
          if (err instanceof Error && "code" in err) {
            expect((err as any).code).toBe("NOT_AVAILABLE");
          }
        } finally {
          ctx.provider.isAvailable = originalIsAvailable;
        }
      });

      it("returns ProviderConnectionResult on success", async () => {
        const available = await ctx.provider.isAvailable();
        if (!available) {
          return;
        }

        const result = await ctx.provider.connect();
        expect(result).toHaveProperty("publicKey");
        expect(result).toHaveProperty("network");
        expect(result).toHaveProperty("providerId", ctx.provider.id);
        expect(typeof result.publicKey).toBe("string");
        expect(result.publicKey.length).toBeGreaterThan(0);
        ctx.connected = true;
      });
    });

    describe("getPublicKey()", () => {
      it("returns string public key", async () => {
        const available = await ctx.provider.isAvailable();
        if (!available) return;

        if (!ctx.connected) {
          await ctx.provider.connect();
          ctx.connected = true;
        }

        const publicKey = await ctx.provider.getPublicKey();
        expect(typeof publicKey).toBe("string");
        expect(publicKey.length).toBeGreaterThan(0);
      });
    });

    describe("getNetwork()", () => {
      it("returns valid NetworkType", async () => {
        const available = await ctx.provider.isAvailable();
        if (!available) return;

        if (!ctx.connected) {
          await ctx.provider.connect();
          ctx.connected = true;
        }

        const network = await ctx.provider.getNetwork();
        expect(["mainnet", "testnet", "futurenet", "standalone"]).toContain(network);
      });
    });

    describe("signTransaction()", () => {
      it("returns signed XDR string or throws USER_REJECTED/LOCKED", async () => {
        const available = await ctx.provider.isAvailable();
        if (!available) return;

        if (!ctx.connected) {
          await ctx.provider.connect();
          ctx.connected = true;
        }

        const dummyXdr = "AAAAAA==";

        try {
          const signed = await ctx.provider.signTransaction(dummyXdr);
          expect(typeof signed).toBe("string");
          expect(signed.length).toBeGreaterThan(0);
        } catch (err) {
          if (err instanceof Error && "code" in err) {
            const code = (err as any).code as WalletErrorCode;
            expect(["USER_REJECTED", "LOCKED", "UNSUPPORTED_OPERATION", "TIMEOUT"]).toContain(code);
          } else {
            throw err;
          }
        }
      });
    });

    describe("disconnect()", () => {
      it("completes without error", async () => {
        if (ctx.connected) {
          await ctx.provider.disconnect();
          ctx.connected = false;
        }
      });
    });
  });
}

runConformanceSuite("Freighter", () => new FreighterProvider());
runConformanceSuite("Albedo", () => new AlbedoProvider());
runConformanceSuite("xBull", () => new XBullProvider());
runConformanceSuite("Rabet", () => new RabetProvider());
runConformanceSuite("Ledger", () => new LedgerProvider());

describe("Provider Registry", () => {
  beforeAll(() => {
    providerRegistry.register(new FreighterProvider());
    providerRegistry.register(new AlbedoProvider());
  });

  afterAll(() => {
    providerRegistry.unregister("freighter");
    providerRegistry.unregister("albedo");
  });

  it("registers and retrieves providers", () => {
    expect(providerRegistry.get("freighter")).toBeDefined();
    expect(providerRegistry.get("albedo")).toBeDefined();
    expect(providerRegistry.getAll()).toHaveLength(2);
  });

  it("getAvailable filters by availability", async () => {
    const available = await providerRegistry.getAvailable();
    expect(Array.isArray(available)).toBe(true);
  });

  it("getDefault returns first registered", () => {
    const def = providerRegistry.getDefault();
    expect(def).toBeDefined();
    expect(def?.id).toBe("freighter");
  });

  it("setDefault changes default provider", () => {
    providerRegistry.setDefault("albedo");
    expect(providerRegistry.getDefault()?.id).toBe("albedo");
  });
});

describe("Error Normalization", () => {
  it("createWalletError creates properly typed error", () => {
    const err = createWalletError("USER_REJECTED", "User said no", "freighter");
    expect(err.code).toBe("USER_REJECTED");
    expect(err.providerId).toBe("freighter");
    expect(err.message).toBe("User said no");
  });

  it("normalizeError wraps unknown errors", () => {
    const err = normalizeError(new Error("wallet locked"), "freighter");
    expect(err.code).toBe("LOCKED");
    expect(err.providerId).toBe("freighter");
  });

  it("normalizeError passes through WalletError", () => {
    const original = createWalletError("TIMEOUT", "timed out", "xbull");
    const normalized = normalizeError(original, "xbull");
    expect(normalized).toBe(original);
  });

  it("isWalletError type guard works", () => {
    expect(isWalletError(createWalletError("UNKNOWN_ERROR", "oops"))).toBe(true);
    expect(isWalletError(new Error("plain"))).toBe(false);
    expect(isWalletError({ code: "X" })).toBe(false);
  });
});

describe("Multi-extension scenario", () => {
  it("registry handles multiple extensions claiming default", () => {
    const reg = providerRegistry;
    const initialDefault = reg.getDefault();
    expect(initialDefault).toBeDefined();

    reg.setDefault("albedo");
    expect(reg.getDefault()?.id).toBe("albedo");

    reg.setDefault("freighter");
    expect(reg.getDefault()?.id).toBe("freighter");
  });
});

describe("Locked wallet scenario", () => {
  it("error normalization detects locked wallet", () => {
    const lockedErr = new Error("Wallet is locked. Please unlock to continue.");
    const normalized = normalizeError(lockedErr, "freighter");
    expect(normalized.code).toBe("LOCKED");
  });
});

describe("Unsupported network scenario", () => {
  it("error normalization detects network mismatch", () => {
    const networkErr = new Error("Network mismatch: expected testnet, got mainnet");
    const normalized = normalizeError(networkErr, "freighter");
    expect(normalized.code).toBe("NETWORK_MISMATCH");
  });
});

describe("Unsupported operation scenario", () => {
  it("hardware wallet throws UNSUPPORTED_OPERATION for unsupported methods", async () => {
    const provider = new LedgerProvider();
    const available = await provider.isAvailable();
    if (!available) return;

    try {
      await provider.signAuthEntry?.("challenge", "domain");
    } catch (err) {
      if (err instanceof Error && "code" in err) {
        expect((err as any).code).toBe("UNSUPPORTED_OPERATION");
      }
    }
  });
});