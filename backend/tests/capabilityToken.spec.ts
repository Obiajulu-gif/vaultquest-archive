import { describe, it, expect, beforeEach } from "vitest";
import Fastify from "fastify";
import {
  CapabilityTokenService,
  InMemoryCapabilityTokenStore,
  CAPABILITY_TOKEN_PREFIX
} from "../src/services/capabilityTokenService.js";
import { requireCapability } from "../src/middleware/capabilityToken.js";
import { capabilityRoutes } from "../src/routes/capabilityTokens.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { ERROR_CODES } from "../src/constants.js";

describe("Expiring Capability Tokens for Sensitive Actions (#984)", () => {
  const secretKey = "test-capability-secret-key-super-secure-32b";
  let store: InMemoryCapabilityTokenStore;
  let service: CapabilityTokenService;

  beforeEach(() => {
    store = new InMemoryCapabilityTokenStore();
    service = new CapabilityTokenService({
      secretKey,
      store,
      defaultTtlSeconds: 300 // 5 min
    });
  });

  describe("1. Normal Issuance and Verification Paths", () => {
    it("issues a cryptographically signed token with valid structure", async () => {
      const issued = await service.issueCapability({
        action: "vault:emergency_drain",
        resource: "vault:vault-alpha-123",
        principal: "G_ALICE_STELLAR_ADDRESS",
        ttlSeconds: 600,
        singleUse: true,
        metadata: { reason: "Security incident response" }
      });

      expect(issued.token).toBeDefined();
      expect(issued.token.startsWith(CAPABILITY_TOKEN_PREFIX)).toBe(true);
      expect(issued.payload.action).toBe("vault:emergency_drain");
      expect(issued.payload.resource).toBe("vault:vault-alpha-123");
      expect(issued.payload.principal).toBe("g_alice_stellar_address");
      expect(issued.payload.singleUse).toBe(true);
      expect(issued.payload.metadata?.reason).toBe("Security incident response");
      expect(issued.payload.exp).toBeGreaterThan(issued.payload.iat);
    });

    it("verifies a valid token and successfully matches action, resource, and principal", async () => {
      const { token } = await service.issueCapability({
        action: "prize:settle_round",
        resource: "round:2026-round-42",
        principal: "G_BOB_ADMIN_KEY"
      });

      const result = await service.verifyCapability(token, {
        expectedAction: "prize:settle_round",
        expectedResource: "round:2026-round-42",
        expectedPrincipal: "G_BOB_ADMIN_KEY"
      });

      expect(result.valid).toBe(true);
      expect(result.payload?.action).toBe("prize:settle_round");
      expect(result.payload?.resource).toBe("round:2026-round-42");
    });

    it("supports wildcard resource and wildcard action capabilities", async () => {
      const { token: wildcardResourceToken } = await service.issueCapability({
        action: "admin:rotate_key",
        resource: "*",
        principal: "G_OPS_KEY"
      });

      const res = await service.verifyCapability(wildcardResourceToken, {
        expectedAction: "admin:rotate_key",
        expectedResource: "subsystem:auth-keys"
      });
      expect(res.valid).toBe(true);
    });
  });

  describe("2. Expiration and Timing Boundaries", () => {
    it("rejects token when expiration timestamp is in the past", async () => {
      // Create a token with expired time directly
      const now = Math.floor(Date.now() / 1000);
      const expiredPayload = {
        jti: "expired-jti-0001",
        action: "vault:emergency_drain",
        resource: "*",
        principal: "g_alice",
        iat: now - 3600,
        exp: now - 60, // Expired 1 minute ago
        singleUse: true
      };

      const payloadB64 = Buffer.from(JSON.stringify(expiredPayload)).toString("base64url");
      // Use private sign via service method or verify
      const helperService = service as any;
      const sig = helperService.sign(payloadB64);
      const expiredToken = `${CAPABILITY_TOKEN_PREFIX}${payloadB64}.${sig}`;

      const res = await service.verifyCapability(expiredToken, {
        expectedAction: "vault:emergency_drain"
      });

      expect(res.valid).toBe(false);
      expect(res.errorCode).toBe(ERROR_CODES.CAPABILITY_TOKEN_EXPIRED);
      expect(res.errorMessage).toContain("expired");
    });

    it("clamps requested TTL to valid bounds (min 10s, max 3600s)", async () => {
      const tooShort = await service.issueCapability({
        action: "test:action",
        resource: "*",
        principal: "g_alice",
        ttlSeconds: 2 // below min 10
      });
      expect(tooShort.payload.exp - tooShort.payload.iat).toBe(10);

      const tooLong = await service.issueCapability({
        action: "test:action",
        resource: "*",
        principal: "g_alice",
        ttlSeconds: 999999 // above max 3600
      });
      expect(tooLong.payload.exp - tooLong.payload.iat).toBe(3600);
    });
  });

  describe("3. Single-Use Replay Protection", () => {
    it("enforces single-use replay protection: token can only be consumed once", async () => {
      const { token } = await service.issueCapability({
        action: "vault:emergency_drain",
        resource: "vault:v-100",
        principal: "g_maintainer",
        singleUse: true
      });

      // First use: must succeed and consume
      const firstUse = await service.verifyCapability(token, {
        expectedAction: "vault:emergency_drain",
        expectedResource: "vault:v-100",
        consume: true
      });
      expect(firstUse.valid).toBe(true);

      // Second use (replay attempt): must fail with CAPABILITY_TOKEN_CONSUMED
      const secondUse = await service.verifyCapability(token, {
        expectedAction: "vault:emergency_drain",
        expectedResource: "vault:v-100",
        consume: true
      });
      expect(secondUse.valid).toBe(false);
      expect(secondUse.errorCode).toBe(ERROR_CODES.CAPABILITY_TOKEN_CONSUMED);
      expect(secondUse.errorMessage).toContain("replay detected");
    });

    it("permits multiple uses when singleUse is explicitly set to false", async () => {
      const { token } = await service.issueCapability({
        action: "indexer:query_state",
        resource: "ledger:all",
        principal: "g_indexer_service",
        singleUse: false
      });

      const first = await service.verifyCapability(token, {
        expectedAction: "indexer:query_state"
      });
      const second = await service.verifyCapability(token, {
        expectedAction: "indexer:query_state"
      });

      expect(first.valid).toBe(true);
      expect(second.valid).toBe(true);
    });

    it("allows inspect without consuming single-use capability token", async () => {
      const { token } = await service.issueCapability({
        action: "vault:emergency_drain",
        resource: "vault:v-100",
        principal: "g_maintainer",
        singleUse: true
      });

      // Inspect with consume: false
      const inspect = await service.verifyCapability(token, {
        expectedAction: "vault:emergency_drain",
        consume: false
      });
      expect(inspect.valid).toBe(true);

      // Verify after inspect: still consumable
      const verify = await service.verifyCapability(token, {
        expectedAction: "vault:emergency_drain",
        consume: true
      });
      expect(verify.valid).toBe(true);
    });
  });

  describe("4. Scope, Authorization, and Resource Boundaries", () => {
    it("rejects action mismatch with CAPABILITY_TOKEN_SCOPE_MISMATCH", async () => {
      const { token } = await service.issueCapability({
        action: "vault:emergency_drain",
        resource: "*",
        principal: "g_alice"
      });

      const res = await service.verifyCapability(token, {
        expectedAction: "prize:settle_round"
      });

      expect(res.valid).toBe(false);
      expect(res.errorCode).toBe(ERROR_CODES.CAPABILITY_TOKEN_SCOPE_MISMATCH);
      expect(res.errorMessage).toContain("Action mismatch");
    });

    it("rejects resource mismatch with CAPABILITY_TOKEN_SCOPE_MISMATCH", async () => {
      const { token } = await service.issueCapability({
        action: "vault:emergency_drain",
        resource: "vault:specific-pool-01",
        principal: "g_alice"
      });

      const res = await service.verifyCapability(token, {
        expectedAction: "vault:emergency_drain",
        expectedResource: "vault:other-pool-99"
      });

      expect(res.valid).toBe(false);
      expect(res.errorCode).toBe(ERROR_CODES.CAPABILITY_TOKEN_SCOPE_MISMATCH);
      expect(res.errorMessage).toContain("Resource mismatch");
    });

    it("rejects principal mismatch when exercised by different wallet", async () => {
      const { token } = await service.issueCapability({
        action: "vault:emergency_drain",
        resource: "*",
        principal: "g_alice"
      });

      const res = await service.verifyCapability(token, {
        expectedAction: "vault:emergency_drain",
        expectedPrincipal: "g_bob"
      });

      expect(res.valid).toBe(false);
      expect(res.errorCode).toBe(ERROR_CODES.CAPABILITY_TOKEN_ACTOR_MISMATCH);
      expect(res.errorMessage).toContain("Principal mismatch");
    });
  });

  describe("5. Cryptographic Integrity and Tampering Prevention", () => {
    it("rejects modified payload with invalid signature error", async () => {
      const { token } = await service.issueCapability({
        action: "vault:emergency_drain",
        resource: "vault:v-1",
        principal: "g_alice"
      });

      const raw = token.slice(CAPABILITY_TOKEN_PREFIX.length);
      const [payloadB64, sig] = raw.split(".");

      // Tamper with payload (escalate resource to "*")
      const decoded = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
      decoded.resource = "*";
      const tamperedB64 = Buffer.from(JSON.stringify(decoded)).toString("base64url");
      const tamperedToken = `${CAPABILITY_TOKEN_PREFIX}${tamperedB64}.${sig}`;

      const res = await service.verifyCapability(tamperedToken, {
        expectedAction: "vault:emergency_drain"
      });

      expect(res.valid).toBe(false);
      expect(res.errorCode).toBe(ERROR_CODES.CAPABILITY_TOKEN_INVALID);
      expect(res.errorMessage).toContain("signature verification failed");
    });

    it("rejects token with invalid signature or secret mismatch", async () => {
      const otherService = new CapabilityTokenService({
        secretKey: "different-secret-key-for-forgery-testing",
        store
      });

      const { token } = await otherService.issueCapability({
        action: "vault:emergency_drain",
        resource: "*",
        principal: "g_attacker"
      });

      const res = await service.verifyCapability(token, {
        expectedAction: "vault:emergency_drain"
      });

      expect(res.valid).toBe(false);
      expect(res.errorCode).toBe(ERROR_CODES.CAPABILITY_TOKEN_INVALID);
    });

    it("rejects completely malformed tokens", async () => {
      const invalidTokens = [
        "",
        "not_a_capability_token",
        "cap_v1_nodots",
        "cap_v1_invalid.base64!!.sig"
      ];

      for (const t of invalidTokens) {
        const res = await service.verifyCapability(t, { expectedAction: "test" });
        expect(res.valid).toBe(false);
        expect(res.errorCode).toBe(ERROR_CODES.CAPABILITY_TOKEN_INVALID);
      }
    });
  });

  describe("6. Revocation Capabilities", () => {
    it("revoking a specific token prevents further execution", async () => {
      const { token, payload } = await service.issueCapability({
        action: "vault:emergency_drain",
        resource: "*",
        principal: "g_alice"
      });

      // Revoke the token
      await service.revokeToken(payload.jti, payload.exp);

      const res = await service.verifyCapability(token, {
        expectedAction: "vault:emergency_drain"
      });

      expect(res.valid).toBe(false);
      expect(res.errorCode).toBe(ERROR_CODES.CAPABILITY_TOKEN_REVOKED);
      expect(res.errorMessage).toContain("explicitly revoked");
    });

    it("revoking a principal invalidates all tokens previously issued for that wallet", async () => {
      const { token } = await service.issueCapability({
        action: "vault:emergency_drain",
        resource: "*",
        principal: "g_compromised_wallet"
      });

      // Revoke principal
      await service.revokePrincipal("g_compromised_wallet");

      const res = await service.verifyCapability(token, {
        expectedAction: "vault:emergency_drain"
      });

      expect(res.valid).toBe(false);
      expect(res.errorCode).toBe(ERROR_CODES.CAPABILITY_TOKEN_REVOKED);
      expect(res.errorMessage).toContain("All capability tokens for this principal have been revoked");
    });

    it("pruneExpired cleans expired entries to bound memory", async () => {
      const now = Math.floor(Date.now() / 1000);
      await store.recordUse("expired-1", now - 100);
      await store.recordUse("active-1", now + 100);

      const pruned = await store.pruneExpired();
      expect(pruned).toBeGreaterThanOrEqual(1);
      expect(await store.isUsed("expired-1")).toBe(false);
      expect(await store.isUsed("active-1")).toBe(true);
    });
  });

  describe("7. Fastify Middleware and HTTP Integration", () => {
    async function createTestApp() {
      const app = Fastify();
      app.setErrorHandler(errorHandler);

      // Register capability routes
      app.register(capabilityRoutes, { capabilityService: service });

      // Add a sensitive test route protected by requireCapability
      app.post(
        "/api/sensitive/emergency-drain",
        {
          preHandler: requireCapability({
            action: "vault:emergency_drain",
            service,
            resourceResolver: (req: any) => req.body?.vault_id,
            principalResolver: (req: any) => req.headers["x-test-wallet"] as string | undefined
          })
        },
        async (req, reply) => {
          return reply.send({
            success: true,
            drained_by: (req as any).capability?.principal,
            action: (req as any).capability?.action
          });
        }
      );

      await app.ready();
      return app;
    }

    it("executes sensitive route successfully when valid capability token is supplied in header", async () => {
      const app = await createTestApp();

      const { token } = await service.issueCapability({
        action: "vault:emergency_drain",
        resource: "vault-42",
        principal: "g_alice"
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/sensitive/emergency-drain",
        headers: {
          "x-capability-token": token,
          "x-test-wallet": "g_alice"
        },
        payload: { vault_id: "vault-42" }
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.success).toBe(true);
      expect(json.drained_by).toBe("g_alice");
      expect(json.action).toBe("vault:emergency_drain");

      await app.close();
    });

    it("rejects request with 401 Problem Details when capability token is missing", async () => {
      const app = await createTestApp();

      const res = await app.inject({
        method: "POST",
        url: "/api/sensitive/emergency-drain",
        payload: { vault_id: "vault-42" }
      });

      expect(res.statusCode).toBe(401);
      const json = res.json();
      expect(json.code).toBe(ERROR_CODES.CAPABILITY_TOKEN_REQUIRED);
      expect(json.status).toBe(401);
      expect(json.remediation).toBeDefined();

      await app.close();
    });

    it("rejects replayed capability token with 409 Conflict Problem Details", async () => {
      const app = await createTestApp();

      const { token } = await service.issueCapability({
        action: "vault:emergency_drain",
        resource: "vault-42",
        principal: "g_alice",
        singleUse: true
      });

      // First call consumes token
      const res1 = await app.inject({
        method: "POST",
        url: "/api/sensitive/emergency-drain",
        headers: { "x-capability-token": token, "x-test-wallet": "g_alice" },
        payload: { vault_id: "vault-42" }
      });
      expect(res1.statusCode).toBe(200);

      // Second call fails with 409 Problem Details
      const res2 = await app.inject({
        method: "POST",
        url: "/api/sensitive/emergency-drain",
        headers: { "x-capability-token": token, "x-test-wallet": "g_alice" },
        payload: { vault_id: "vault-42" }
      });
      expect(res2.statusCode).toBe(409);
      const json = res2.json();
      expect(json.code).toBe(ERROR_CODES.CAPABILITY_TOKEN_CONSUMED);
      expect(json.remediation).toContain("Capability tokens can only be used once");

      await app.close();
    });

    it("verifies HTTP routes: issue, inspect, and revoke endpoints", async () => {
      const app = await createTestApp();

      // 1. Issue via POST /auth/capabilities/issue
      const issueRes = await app.inject({
        method: "POST",
        url: "/auth/capabilities/issue",
        payload: {
          action: "vault:emergency_drain",
          resource: "vault:main",
          principal: "g_bob",
          ttl_seconds: 120
        }
      });
      expect(issueRes.statusCode).toBe(200);
      const issueBody = issueRes.json();
      expect(issueBody.data.token).toBeDefined();
      expect(issueBody.data.payload.action).toBe("vault:emergency_drain");

      const token = issueBody.data.token;
      const tokenId = issueBody.data.payload.token_id;

      // 2. Inspect via POST /auth/capabilities/inspect
      const inspectRes = await app.inject({
        method: "POST",
        url: "/auth/capabilities/inspect",
        payload: {
          token,
          action: "vault:emergency_drain",
          resource: "vault:main"
        }
      });
      expect(inspectRes.statusCode).toBe(200);
      expect(inspectRes.json().data.valid).toBe(true);

      // 3. Revoke via POST /auth/capabilities/revoke
      const revokeRes = await app.inject({
        method: "POST",
        url: "/auth/capabilities/revoke",
        payload: { token_id: tokenId }
      });
      expect(revokeRes.statusCode).toBe(200);
      expect(revokeRes.json().data.revoked).toBe(true);

      // 4. Verify that inspected token is now revoked
      const inspectAfterRevoke = await app.inject({
        method: "POST",
        url: "/auth/capabilities/inspect",
        payload: { token }
      });
      expect(inspectAfterRevoke.json().data.valid).toBe(false);
      expect(inspectAfterRevoke.json().data.error_code).toBe(ERROR_CODES.CAPABILITY_TOKEN_REVOKED);

      await app.close();
    });
  });
});
