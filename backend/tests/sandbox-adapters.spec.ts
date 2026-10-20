import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { parseSandboxConfig } from "../src/sandbox/config.js";
import { createSandboxEscrowDependencies } from "../src/sandbox/escrowAdapters.js";
import { SANDBOX_AMOUNT, SANDBOX_RECIPIENT } from "../src/sandbox/fixtures.js";

const prisma = {} as PrismaClient;
const settlement = {
  vaultId: "sandbox-vault",
  sequence: "10001",
  settlementType: "release",
  recipient: SANDBOX_RECIPIENT,
  amount: SANDBOX_AMOUNT
};

async function submitScenario(scenario: Parameters<typeof createSandboxEscrowDependencies>[1]) {
  const dependencies = createSandboxEscrowDependencies(prisma, scenario);
  const prepared = await dependencies.assembler.assemble(settlement);
  const signed = await dependencies.signer.sign(prepared.xdr);
  let result: Awaited<ReturnType<typeof dependencies.horizon.submit>> | null = null;
  let thrown: Error | null = null;
  try {
    result = await dependencies.horizon.submit(signed);
  } catch (error) {
    thrown = error as Error;
  }
  return { dependencies, result, thrown, signed };
}

describe("sandbox escrow adapters", () => {
  it("returns the same deterministic transaction for identical inputs", async () => {
    const first = await submitScenario("success");
    const second = await submitScenario("success");

    expect(first.result).toEqual(second.result);
    expect(first.signed).toBe(second.signed);
    expect(first.result).toEqual({
      hash: "sandbox-success-tx-0001",
      successful: true,
      resultCode: "tx_success"
    });
    expect(first.dependencies.trace.sequenceLoads).toBe(0);
    expect(first.dependencies.trace.verifications).toEqual([]);
  });

  it("scripts retryable sequence and timeout failures", async () => {
    const retry = await submitScenario("retry_once");
    expect(retry.result).toMatchObject({ successful: false, resultCode: "tx_bad_seq" });
    const timeout = await submitScenario("timeout_once");
    expect(timeout.thrown?.message).toBe("timeout");
  });

  it("scripts permanent submission and payout-verification failures", async () => {
    const failure = await submitScenario("submit_failure");
    expect(failure.result).toMatchObject({ successful: false, resultCode: "tx_bad_auth" });

    const pending = createSandboxEscrowDependencies(prisma, "verification_pending");
    await expect(pending.verifier?.verify("sandbox-tx")).resolves.toBeNull();
    const mismatch = createSandboxEscrowDependencies(prisma, "verification_mismatch");
    await expect(mismatch.verifier?.verify("sandbox-tx")).resolves.toEqual({
      recipient: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABCD",
      amount: "99.00",
      asset: "USDC"
    });
  });
});

describe("sandbox configuration safety", () => {
  it("accepts an isolated loopback database without production credentials", () => {
    expect(parseSandboxConfig({
      SANDBOX_MODE: "true",
      SANDBOX_DATABASE_URL: "postgresql://sandbox:sandbox@127.0.0.1:55432/vaultquest_sandbox",
      SANDBOX_SCENARIO: "success",
      NODE_ENV: "development"
    })).toMatchObject({ scenario: "success" });
  });

  it("rejects remote database hosts and production mode", () => {
    const remote = {
      SANDBOX_MODE: "true",
      SANDBOX_DATABASE_URL: "postgresql://sandbox:sandbox@db.example.com/vaultquest_sandbox",
      NODE_ENV: "development"
    };
    expect(() => parseSandboxConfig(remote)).toThrow(/loopback/);
    expect(() => parseSandboxConfig({
      ...remote,
      NODE_ENV: "production",
      SANDBOX_DATABASE_URL: "postgresql://sandbox:sandbox@localhost/vaultquest_sandbox"
    })).toThrow(/production/);
  });
});