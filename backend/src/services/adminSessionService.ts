import crypto from "crypto";
import type { PrismaClient } from "@prisma/client";

export interface AdminSession {
  sessionId: string;
  walletAddress: string;
  signature: string;
  audience: string;
  roleVersion: number;
  expiresAt: Date;
  createdAt: Date;
  revokedAt: Date | null;
}

export class AdminSessionService {
  private sessionCache: Map<string, AdminSession> = new Map();

  constructor(private readonly prisma: PrismaClient) {}

  generateSessionId(): string {
    return crypto.randomBytes(32).toString("hex");
  }

  async createSession(input: {
    walletAddress: string;
    signature: string;
    audience: string;
    roleVersion: number;
    ttlSeconds?: number;
  }): Promise<AdminSession> {
    const sessionId = this.generateSessionId();
    const ttl = input.ttlSeconds ?? 3600;
    const expiresAt = new Date(Date.now() + ttl * 1000);

    const session = await this.prisma.adminSession.create({
      data: {
        sessionId,
        walletAddress: input.walletAddress,
        signature: input.signature,
        audience: input.audience,
        roleVersion: input.roleVersion,
        expiresAt
      }
    });

    const result: AdminSession = {
      sessionId: session.sessionId,
      walletAddress: session.walletAddress,
      signature: session.signature,
      audience: session.audience,
      roleVersion: session.roleVersion,
      expiresAt: session.expiresAt,
      createdAt: session.createdAt,
      revokedAt: session.revokedAt
    };

    this.sessionCache.set(sessionId, result);
    return result;
  }

  async verifySession(sessionId: string): Promise<AdminSession | null> {
    let session = this.sessionCache.get(sessionId);

    if (!session) {
      const row = await this.prisma.adminSession.findUnique({
        where: { sessionId }
      });
      if (!row) return null;
      session = {
        sessionId: row.sessionId,
        walletAddress: row.walletAddress,
        signature: row.signature,
        audience: row.audience,
        roleVersion: row.roleVersion,
        expiresAt: row.expiresAt,
        createdAt: row.createdAt,
        revokedAt: row.revokedAt
      };
    }

    if (session.revokedAt || session.expiresAt < new Date()) {
      return null;
    }

    return session;
  }

  async revokeSessionsByRole(roleVersion: number): Promise<number> {
    const result = await this.prisma.adminSession.updateMany({
      where: { roleVersion },
      data: { revokedAt: new Date() }
    });

    this.sessionCache.clear();
    return result.count;
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.prisma.adminSession.update({
      where: { sessionId },
      data: { revokedAt: new Date() }
    });
    this.sessionCache.delete(sessionId);
  }
}
