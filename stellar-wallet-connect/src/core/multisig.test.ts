import { describe, it, expect, vi } from "vitest";
import { checkMultisigStatus, MultisigDetectionError } from "./multisig.js";
import type { HorizonPool } from "./horizonPool.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

function fakePool(request: (path: string) => Promise<Response>): HorizonPool {
  return { request } as unknown as HorizonPool;
}

const PUBLIC_KEY = "GABCXYZ0000000000000000000000000000000000000000000000000";

describe("checkMultisigStatus (#736)", () => {
  it("main path: a normal single-signer account (weight >= med threshold) is not multisig", async () => {
    const pool = fakePool(async () =>
      jsonResponse(200, {
        signers: [{ key: PUBLIC_KEY, weight: 1, type: "ed25519_public_key" }],
        thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
      }),
    );

    const status = await checkMultisigStatus(pool, PUBLIC_KEY);
    expect(status).toEqual({
      isMultisig: false,
      signerCount: 1,
      ownSignerWeight: 1,
      thresholds: { low: 0, med: 0, high: 0 },
    });
  });

  it("edge case: multiple signers is detected as multisig even if this key's own weight is high", async () => {
    const pool = fakePool(async () =>
      jsonResponse(200, {
        signers: [
          { key: PUBLIC_KEY, weight: 10, type: "ed25519_public_key" },
          { key: "GCOSIGNER", weight: 10, type: "ed25519_public_key" },
        ],
        thresholds: { low_threshold: 10, med_threshold: 15, high_threshold: 20 },
      }),
    );

    const status = await checkMultisigStatus(pool, PUBLIC_KEY);
    expect(status.isMultisig).toBe(true);
    expect(status.signerCount).toBe(2);
  });

  it("edge case: a single signer whose weight is below the medium threshold is multisig-equivalent", async () => {
    const pool = fakePool(async () =>
      jsonResponse(200, {
        signers: [{ key: PUBLIC_KEY, weight: 1, type: "ed25519_public_key" }],
        thresholds: { low_threshold: 1, med_threshold: 5, high_threshold: 10 },
      }),
    );

    const status = await checkMultisigStatus(pool, PUBLIC_KEY);
    expect(status.isMultisig).toBe(true);
    expect(status.ownSignerWeight).toBe(1);
  });

  it("edge case: an unfunded account (404) reports as not multisig rather than throwing", async () => {
    const pool = fakePool(async () => jsonResponse(404, { status: 404, type: "not_found" }));

    const status = await checkMultisigStatus(pool, PUBLIC_KEY);
    expect(status.isMultisig).toBe(false);
    expect(status.signerCount).toBe(0);
  });

  it("failure state: a transport failure becomes a typed MultisigDetectionError, not a raw rejection", async () => {
    const pool = fakePool(async () => {
      throw new Error("ECONNRESET");
    });

    await expect(checkMultisigStatus(pool, PUBLIC_KEY)).rejects.toBeInstanceOf(
      MultisigDetectionError,
    );
  });
});

describe("assertNotMultisigBeforeSigning (#736)", () => {
  it("blocks signing with a clear message when the connected account is multisig", async () => {
    vi.resetModules();
    vi.doMock("./kit.js", () => ({ kit: { getNetwork: vi.fn() } }));
    vi.doMock("../vault/data/queryClient.js", () => ({ vaultQueryClient: { clear: vi.fn() } }));

    const { multisigStatus } = await import("./store.js");
    const { assertNotMultisigBeforeSigning, MultisigUnsupportedError } = await import(
      "./walletService.js"
    );

    multisigStatus.set({
      isMultisig: true,
      signerCount: 2,
      ownSignerWeight: 10,
      thresholds: { low: 1, med: 15, high: 20 },
    });

    expect(() => assertNotMultisigBeforeSigning()).toThrow(MultisigUnsupportedError);

    multisigStatus.set(null);
  });

  it("does not block when there is no detected multisig status", async () => {
    vi.resetModules();
    vi.doMock("./kit.js", () => ({ kit: { getNetwork: vi.fn() } }));
    vi.doMock("../vault/data/queryClient.js", () => ({ vaultQueryClient: { clear: vi.fn() } }));

    const { multisigStatus } = await import("./store.js");
    const { assertNotMultisigBeforeSigning } = await import("./walletService.js");

    multisigStatus.set(null);
    expect(() => assertNotMultisigBeforeSigning()).not.toThrow();
  });
});
