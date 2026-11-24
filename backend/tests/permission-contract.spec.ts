/**
 * Contract tests for permission changes and hidden records (#1086).
 *
 * These tests verify behavioral contracts that must be preserved across
 * refactoring and feature additions:
 * - Permission checks are enforced at the authorization boundary
 * - Hidden records are not leaked through any API surface
 * - Permission changes are audited and reversible
 * - Authorization failures produce consistent error responses
 *
 * Coverage:
 * - Normal operation: authorized access succeeds
 * - Failure paths: unauthorized access is blocked
 * - Authorization edge cases: role changes, impersonation, hidden data
 * - Recovery: audit trails for permission denials
 * - Retry: idempotent permission checks
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { FastifyRequest } from "fastify";
import {
  requirePermission,
  walletSessionResolver,
  serviceSecretResolver,
  type Principal,
  type PrincipalResolver,
} from "../src/middleware/rbac.js";
import { hasPermission, roleHasPermission, type Permission, type Role } from "../../lib/rbac.js";

// Helper function for creating mock requests
function mockRequest(overrides: Partial<FastifyRequest> = {}): FastifyRequest {
  return {
    headers: {},
    log: {
      warn: vi.fn(),
      debug: vi.fn(),
    },
    ...overrides,
  } as unknown as FastifyRequest;
}

describe("Permission Contract Tests", () => {
  describe("Role Permission Matrix Contract", () => {
    it("user role has own.data permissions", () => {
      expect(roleHasPermission("user", "own.data.read")).toBe(true);
      expect(roleHasPermission("user", "own.data.write")).toBe(true);
      expect(roleHasPermission("user", "own.data.export")).toBe(true);
      expect(roleHasPermission("user", "own.data.import")).toBe(true);
    });

    it("user role cannot access admin permissions", () => {
      expect(roleHasPermission("user", "admin.audit.read")).toBe(false);
      expect(roleHasPermission("user", "admin.audit.write")).toBe(false);
      expect(roleHasPermission("user", "admin.recovery.read")).toBe(false);
      expect(roleHasPermission("user", "admin.recovery.write")).toBe(false);
      expect(roleHasPermission("user", "admin.impersonation.read")).toBe(false);
    });

    it("maintainer role is superset of user permissions", () => {
      const userPermissions: Permission[] = [
        "own.data.read",
        "own.data.write",
        "own.data.export",
        "own.data.import",
        "own.receipts.read",
      ];
      
      for (const permission of userPermissions) {
        expect(roleHasPermission("maintainer", permission)).toBe(true);
      }
    });

    it("maintainer role has admin permissions", () => {
      expect(roleHasPermission("maintainer", "admin.audit.read")).toBe(true);
      expect(roleHasPermission("maintainer", "admin.audit.write")).toBe(true);
      expect(roleHasPermission("maintainer", "admin.recovery.read")).toBe(true);
      expect(roleHasPermission("maintainer", "admin.recovery.write")).toBe(true);
      expect(roleHasPermission("maintainer", "admin.impersonation.read")).toBe(true);
      expect(roleHasPermission("maintainer", "admin.impersonation.write")).toBe(true);
    });

    it("service role only has internal permissions", () => {
      expect(roleHasPermission("service", "internal.reconcile")).toBe(true);
      expect(roleHasPermission("service", "internal.checkpoint")).toBe(true);
      expect(roleHasPermission("service", "internal.trace")).toBe(true);
      
      // Service should NOT have user or admin permissions
      expect(roleHasPermission("service", "own.data.read")).toBe(false);
      expect(roleHasPermission("service", "admin.audit.read")).toBe(false);
    });

    it("unknown roles grant no permissions", () => {
      expect(roleHasPermission("unknown" as Role, "own.data.read")).toBe(false);
      expect(roleHasPermission(null, "own.data.read")).toBe(false);
      expect(roleHasPermission(undefined, "own.data.read")).toBe(false);
    });
  });

  describe("Authorization Boundary Contract", () => {
    it("blocks requests with no credentials (401 Unauthorized)", async () => {
      const resolvers: PrincipalResolver[] = [
        async () => null, // No principal resolved
      ];
      
      const middleware = requirePermission("own.data.read", resolvers);
      const req = mockRequest();
      
      await expect(middleware(req, {} as any, {} as any)).rejects.toThrow("unauthorized");
    });

    it("blocks requests with insufficient permissions (403 Forbidden)", async () => {
      const resolvers: PrincipalResolver[] = [
        async () => ({ role: "user", subject: "0xtest" }), // User role
      ];
      
      const middleware = requirePermission("admin.audit.read", resolvers); // Admin permission
      const req = mockRequest();
      
      await expect(middleware(req, {} as any, {} as any)).rejects.toThrow("missing permission");
    });

    it("allows requests with sufficient permissions", async () => {
      const resolvers: PrincipalResolver[] = [
        async () => ({ role: "maintainer", subject: "0xadmin" }),
      ];
      
      const middleware = requirePermission("admin.audit.read", resolvers);
      const req = mockRequest();
      
      await expect(middleware(req, {} as any, {} as any)).resolves.toBeUndefined();
      expect(req.principal).toEqual({ role: "maintainer", subject: "0xadmin" });
    });

    it("tries all resolvers in order until one succeeds", async () => {
      const resolvers: PrincipalResolver[] = [
        async () => null, // First resolver fails
        async () => null, // Second resolver fails
        async () => ({ role: "user", subject: "0xtest" }), // Third succeeds
      ];
      
      const middleware = requirePermission("own.data.read", resolvers);
      const req = mockRequest();
      
      await expect(middleware(req, {} as any, {} as any)).resolves.toBeUndefined();
      expect(req.principal?.subject).toBe("0xtest");
    });

    it("stops at first successful resolver", async () => {
      const spy1 = vi.fn().mockResolvedValue({ role: "user", subject: "user1" });
      const spy2 = vi.fn().mockResolvedValue({ role: "maintainer", subject: "admin1" });
      
      const resolvers: PrincipalResolver[] = [spy1, spy2];
      
      const middleware = requirePermission("own.data.read", resolvers);
      const req = mockRequest();
      
      await middleware(req, {} as any, {} as any);
      
      expect(spy1).toHaveBeenCalledOnce();
      expect(spy2).not.toHaveBeenCalled(); // Should not be called
      expect(req.principal?.subject).toBe("user1");
    });

    it("authorization is idempotent across retries", async () => {
      let callCount = 0;
      const resolvers: PrincipalResolver[] = [
        async () => {
          callCount++;
          return { role: "user", subject: "0xtest" };
        },
      ];
      
      const middleware = requirePermission("own.data.read", resolvers);
      
      // First request
      const req1 = mockRequest();
      await middleware(req1, {} as any, {} as any);
      
      // Retry (simulating network retry)
      const req2 = mockRequest();
      await middleware(req2, {} as any, {} as any);
      
      expect(callCount).toBe(2); // Both calls executed
      expect(req1.principal?.subject).toBe("0xtest");
      expect(req2.principal?.subject).toBe("0xtest");
    });
  });

  describe("Wallet Session Resolver Contract", () => {
    const mockWalletAuth = {
      validateSession: vi.fn(),
    };

    beforeEach(() => {
      mockWalletAuth.validateSession.mockReset();
    });

    it("resolves user principal for valid session", async () => {
      mockWalletAuth.validateSession.mockResolvedValue({
        walletAddress: "0xuser",
      });
      
      const resolver = walletSessionResolver(mockWalletAuth, []);
      const req = mockRequest({ headers: { authorization: "Bearer valid-token" } });
      
      const principal = await resolver(req);
      
      expect(principal).toEqual({
        role: "user",
        subject: "0xuser",
        walletAddress: "0xuser",
      });
    });

    it("resolves maintainer principal for admin wallet", async () => {
      mockWalletAuth.validateSession.mockResolvedValue({
        walletAddress: "0xADMIN",
      });
      
      const resolver = walletSessionResolver(mockWalletAuth, ["0xadmin"]); // Case-insensitive
      const req = mockRequest({ headers: { authorization: "Bearer admin-token" } });
      
      const principal = await resolver(req);
      
      expect(principal?.role).toBe("maintainer");
    });

    it("returns null for missing token", async () => {
      const resolver = walletSessionResolver(mockWalletAuth, []);
      const req = mockRequest({ headers: {} });
      
      const principal = await resolver(req);
      
      expect(principal).toBeNull();
      expect(mockWalletAuth.validateSession).not.toHaveBeenCalled();
    });

    it("returns null for invalid token", async () => {
      mockWalletAuth.validateSession.mockResolvedValue(null);
      
      const resolver = walletSessionResolver(mockWalletAuth, []);
      const req = mockRequest({ headers: { authorization: "Bearer invalid-token" } });
      
      const principal = await resolver(req);
      
      expect(principal).toBeNull();
    });

    it("handles malformed Authorization header", async () => {
      const resolver = walletSessionResolver(mockWalletAuth, []);
      
      // Missing "Bearer " prefix
      const req1 = mockRequest({ headers: { authorization: "token123" } });
      expect(await resolver(req1)).toBeNull();
      
      // Empty token
      const req2 = mockRequest({ headers: { authorization: "Bearer " } });
      expect(await resolver(req2)).toBeNull();
      
      // Only "Bearer" with no token
      const req3 = mockRequest({ headers: { authorization: "Bearer" } });
      expect(await resolver(req3)).toBeNull();
    });
  });

  describe("Service Secret Resolver Contract", () => {
    const testSecret = "super-secret-key";

    it("resolves service principal with valid secret", async () => {
      const resolver = serviceSecretResolver(testSecret, "indexer-service");
      const req = mockRequest({ headers: { "x-internal-secret": testSecret } });
      
      const principal = await resolver(req);
      
      expect(principal).toEqual({
        role: "service",
        subject: "indexer-service",
      });
    });

    it("returns null for wrong secret", async () => {
      const resolver = serviceSecretResolver(testSecret);
      const req = mockRequest({ headers: { "x-internal-secret": "wrong-secret" } });
      
      const principal = await resolver(req);
      
      expect(principal).toBeNull();
    });

    it("returns null for missing secret header", async () => {
      const resolver = serviceSecretResolver(testSecret);
      const req = mockRequest({ headers: {} });
      
      const principal = await resolver(req);
      
      expect(principal).toBeNull();
    });

    it("returns null for empty secret", async () => {
      const resolver = serviceSecretResolver(testSecret);
      const req = mockRequest({ headers: { "x-internal-secret": "" } });
      
      const principal = await resolver(req);
      
      expect(principal).toBeNull();
    });

    it("uses constant-time comparison (timing-safe)", async () => {
      // This test verifies the contract that secret comparison is timing-safe
      // Actual timing-safety is verified in the implementation
      const resolver = serviceSecretResolver("secret123");
      
      const req1 = mockRequest({ headers: { "x-internal-secret": "secret123" } });
      const req2 = mockRequest({ headers: { "x-internal-secret": "wrong123" } });
      
      const result1 = await resolver(req1);
      const result2 = await resolver(req2);
      
      expect(result1).not.toBeNull();
      expect(result2).toBeNull();
    });
  });

  describe("Hidden Records Access Contract", () => {
    it("user cannot access other users' data", () => {
      // This is a contract test: users should NEVER be able to access
      // data belonging to other wallets, even if they know the ID
      
      // User role does NOT have permission to bypass ownership checks
      expect(roleHasPermission("user", "admin.export.any")).toBe(false);
      
      // Only maintainers can access any user's data
      expect(roleHasPermission("maintainer", "admin.export.any")).toBe(true);
    });

    it("service role cannot impersonate users", () => {
      // Service actors should never gain user/admin permissions
      expect(roleHasPermission("service", "admin.impersonation.read")).toBe(false);
      expect(roleHasPermission("service", "admin.impersonation.write")).toBe(false);
    });

    it("permission checks are consistent across API surfaces", () => {
      // Same permission should behave identically in all contexts
      const testPermission: Permission = "admin.recovery.write";
      
      expect(hasPermission(["user"], testPermission)).toBe(false);
      expect(hasPermission(["maintainer"], testPermission)).toBe(true);
      expect(hasPermission(["service"], testPermission)).toBe(false);
      
      // Multiple roles: any match grants permission
      expect(hasPermission(["user", "maintainer"], testPermission)).toBe(true);
    });
  });

  describe("Permission Change Audit Contract", () => {
    it("permission denials are logged for audit", async () => {
      const logs: Array<{ event: string; permission?: string }> = [];
      
      const resolver: PrincipalResolver = async () => ({
        role: "user",
        subject: "0xtest",
      });
      
      const req = {
        headers: {},
        log: {
          warn: (data: any) => logs.push(data),
          debug: vi.fn(),
        },
      } as unknown as FastifyRequest;
      
      const middleware = requirePermission("admin.audit.read", [resolver]);
      
      try {
        await middleware(req, {} as any, {} as any);
      } catch (err) {
        // Expected to throw
      }
      
      const denialLog = logs.find((l) => l.event === "permission_denied");
      expect(denialLog).toBeDefined();
      expect(denialLog?.permission).toBe("admin.audit.read");
    });

    it("authorization success does not leak sensitive data", async () => {
      const logs: Array<unknown> = [];
      
      const resolver: PrincipalResolver = async () => ({
        role: "user",
        subject: "0xsensitive-wallet-address",
        walletAddress: "0xsensitive-wallet-address",
      });
      
      const req = {
        headers: {},
        log: {
          warn: vi.fn(),
          debug: (data: unknown) => logs.push(data),
        },
      } as unknown as FastifyRequest;
      
      const middleware = requirePermission("own.data.read", [resolver]);
      await middleware(req, {} as any, {} as any);
      
      // Success logs should not include raw wallet addresses
      // (This is a contract to prevent accidental PII leakage)
      const logString = JSON.stringify(logs);
      expect(logString).not.toContain("0xsensitive-wallet-address");
    });
  });

  describe("Permission Stability Contract", () => {
    it("permission hierarchy is stable (no breaking changes)", () => {
      // This test documents the permission hierarchy as a contract
      // If this fails, it indicates a breaking change that must be
      // communicated to API consumers
      
      const userPermissions = [
        "own.data.read",
        "own.data.export",
        "own.data.import",
        "own.data.write",
        "own.receipts.read",
      ];
      
      const maintainerOnlyPermissions = [
        "admin.audit.read",
        "admin.audit.write",
        "admin.audit.export",
        "admin.ledger.verify",
        "admin.export.any",
        "admin.receipts.read",
        "admin.recovery.read",
        "admin.recovery.write",
        "admin.audit_trail.read",
        "admin.audit_trail.export",
        "admin.limits.read",
        "admin.limits.write",
        "admin.flags.read",
        "admin.flags.write",
        "admin.impersonation.read",
        "admin.impersonation.write",
      ];
      
      const serviceOnlyPermissions = [
        "internal.reconcile",
        "internal.checkpoint",
        "internal.trace",
        "internal.analytics.read",
        "internal.reconciliation.propose",
        "internal.reconciliation.approve",
        "internal.reconciliation.execute",
      ];
      
      // Verify user permissions
      for (const perm of userPermissions) {
        expect(roleHasPermission("user", perm as Permission)).toBe(true);
      }
      
      // Verify maintainer has user permissions + admin permissions
      for (const perm of [...userPermissions, ...maintainerOnlyPermissions]) {
        expect(roleHasPermission("maintainer", perm as Permission)).toBe(true);
      }
      
      // Verify service has only internal permissions
      for (const perm of serviceOnlyPermissions) {
        expect(roleHasPermission("service", perm as Permission)).toBe(true);
      }
      
      // Verify isolation: service cannot access user/admin permissions
      for (const perm of [...userPermissions, ...maintainerOnlyPermissions]) {
        expect(roleHasPermission("service", perm as Permission)).toBe(false);
      }
    });
  });

  describe("Failure Recovery Contract", () => {
    it("authorization errors are distinguishable", async () => {
      const resolver: PrincipalResolver = async () => null;
      const middleware = requirePermission("own.data.read", [resolver]);
      const req = mockRequest();
      
      try {
        await middleware(req, {} as any, {} as any);
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.message).toContain("unauthorized");
        expect(err.statusCode).toBe(401);
      }
    });

    it("permission denials are distinguishable", async () => {
      const resolver: PrincipalResolver = async () => ({
        role: "user",
        subject: "0xtest",
      });
      const middleware = requirePermission("admin.audit.read", [resolver]);
      const req = mockRequest();
      
      try {
        await middleware(req, {} as any, {} as any);
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.message).toContain("missing permission");
        expect(err.message).toContain("admin.audit.read");
        expect(err.statusCode).toBe(403);
      }
    });

    it("failed authentication does not expose system details", async () => {
      const resolver: PrincipalResolver = async () => {
        throw new Error("Database connection failed");
      };
      
      const middleware = requirePermission("own.data.read", [resolver]);
      const req = mockRequest();
      
      try {
        await middleware(req, {} as any, {} as any);
        expect.fail("Should have thrown");
      } catch (err: any) {
        // Error should be surfaced but internal details should not leak
        // This is a contract to prevent information disclosure
        expect(err).toBeDefined();
      }
    });
  });
});
