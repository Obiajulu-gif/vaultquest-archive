import { describe, it, expect, vi, beforeEach } from "vitest";
import { WalletAuthService } from "../src/services/walletAuth";

function createMockPrisma() {
  return {
    walletChallenge: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn()
    },
    walletSession: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn()
    }
  };
}

describe("WalletAuthService", () => {
  let svc: WalletAuthService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma = createMockPrisma();
    svc = new WalletAuthService(prisma as any);
  });

  describe("createChallenge", () => {
    it("creates a challenge with correct fields", async () => {
      prisma.walletChallenge.create.mockResolvedValue({});

      const result = await svc.createChallenge({
        walletAddress: "GABC123",
        publicKey: "GDEF456",
        network: "TESTNET"
      });

      expect(result.challengeId).toBeDefined();
      expect(result.nonce).toBeDefined();
      expect(result.expiresAt).toBeInstanceOf(Date);
      expect(result.domain).toContain("vaultquest-auth");
      expect(result.domain).toContain("TESTNET");
      expect(prisma.walletChallenge.create).toHaveBeenCalledOnce();
    });

    it("includes contract in domain when provided", async () => {
      prisma.walletChallenge.create.mockResolvedValue({});

      const result = await svc.createChallenge({
        walletAddress: "GABC123",
        publicKey: "GDEF456",
        network: "TESTNET",
        contract: "contract123"
      });

      expect(result.domain).toContain("contract123");
    });

    it("includes action in domain when provided", async () => {
      prisma.walletChallenge.create.mockResolvedValue({});

      const result = await svc.createChallenge({
        walletAddress: "GABC123",
        publicKey: "GDEF456",
        network: "TESTNET",
        action: "deposit"
      });

      expect(result.domain).toContain("deposit");
    });

    it("includes idempotency key in domain when provided", async () => {
      prisma.walletChallenge.create.mockResolvedValue({});

      const result = await svc.createChallenge({
        walletAddress: "GABC123",
        publicKey: "GDEF456",
        network: "TESTNET",
        idempotencyKey: "idem-key-123"
      });

      expect(result.domain).toContain("idem-key-123");
    });
  });

  describe("verifyChallenge", () => {
    it("rejects when challenge does not exist", async () => {
      prisma.walletChallenge.findUnique.mockResolvedValue(null);

      await expect(
        svc.verifyChallenge({
          challengeId: "nonexistent",
          payload: "{}",
          signature: "sig",
          publicKey: "GKEY",
          network: "TESTNET"
        })
      ).rejects.toThrow("unauthorized");
    });

    it("rejects when challenge is expired", async () => {
      prisma.walletChallenge.findUnique.mockResolvedValue({
        challengeId: "ch1",
        expiresAt: new Date(Date.now() - 1000),
        publicKey: "GKEY",
        network: "TESTNET",
        consumedAt: null,
        nonce: "nonce1"
      });

      await expect(
        svc.verifyChallenge({
          challengeId: "ch1",
          payload: "{}",
          signature: "sig",
          publicKey: "GKEY",
          network: "TESTNET"
        })
      ).rejects.toThrow("unauthorized");
    });

    it("rejects when public key does not match", async () => {
      prisma.walletChallenge.findUnique.mockResolvedValue({
        challengeId: "ch1",
        expiresAt: new Date(Date.now() + 60000),
        publicKey: "GKEY_OTHER",
        network: "TESTNET",
        consumedAt: null,
        nonce: "nonce1"
      });

      await expect(
        svc.verifyChallenge({
          challengeId: "ch1",
          payload: "{}",
          signature: "sig",
          publicKey: "GKEY",
          network: "TESTNET"
        })
      ).rejects.toThrow("unauthorized");
    });

    it("rejects when network does not match", async () => {
      prisma.walletChallenge.findUnique.mockResolvedValue({
        challengeId: "ch1",
        expiresAt: new Date(Date.now() + 60000),
        publicKey: "GKEY",
        network: "PUBLIC",
        consumedAt: null,
        nonce: "nonce1"
      });

      await expect(
        svc.verifyChallenge({
          challengeId: "ch1",
          payload: "{}",
          signature: "sig",
          publicKey: "GKEY",
          network: "TESTNET"
        })
      ).rejects.toThrow("unauthorized");
    });

    it("rejects when challenge is already consumed", async () => {
      prisma.walletChallenge.findUnique.mockResolvedValue({
        challengeId: "ch1",
        expiresAt: new Date(Date.now() + 60000),
        publicKey: "GKEY",
        network: "TESTNET",
        consumedAt: new Date(),
        nonce: "nonce1"
      });

      await expect(
        svc.verifyChallenge({
          challengeId: "ch1",
          payload: "{}",
          signature: "sig",
          publicKey: "GKEY",
          network: "TESTNET"
        })
      ).rejects.toThrow("unauthorized");
    });

    it("rejects when signature is empty", async () => {
      prisma.walletChallenge.findUnique.mockResolvedValue({
        challengeId: "ch1",
        expiresAt: new Date(Date.now() + 60000),
        publicKey: "GKEY",
        network: "TESTNET",
        consumedAt: null,
        nonce: "nonce1"
      });

      await expect(
        svc.verifyChallenge({
          challengeId: "ch1",
          payload: "{}",
          signature: "",
          publicKey: "GKEY",
          network: "TESTNET"
        })
      ).rejects.toThrow("unauthorized");
    });

    it("rejects when payload is invalid JSON", async () => {
      prisma.walletChallenge.findUnique.mockResolvedValue({
        challengeId: "ch1",
        expiresAt: new Date(Date.now() + 60000),
        publicKey: "GKEY",
        network: "TESTNET",
        consumedAt: null,
        nonce: "nonce1"
      });

      await expect(
        svc.verifyChallenge({
          challengeId: "ch1",
          payload: "not-json",
          signature: "sig",
          publicKey: "GKEY",
          network: "TESTNET"
        })
      ).rejects.toThrow("unauthorized");
    });

    it("rejects when appName is wrong", async () => {
      prisma.walletChallenge.findUnique.mockResolvedValue({
        challengeId: "ch1",
        expiresAt: new Date(Date.now() + 60000),
        publicKey: "GKEY",
        network: "TESTNET",
        consumedAt: null,
        nonce: "nonce1"
      });

      const payload = JSON.stringify({
        appName: "EvilApp",
        network: "TESTNET",
        purpose: "API_AUTHENTICATION",
        nonce: "nonce1"
      });

      await expect(
        svc.verifyChallenge({
          challengeId: "ch1",
          payload,
          signature: "sig",
          publicKey: "GKEY",
          network: "TESTNET"
        })
      ).rejects.toThrow("unauthorized");
    });

    it("rejects when purpose is wrong", async () => {
      prisma.walletChallenge.findUnique.mockResolvedValue({
        challengeId: "ch1",
        expiresAt: new Date(Date.now() + 60000),
        publicKey: "GKEY",
        network: "TESTNET",
        consumedAt: null,
        nonce: "nonce1"
      });

      const payload = JSON.stringify({
        appName: "VaultQuest",
        network: "TESTNET",
        purpose: "WRONG_PURPOSE",
        nonce: "nonce1"
      });

      await expect(
        svc.verifyChallenge({
          challengeId: "ch1",
          payload,
          signature: "sig",
          publicKey: "GKEY",
          network: "TESTNET"
        })
      ).rejects.toThrow("unauthorized");
    });

    it("rejects when nonce does not match", async () => {
      prisma.walletChallenge.findUnique.mockResolvedValue({
        challengeId: "ch1",
        expiresAt: new Date(Date.now() + 60000),
        publicKey: "GKEY",
        network: "TESTNET",
        consumedAt: null,
        nonce: "correct-nonce"
      });

      const payload = JSON.stringify({
        appName: "VaultQuest",
        network: "TESTNET",
        purpose: "API_AUTHENTICATION",
        nonce: "wrong-nonce"
      });

      await expect(
        svc.verifyChallenge({
          challengeId: "ch1",
          payload,
          signature: "sig",
          publicKey: "GKEY",
          network: "TESTNET"
        })
      ).rejects.toThrow("unauthorized");
    });
  });

  describe("refreshSession", () => {
    it("rejects when session does not exist", async () => {
      prisma.walletSession.findUnique.mockResolvedValue(null);

      await expect(svc.refreshSession("nonexistent")).rejects.toThrow("unauthorized");
    });

    it("rejects when session is revoked", async () => {
      prisma.walletSession.findUnique.mockResolvedValue({
        id: "session1",
        refreshToken: "refresh1",
        revokedAt: new Date(),
        expiresAt: new Date(Date.now() + 60000)
      });

      await expect(svc.refreshSession("refresh1")).rejects.toThrow("unauthorized");
    });

    it("rejects when session is expired", async () => {
      prisma.walletSession.findUnique.mockResolvedValue({
        id: "session1",
        refreshToken: "refresh1",
        revokedAt: null,
        expiresAt: new Date(Date.now() - 1000)
      });

      await expect(svc.refreshSession("refresh1")).rejects.toThrow("unauthorized");
    });

    it("creates new session on valid refresh", async () => {
      prisma.walletSession.findUnique.mockResolvedValue({
        id: "session1",
        refreshToken: "refresh1",
        walletAddress: "GABC",
        publicKey: "GDEF",
        network: "TESTNET",
        revokedAt: null,
        expiresAt: new Date(Date.now() + 60000)
      });

      prisma.walletSession.update.mockResolvedValue({
        id: "session2",
        token: "new-token",
        refreshToken: "new-refresh",
        expiresAt: new Date(Date.now() + 86400000),
        walletAddress: "GABC",
        publicKey: "GDEF",
        network: "TESTNET"
      });

      const result = await svc.refreshSession("refresh1");

      expect(result.token).toBe("new-token");
      expect(result.refreshToken).toBe("new-refresh");
      expect(prisma.walletSession.update).toHaveBeenCalledOnce();
    });
  });

  describe("revokeSession", () => {
    it("does nothing for nonexistent session", async () => {
      prisma.walletSession.findUnique.mockResolvedValue(null);

      await svc.revokeSession("nonexistent");

      expect(prisma.walletSession.update).not.toHaveBeenCalled();
    });

    it("does nothing for already revoked session", async () => {
      prisma.walletSession.findUnique.mockResolvedValue({
        id: "session1",
        revokedAt: new Date()
      });

      await svc.revokeSession("token1");

      expect(prisma.walletSession.update).not.toHaveBeenCalled();
    });

    it("revokes an active session", async () => {
      prisma.walletSession.findUnique.mockResolvedValue({
        id: "session1",
        revokedAt: null
      });
      prisma.walletSession.update.mockResolvedValue({});

      await svc.revokeSession("token1");

      expect(prisma.walletSession.update).toHaveBeenCalledWith({
        where: { id: "session1" },
        data: { revokedAt: expect.any(Date) }
      });
    });
  });

  describe("validateSession", () => {
    it("returns null for nonexistent session", async () => {
      prisma.walletSession.findUnique.mockResolvedValue(null);

      const result = await svc.validateSession("nonexistent");

      expect(result).toBeNull();
    });

    it("returns null for revoked session", async () => {
      prisma.walletSession.findUnique.mockResolvedValue({
        id: "session1",
        revokedAt: new Date(),
        expiresAt: new Date(Date.now() + 60000)
      });

      const result = await svc.validateSession("token1");

      expect(result).toBeNull();
    });

    it("returns null for expired session", async () => {
      prisma.walletSession.findUnique.mockResolvedValue({
        id: "session1",
        revokedAt: null,
        expiresAt: new Date(Date.now() - 1000)
      });

      const result = await svc.validateSession("token1");

      expect(result).toBeNull();
    });

    it("returns session for valid token", async () => {
      const mockSession = {
        id: "session1",
        revokedAt: null,
        expiresAt: new Date(Date.now() + 60000),
        walletAddress: "GABC"
      };
      prisma.walletSession.findUnique.mockResolvedValue(mockSession);
      prisma.walletSession.update.mockResolvedValue({});

      const result = await svc.validateSession("token1");

      expect(result).toEqual(mockSession);
      expect(prisma.walletSession.update).toHaveBeenCalled();
    });
  });

  describe("revokeAllSessions", () => {
    it("revokes all active sessions for a wallet", async () => {
      prisma.walletSession.updateMany.mockResolvedValue({ count: 3 });

      const count = await svc.revokeAllSessions("GABC");

      expect(count).toBe(3);
      expect(prisma.walletSession.updateMany).toHaveBeenCalledWith({
        where: {
          walletAddress: "GABC",
          revokedAt: null
        },
        data: { revokedAt: expect.any(Date) }
      });
    });

    it("returns 0 when no active sessions exist", async () => {
      prisma.walletSession.updateMany.mockResolvedValue({ count: 0 });

      const count = await svc.revokeAllSessions("GABC");

      expect(count).toBe(0);
    });
  });
});
