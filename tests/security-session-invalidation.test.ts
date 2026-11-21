import { describe, it, expect, beforeEach } from "vitest";
import {
  SecuritySessionManager,
  SecurityInvalidationError,
  computeReceiptDigest,
} from "../lib/security-session-invalidation";

describe("Security-Event Session Invalidation (#1120, #1168)", () => {
  let manager: SecuritySessionManager;

  const USER_ALICE = "G_ALICE_WALLET_ADDRESS_7193";
  const USER_BOB = "G_BOB_WALLET_ADDRESS_2841";

  beforeEach(() => {
    manager = new SecuritySessionManager();
  });

  describe("Normal Paths", () => {
    it("creates active sessions and validates with initial token version", () => {
      const session = manager.createSession({ principalId: USER_ALICE });
      expect(session.sessionId).toBeDefined();
      expect(session.tokenVersion).toBe(1);

      const val = manager.validateSession(session.sessionId);
      expect(val.valid).toBe(true);
      expect(val.session?.sessionId).toBe(session.sessionId);
    });

    it("invalidates all sessions on key rotation and bumps token version", async () => {
      const s1 = manager.createSession({ principalId: USER_ALICE });
      const s2 = manager.createSession({ principalId: USER_ALICE });

      const receipt = await manager.invalidateOnSecurityEvent({
        targetPrincipalId: USER_ALICE,
        event: "key_rotation",
        scope: "all_sessions",
        actor: { principalId: USER_ALICE, role: "user" },
      });

      expect(receipt.invalidatedCount).toBe(2);
      expect(receipt.invalidatedSessionIds).toContain(s1.sessionId);
      expect(receipt.invalidatedSessionIds).toContain(s2.sessionId);
      expect(receipt.tokenVersion).toBe(2);

      // Both old sessions are now invalid
      expect(manager.validateSession(s1.sessionId).valid).toBe(false);
      expect(manager.validateSession(s2.sessionId).valid).toBe(false);
      expect(manager.validateSession(s1.sessionId).reason).toBe("SESSION_INVALIDATED");

      // Newly created session gets the new token version
      const sNew = manager.createSession({ principalId: USER_ALICE });
      expect(sNew.tokenVersion).toBe(2);
      expect(manager.validateSession(sNew.sessionId).valid).toBe(true);
    });

    it("supports 'all_except_current' scope during self-initiated credential rotation", async () => {
      const sCurrent = manager.createSession({ principalId: USER_ALICE });
      const sOther1 = manager.createSession({ principalId: USER_ALICE });
      const sOther2 = manager.createSession({ principalId: USER_ALICE });

      const receipt = await manager.invalidateOnSecurityEvent({
        targetPrincipalId: USER_ALICE,
        event: "password_change",
        scope: "all_except_current",
        currentSessionId: sCurrent.sessionId,
        actor: { principalId: USER_ALICE, role: "user" },
      });

      expect(receipt.invalidatedCount).toBe(2);
      expect(receipt.invalidatedSessionIds).not.toContain(sCurrent.sessionId);
      expect(receipt.invalidatedSessionIds).toContain(sOther1.sessionId);
      expect(receipt.invalidatedSessionIds).toContain(sOther2.sessionId);

      // Current session remains valid and its version was upgraded
      const valCurrent = manager.validateSession(sCurrent.sessionId);
      expect(valCurrent.valid).toBe(true);
      expect(valCurrent.session?.tokenVersion).toBe(receipt.tokenVersion);

      // Other sessions are invalidated
      expect(manager.validateSession(sOther1.sessionId).valid).toBe(false);
      expect(manager.validateSession(sOther2.sessionId).valid).toBe(false);
    });

    it("supports 'single_session' scope targeted invalidation", async () => {
      const s1 = manager.createSession({ principalId: USER_ALICE });
      const s2 = manager.createSession({ principalId: USER_ALICE });

      const receipt = await manager.invalidateOnSecurityEvent({
        targetPrincipalId: USER_ALICE,
        event: "suspicious_activity",
        scope: "single_session",
        targetSessionId: s1.sessionId,
        actor: { principalId: USER_ALICE, role: "user" },
      });

      expect(receipt.invalidatedCount).toBe(1);
      expect(receipt.invalidatedSessionIds).toEqual([s1.sessionId]);

      expect(manager.validateSession(s1.sessionId).valid).toBe(false);
    });

    it("generates a tamper-evident cryptographic receipt digest", async () => {
      const s1 = manager.createSession({ principalId: USER_ALICE });

      const receipt = await manager.invalidateOnSecurityEvent({
        targetPrincipalId: USER_ALICE,
        event: "mfa_reset",
        scope: "all_sessions",
        actor: { principalId: USER_ALICE, role: "user" },
      });

      const expectedDigest = computeReceiptDigest(
        receipt.receiptId,
        USER_ALICE,
        "mfa_reset",
        receipt.tokenVersion,
        [s1.sessionId]
      );

      expect(receipt.digest).toBe(expectedDigest);
    });
  });

  describe("Failure Paths", () => {
    it("rejects invalidation when target principal ID is missing", async () => {
      await expect(
        manager.invalidateOnSecurityEvent({
          targetPrincipalId: "",
          event: "key_rotation",
          scope: "all_sessions",
          actor: { principalId: USER_ALICE, role: "user" },
        })
      ).rejects.toThrow(SecurityInvalidationError);
    });

    it("returns SESSION_NOT_FOUND when validating a non-existent session ID", () => {
      const val = manager.validateSession("sess_non_existent_id");
      expect(val.valid).toBe(false);
      expect(val.reason).toBe("SESSION_NOT_FOUND");
    });

    it("returns SESSION_EXPIRED when validating a session whose TTL has lapsed", () => {
      const session = manager.createSession({
        principalId: USER_ALICE,
        ttlMs: -1000, // expired immediately
      });

      const val = manager.validateSession(session.sessionId);
      expect(val.valid).toBe(false);
      expect(val.reason).toBe("SESSION_EXPIRED");
    });

    it("returns STALE_TOKEN_VERSION when caller presents an outdated token version", () => {
      const session = manager.createSession({ principalId: USER_ALICE });
      const val = manager.validateSession(session.sessionId, 999);
      expect(val.valid).toBe(false);
      expect(val.reason).toBe("STALE_TOKEN_VERSION");
    });
  });

  describe("Retry Paths & Idempotency", () => {
    it("returns the exact same receipt and preserves token version on idempotent retry", async () => {
      manager.createSession({ principalId: USER_ALICE });
      const idempotencyKey = "idem_key_rotation_alice_001";

      const r1 = await manager.invalidateOnSecurityEvent({
        targetPrincipalId: USER_ALICE,
        event: "key_rotation",
        scope: "all_sessions",
        actor: { principalId: USER_ALICE, role: "user" },
        idempotencyKey,
      });

      const tokenVersionAfterFirst = manager.getTokenVersion(USER_ALICE);

      // Retry with same idempotency key
      const r2 = await manager.invalidateOnSecurityEvent({
        targetPrincipalId: USER_ALICE,
        event: "key_rotation",
        scope: "all_sessions",
        actor: { principalId: USER_ALICE, role: "user" },
        idempotencyKey,
      });

      expect(r2.receiptId).toBe(r1.receiptId);
      expect(r2.digest).toBe(r1.digest);
      expect(r2.tokenVersion).toBe(r1.tokenVersion);
      // Version should not have bumped a second time
      expect(manager.getTokenVersion(USER_ALICE)).toBe(tokenVersionAfterFirst);
    });

    it("rejects idempotency key reuse with different event parameters", async () => {
      const idempotencyKey = "idem_key_002";

      await manager.invalidateOnSecurityEvent({
        targetPrincipalId: USER_ALICE,
        event: "password_change",
        scope: "all_sessions",
        actor: { principalId: USER_ALICE, role: "user" },
        idempotencyKey,
      });

      await expect(
        manager.invalidateOnSecurityEvent({
          targetPrincipalId: USER_ALICE,
          event: "account_compromise", // different event
          scope: "all_sessions",
          actor: { principalId: USER_ALICE, role: "user" },
          idempotencyKey,
        })
      ).rejects.toThrow("Idempotency key already used for a different invalidation request");
    });

    it("rejects reuse when the invalidation scope changes", async () => {
      const current = manager.createSession({ principalId: USER_ALICE });
      const idempotencyKey = "idem_scope_change";
      await manager.invalidateOnSecurityEvent({
        targetPrincipalId: USER_ALICE,
        event: "password_change",
        scope: "all_sessions",
        actor: { principalId: USER_ALICE, role: "user" },
        idempotencyKey,
      });
      const versionAfterFirst = manager.getTokenVersion(USER_ALICE);

      await expect(manager.invalidateOnSecurityEvent({
        targetPrincipalId: USER_ALICE,
        event: "password_change",
        scope: "all_except_current",
        currentSessionId: current.sessionId,
        actor: { principalId: USER_ALICE, role: "user" },
        idempotencyKey,
      })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", statusCode: 409 });
      expect(manager.getTokenVersion(USER_ALICE)).toBe(versionAfterFirst);
    });

    it("requires a real in-scope session for scoped invalidation", async () => {
      await expect(manager.invalidateOnSecurityEvent({
        targetPrincipalId: USER_ALICE,
        event: "password_change",
        scope: "all_except_current",
        actor: { principalId: USER_ALICE, role: "user" },
      })).rejects.toMatchObject({ code: "SESSION_NOT_FOUND", statusCode: 404 });
    });
  });

  describe("Authorization Paths", () => {
    it("prevents an unprivileged user from invalidating another user's sessions", async () => {
      manager.createSession({ principalId: USER_BOB });

      await expect(
        manager.invalidateOnSecurityEvent({
          targetPrincipalId: USER_BOB,
          event: "admin_forced_logout",
          scope: "all_sessions",
          actor: { principalId: USER_ALICE, role: "user" }, // Alice is not Bob
        })
      ).rejects.toThrow(SecurityInvalidationError);
    });

    it("permits authorized maintainers and admins to invalidate any user session", async () => {
      const sBob = manager.createSession({ principalId: USER_BOB });

      const receipt = await manager.invalidateOnSecurityEvent({
        targetPrincipalId: USER_BOB,
        event: "admin_forced_logout",
        scope: "all_sessions",
        actor: { principalId: "G_MAINTAINER_01", role: "maintainer" },
      });

      expect(receipt.invalidatedCount).toBe(1);
      expect(manager.validateSession(sBob.sessionId).valid).toBe(false);
    });

    it("permits system actor to execute recovery invalidations", async () => {
      const sAlice = manager.createSession({ principalId: USER_ALICE });

      const receipt = await manager.invalidateOnSecurityEvent({
        targetPrincipalId: USER_ALICE,
        event: "recovery_completed",
        scope: "all_sessions",
        actor: { principalId: "system_worker", role: "system" },
      });

      expect(receipt.invalidatedCount).toBe(1);
      expect(manager.validateSession(sAlice.sessionId).valid).toBe(false);
    });
  });
});
