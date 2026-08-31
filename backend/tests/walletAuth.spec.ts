import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WalletAuthService } from "../src/services/walletAuth";
import { PrismaClient } from "@prisma/client";
import { Keypair } from "@stellar/stellar-sdk";

const prisma = new PrismaClient();

describe("WalletAuthService", () => {
  let svc: WalletAuthService;
  let kp: Keypair;

  beforeEach(async () => {
    svc = new WalletAuthService(prisma);
    kp = Keypair.random();
    await prisma.walletSession.deleteMany();
    await prisma.walletChallenge.deleteMany();
  });

  afterEach(async () => {
    await prisma.walletSession.deleteMany();
    await prisma.walletChallenge.deleteMany();
  });

  it("verifies a valid signed payload with correct domain fields", async () => {
    const challenge = await svc.createChallenge({
      walletAddress: kp.publicKey(),
      publicKey: kp.publicKey(),
      network: "TESTNET",
    });

    const payload = JSON.stringify({
      appName: "VaultQuest",
      network: "TESTNET",
      purpose: "API_AUTHENTICATION",
      nonce: challenge.nonce,
    });

    const signature = kp.sign(Buffer.from(payload)).toString("base64");

    const session = await svc.verifyChallenge({
      challengeId: challenge.challengeId,
      payload,
      signature,
      publicKey: kp.publicKey(),
      network: "TESTNET",
    });

    expect(session.token).toBeDefined();
    expect(session.publicKey).toBe(kp.publicKey());
  });

  it("rejects when appName is wrong", async () => {
    const challenge = await svc.createChallenge({
      walletAddress: kp.publicKey(),
      publicKey: kp.publicKey(),
      network: "TESTNET",
    });

    const payload = JSON.stringify({
      appName: "EvilApp",
      network: "TESTNET",
      purpose: "API_AUTHENTICATION",
      nonce: challenge.nonce,
    });

    const signature = kp.sign(Buffer.from(payload)).toString("base64");

    await expect(
      svc.verifyChallenge({
        challengeId: challenge.challengeId,
        payload,
        signature,
        publicKey: kp.publicKey(),
        network: "TESTNET",
      })
    ).rejects.toThrow("Unauthorized");
  });

  it("rejects when network is mismatched", async () => {
    const challenge = await svc.createChallenge({
      walletAddress: kp.publicKey(),
      publicKey: kp.publicKey(),
      network: "TESTNET",
    });

    // Sign for PUBLIC but send to TESTNET challenge
    const payload = JSON.stringify({
      appName: "VaultQuest",
      network: "PUBLIC",
      purpose: "API_AUTHENTICATION",
      nonce: challenge.nonce,
    });

    const signature = kp.sign(Buffer.from(payload)).toString("base64");

    await expect(
      svc.verifyChallenge({
        challengeId: challenge.challengeId,
        payload,
        signature,
        publicKey: kp.publicKey(),
        network: "TESTNET",
      })
    ).rejects.toThrow("Unauthorized");
  });

  it("rejects when nonce does not match challenge", async () => {
    const challenge = await svc.createChallenge({
      walletAddress: kp.publicKey(),
      publicKey: kp.publicKey(),
      network: "TESTNET",
    });

    const payload = JSON.stringify({
      appName: "VaultQuest",
      network: "TESTNET",
      purpose: "API_AUTHENTICATION",
      nonce: "some-other-nonce",
    });

    const signature = kp.sign(Buffer.from(payload)).toString("base64");

    await expect(
      svc.verifyChallenge({
        challengeId: challenge.challengeId,
        payload,
        signature,
        publicKey: kp.publicKey(),
        network: "TESTNET",
      })
    ).rejects.toThrow("Unauthorized");
  });

  it("rejects when signature does not match payload", async () => {
    const challenge = await svc.createChallenge({
      walletAddress: kp.publicKey(),
      publicKey: kp.publicKey(),
      network: "TESTNET",
    });

    const payload = JSON.stringify({
      appName: "VaultQuest",
      network: "TESTNET",
      purpose: "API_AUTHENTICATION",
      nonce: challenge.nonce,
    });

    // Tamper with payload after signing
    const signature = kp.sign(Buffer.from(payload)).toString("base64");
    const tamperedPayload = payload.replace("TESTNET", "PUBLIC");

    await expect(
      svc.verifyChallenge({
        challengeId: challenge.challengeId,
        payload: tamperedPayload,
        signature,
        publicKey: kp.publicKey(),
        network: "TESTNET",
      })
    ).rejects.toThrow("Unauthorized");
  });

  it("rejects when payload is expired", async () => {
    const challenge = await svc.createChallenge({
      walletAddress: kp.publicKey(),
      publicKey: kp.publicKey(),
      network: "TESTNET",
    });

    const expiredDate = new Date(Date.now() - 1000).toISOString();
    const payload = JSON.stringify({
      appName: "VaultQuest",
      network: "TESTNET",
      purpose: "API_AUTHENTICATION",
      nonce: challenge.nonce,
      expiresAt: expiredDate,
    });

    const signature = kp.sign(Buffer.from(payload)).toString("base64");

    await expect(
      svc.verifyChallenge({
        challengeId: challenge.challengeId,
        payload,
        signature,
        publicKey: kp.publicKey(),
        network: "TESTNET",
      })
    ).rejects.toThrow("Unauthorized");
  });

  it("rejects replayed signatures", async () => {
    const challenge = await svc.createChallenge({
      walletAddress: kp.publicKey(),
      publicKey: kp.publicKey(),
      network: "TESTNET",
    });

    const payload = JSON.stringify({
      appName: "VaultQuest",
      network: "TESTNET",
      purpose: "API_AUTHENTICATION",
      nonce: challenge.nonce,
    });

    const signature = kp.sign(Buffer.from(payload)).toString("base64");

    // First attempt succeeds
    await svc.verifyChallenge({
      challengeId: challenge.challengeId,
      payload,
      signature,
      publicKey: kp.publicKey(),
      network: "TESTNET",
    });

    // Replay fails
    await expect(
      svc.verifyChallenge({
        challengeId: challenge.challengeId,
        payload,
        signature,
        publicKey: kp.publicKey(),
        network: "TESTNET",
      })
    ).rejects.toThrow("Unauthorized");
  });

  it("rejects expired challenges even when the signature is otherwise valid", async () => {
    const challenge = await svc.createChallenge({
      walletAddress: kp.publicKey(),
      publicKey: kp.publicKey(),
      network: "TESTNET",
    });

    // Force the stored challenge to be past expiry.
    await prisma.walletChallenge.update({
      where: { challengeId: challenge.challengeId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const payload = JSON.stringify({
      appName: "VaultQuest",
      network: "TESTNET",
      purpose: "API_AUTHENTICATION",
      nonce: challenge.nonce,
    });
    const signature = kp.sign(Buffer.from(payload)).toString("base64");

    await expect(
      svc.verifyChallenge({
        challengeId: challenge.challengeId,
        payload,
        signature,
        publicKey: kp.publicKey(),
        network: "TESTNET",
      })
    ).rejects.toThrow("Unauthorized");
  });

  it("only succeeds once for concurrent double-verify (single-use nonce, #566)", async () => {
    const challenge = await svc.createChallenge({
      walletAddress: kp.publicKey(),
      publicKey: kp.publicKey(),
      network: "TESTNET",
    });

    const payload = JSON.stringify({
      appName: "VaultQuest",
      network: "TESTNET",
      purpose: "API_AUTHENTICATION",
      nonce: challenge.nonce,
    });
    const signature = kp.sign(Buffer.from(payload)).toString("base64");

    const input = {
      challengeId: challenge.challengeId,
      payload,
      signature,
      publicKey: kp.publicKey(),
      network: "TESTNET",
    };

    // Fire both verifications concurrently — this is the classic TOCTOU
    // window (both read consumedAt = null before either updates).
    const results = await Promise.allSettled([
      svc.verifyChallenge(input),
      svc.verifyChallenge(input),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    // Exactly one verification wins; the other must be rejected.
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // Exactly one session token was issued for this challenge.
    const sessions = await prisma.walletSession.findMany({
      where: { walletAddress: kp.publicKey() },
    });
    expect(sessions).toHaveLength(1);
  });
});
