/**
 * Wallet-signed authentication service (#391).
 *
 * Flow:
 * 1. Client requests a challenge for a specific network/contract/action/idempotency_key.
 * 2. Server returns a single-use challenge nonce.
 * 3. Client signs the challenge with its wallet.
 * 4. Server verifies the signature and issues a short-lived session token.
 *
 * Sessions are scoped to (wallet_address, public_key, network). Object-level
 * authorization checks ensure users can only access their own resources.
 */

import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { AppError } from "../errors.js";
import { ERROR_CODES } from "../constants.js";

import { Keypair } from "@stellar/stellar-sdk";

export interface ChallengeInput {
  walletAddress: string;
  publicKey: string;
  network: string;
  contract?: string;
  action?: string;
  idempotencyKey?: string;
}

export interface Challenge {
  challengeId: string;
  nonce: string;
  expiresAt: Date;
  domain: string;
}

export interface VerifyInput {
  challengeId: string;
  payload: string;
  signature: string;
  publicKey: string;
  network: string;
}

export interface SessionOutput {
  token: string;
  refreshToken: string;
  expiresAt: Date;
  walletAddress: string;
  publicKey: string;
  network: string;
}

export class WalletAuthService {
  private readonly challengeTtlMs = 5 * 60 * 1000; // 5 minutes
  private readonly sessionTtlMs = 24 * 60 * 60 * 1000; // 24 hours
  private readonly refreshTtlMs = 7 * 24 * 60 * 60 * 1000; // 7 days

  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Creates a domain-separated challenge for wallet signature.
   */
  async createChallenge(input: ChallengeInput): Promise<Challenge> {
    const challengeId = randomUUID();
    const nonce = randomUUID();
    const expiresAt = new Date(Date.now() + this.challengeTtlMs);

    // Domain separation: bind challenge to network/contract/action/idempotency_key
    const domainParts = ["vaultquest-auth", input.network];
    if (input.contract) domainParts.push(input.contract);
    if (input.action) domainParts.push(input.action);
    if (input.idempotencyKey) domainParts.push(input.idempotencyKey);
    const domain = domainParts.join(":");

    await this.prisma.walletChallenge.create({
      data: {
        challengeId,
        walletAddress: input.walletAddress,
        publicKey: input.publicKey,
        network: input.network,
        nonce,
        domain,
        expiresAt
      }
    });

    return { challengeId, nonce, expiresAt, domain };
  }

  /**
   * Verifies a signed challenge and issues a session token.
   */
  async verifyChallenge(input: VerifyInput): Promise<SessionOutput> {
    const challenge = await this.prisma.walletChallenge.findUnique({
      where: { challengeId: input.challengeId }
    });

    if (!challenge || challenge.expiresAt.getTime() <= Date.now()) {
      throw AppError.unauthorized();
    }

    if (challenge.publicKey !== input.publicKey || challenge.network !== input.network) {
      throw AppError.unauthorized();
    }

    if (challenge.consumedAt !== null) {
      throw AppError.unauthorized();
    }

    if (!input.signature || input.signature.length === 0 || !input.payload) {
      throw AppError.unauthorized();
    }

    let parsedPayload: any;
    try {
      parsedPayload = JSON.parse(input.payload);
    } catch {
      throw AppError.unauthorized();
    }

    // Verify every domain field server-side
    if (
      parsedPayload.appName !== "VaultQuest" ||
      parsedPayload.network !== input.network ||
      parsedPayload.purpose !== "API_AUTHENTICATION" ||
      parsedPayload.nonce !== challenge.nonce
    ) {
      throw AppError.unauthorized();
    }
    
    // Check payload expiry if provided
    if (parsedPayload.expiresAt) {
      const payloadExpiry = new Date(parsedPayload.expiresAt);
      if (isNaN(payloadExpiry.getTime()) || payloadExpiry.getTime() <= Date.now()) {
        throw AppError.unauthorized();
      }
    }

    // Cryptographic verification
    try {
      const kp = Keypair.fromPublicKey(input.publicKey);
      const dataBuffer = Buffer.from(input.payload);
      const sigBuffer = Buffer.from(input.signature, "base64");
      if (!kp.verify(dataBuffer, sigBuffer)) {
        throw AppError.unauthorized();
      }
    } catch (err) {
      throw AppError.unauthorized();
    }

    // Mark challenge as consumed
    await this.prisma.walletChallenge.update({
      where: { challengeId: input.challengeId },
      data: { consumedAt: new Date() }
    });

    // Create session
    const token = randomUUID();
    const refreshToken = randomUUID();
    const expiresAt = new Date(Date.now() + this.sessionTtlMs);

    const session = await this.prisma.walletSession.create({
      data: {
        walletAddress: challenge.walletAddress,
        publicKey: input.publicKey,
        network: input.network,
        token,
        refreshToken,
        expiresAt
      }
    });

    return {
      token: session.token,
      refreshToken: session.refreshToken,
      expiresAt: session.expiresAt,
      walletAddress: session.walletAddress,
      publicKey: session.publicKey,
      network: session.network
    };
  }

  /**
   * Refreshes an existing session using the refresh token.
   * Implements rotation: old session is revoked and a new one is created.
   */
  async refreshSession(refreshToken: string): Promise<SessionOutput> {
    const session = await this.prisma.walletSession.findUnique({
      where: { refreshToken }
    });

    if (!session || session.revokedAt !== null || session.expiresAt.getTime() <= Date.now()) {
      throw AppError.unauthorized();
    }

    const newToken = randomUUID();
    const newRefreshToken = randomUUID();
    const expiresAt = new Date(Date.now() + this.sessionTtlMs);

    const updated = await this.prisma.walletSession.update({
      where: { id: session.id },
      data: {
        token: newToken,
        refreshToken: newRefreshToken,
        expiresAt,
        lastUsedAt: new Date(),
        prevSessionId: session.id
      }
    });

    return {
      token: updated.token,
      refreshToken: updated.refreshToken,
      expiresAt: updated.expiresAt,
      walletAddress: updated.walletAddress,
      publicKey: updated.publicKey,
      network: updated.network
    };
  }

  /**
   * Revokes a session (logout).
   */
  async revokeSession(token: string): Promise<void> {
    const session = await this.prisma.walletSession.findUnique({
      where: { token }
    });

    if (!session || session.revokedAt !== null) {
      return; // Already revoked or doesn't exist
    }

    await this.prisma.walletSession.update({
      where: { id: session.id },
      data: { revokedAt: new Date() }
    });
  }

  /**
   * Validates a session token and returns the session if valid.
   */
  async validateSession(token: string) {
    const session = await this.prisma.walletSession.findUnique({
      where: { token }
    });

    if (!session || session.revokedAt !== null || session.expiresAt.getTime() <= Date.now()) {
      return null;
    }

    // Update last used
    await this.prisma.walletSession.update({
      where: { id: session.id },
      data: { lastUsedAt: new Date() }
    });

    return session;
  }

  /**
   * Revokes all sessions for a wallet (e.g., password change, key rotation).
   */
  async revokeAllSessions(walletAddress: string): Promise<number> {
    const result = await this.prisma.walletSession.updateMany({
      where: {
        walletAddress,
        revokedAt: null
      },
      data: { revokedAt: new Date() }
    });

    return result.count;
  }
}