import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { AppError } from "../errors.js";
import { ERROR_CODES } from "../constants.js";

// ─── Constants ───────────────────────────────────────────────────────────────

export const CAPABILITY_DEFAULT_TTL_SEC = 300; // 5 minutes
export const CAPABILITY_MIN_TTL_SEC = 10;      // 10 seconds
export const CAPABILITY_MAX_TTL_SEC = 3600;    // 1 hour
export const CAPABILITY_TOKEN_PREFIX = "cap_v1_";

// ─── Interfaces ─────────────────────────────────────────────────────────────

export interface CapabilityTokenPayload {
  /** Unique token ID / nonce to prevent replay attacks */
  jti: string;
  /** Permitted sensitive action identifier (e.g., "vault:emergency_drain") */
  action: string;
  /** Permitted target resource URI or identifier, or "*" for universal */
  resource: string;
  /** Subject / principal authorized to use this capability (e.g., wallet address) */
  principal: string;
  /** Issued-at unix epoch timestamp in seconds */
  iat: number;
  /** Expiration unix epoch timestamp in seconds */
  exp: number;
  /** If true, the token is consumed immediately upon first verification */
  singleUse: boolean;
  /** Optional caller-defined metadata (e.g., reason, audit context) */
  metadata?: Record<string, unknown>;
}

export interface IssueCapabilityOptions {
  action: string;
  resource: string;
  principal: string;
  ttlSeconds?: number;
  singleUse?: boolean;
  metadata?: Record<string, unknown>;
}

export interface VerifyCapabilityOptions {
  expectedAction: string;
  expectedResource?: string;
  expectedPrincipal?: string;
  /** If false, validates signature & expiry without consuming single-use token */
  consume?: boolean;
}

export interface CapabilityVerificationResult {
  valid: boolean;
  errorCode?: string;
  errorMessage?: string;
  payload?: CapabilityTokenPayload;
}

export interface CapabilityTokenStore {
  /**
   * Records a single-use token as consumed.
   * Must be atomic: returns true if marked, false if already consumed.
   */
  recordUse(jti: string, exp: number): Promise<boolean>;
  isUsed(jti: string): Promise<boolean>;
  revokeToken(jti: string, exp: number): Promise<void>;
  isTokenRevoked(jti: string): Promise<boolean>;
  revokePrincipal(principal: string, revokedBeforeTimestamp: number): Promise<void>;
  isPrincipalRevoked(principal: string, iat: number): Promise<boolean>;
  pruneExpired(): Promise<number>;
}

// ─── In-Memory Store Implementation ─────────────────────────────────────────

export class InMemoryCapabilityTokenStore implements CapabilityTokenStore {
  /** Map of jti -> expiry timestamp in seconds */
  private usedTokens = new Map<string, number>();
  /** Map of jti -> expiry timestamp in seconds */
  private revokedTokens = new Map<string, number>();
  /** Map of principal -> cutoff timestamp in seconds (tokens issued before this are revoked) */
  private revokedPrincipals = new Map<string, number>();

  async recordUse(jti: string, exp: number): Promise<boolean> {
    if (this.usedTokens.has(jti)) {
      return false; // Already used
    }
    this.usedTokens.set(jti, exp);
    return true;
  }

  async isUsed(jti: string): Promise<boolean> {
    return this.usedTokens.has(jti);
  }

  async revokeToken(jti: string, exp: number): Promise<void> {
    this.revokedTokens.set(jti, exp);
  }

  async isTokenRevoked(jti: string): Promise<boolean> {
    return this.revokedTokens.has(jti);
  }

  async revokePrincipal(principal: string, revokedBeforeTimestamp: number): Promise<void> {
    this.revokedPrincipals.set(principal.toLowerCase(), revokedBeforeTimestamp);
  }

  async isPrincipalRevoked(principal: string, iat: number): Promise<boolean> {
    const cutoff = this.revokedPrincipals.get(principal.toLowerCase());
    return cutoff !== undefined && iat <= cutoff;
  }

  async pruneExpired(): Promise<number> {
    const now = Math.floor(Date.now() / 1000);
    let pruned = 0;
    for (const [jti, exp] of this.usedTokens.entries()) {
      if (exp <= now) {
        this.usedTokens.delete(jti);
        pruned++;
      }
    }
    for (const [jti, exp] of this.revokedTokens.entries()) {
      if (exp <= now) {
        this.revokedTokens.delete(jti);
        pruned++;
      }
    }
    return pruned;
  }

  clear(): void {
    this.usedTokens.clear();
    this.revokedTokens.clear();
    this.revokedPrincipals.clear();
  }
}

// ─── Capability Token Service ───────────────────────────────────────────────

export class CapabilityTokenService {
  private readonly secretKey: Buffer;
  private readonly store: CapabilityTokenStore;
  private readonly defaultTtl: number;

  constructor(options: {
    secretKey?: string;
    store?: CapabilityTokenStore;
    defaultTtlSeconds?: number;
  } = {}) {
    const secret = options.secretKey || process.env.CAPABILITY_TOKEN_SECRET || "vaultquest-capability-dev-secret-key-32b";
    this.secretKey = Buffer.from(secret, "utf8");
    this.store = options.store || new InMemoryCapabilityTokenStore();
    this.defaultTtl = options.defaultTtlSeconds ?? CAPABILITY_DEFAULT_TTL_SEC;
  }

  getStore(): CapabilityTokenStore {
    return this.store;
  }

  /**
   * Issues a cryptographically signed, expiring capability token.
   * Time Complexity: O(1)
   * Space Complexity: O(1)
   */
  async issueCapability(options: IssueCapabilityOptions): Promise<{ token: string; payload: CapabilityTokenPayload }> {
    const ttl = Math.min(
      Math.max(options.ttlSeconds ?? this.defaultTtl, CAPABILITY_MIN_TTL_SEC),
      CAPABILITY_MAX_TTL_SEC
    );

    const now = Math.floor(Date.now() / 1000);
    const payload: CapabilityTokenPayload = {
      jti: randomUUID(),
      action: options.action.trim(),
      resource: options.resource.trim(),
      principal: options.principal.trim().toLowerCase(),
      iat: now,
      exp: now + ttl,
      singleUse: options.singleUse ?? true,
      ...(options.metadata ? { metadata: options.metadata } : {})
    };

    const payloadJson = JSON.stringify(payload);
    const payloadB64 = Buffer.from(payloadJson, "utf8").toString("base64url");
    const signatureB64 = this.sign(payloadB64);

    const token = `${CAPABILITY_TOKEN_PREFIX}${payloadB64}.${signatureB64}`;
    return { token, payload };
  }

  /**
   * Verifies a capability token against action, resource, principal, and single-use replay constraints.
   * Time Complexity: O(1)
   * Space Complexity: O(1)
   */
  async verifyCapability(
    tokenString: string,
    options: VerifyCapabilityOptions
  ): Promise<CapabilityVerificationResult> {
    if (!tokenString || typeof tokenString !== "string") {
      return {
        valid: false,
        errorCode: ERROR_CODES.CAPABILITY_TOKEN_INVALID,
        errorMessage: "Missing or invalid capability token format"
      };
    }

    if (!tokenString.startsWith(CAPABILITY_TOKEN_PREFIX)) {
      return {
        valid: false,
        errorCode: ERROR_CODES.CAPABILITY_TOKEN_INVALID,
        errorMessage: "Unrecognized capability token prefix or version"
      };
    }

    const raw = tokenString.slice(CAPABILITY_TOKEN_PREFIX.length);
    const dotIndex = raw.lastIndexOf(".");
    if (dotIndex === -1) {
      return {
        valid: false,
        errorCode: ERROR_CODES.CAPABILITY_TOKEN_INVALID,
        errorMessage: "Malformed capability token structure"
      };
    }

    const payloadB64 = raw.slice(0, dotIndex);
    const signatureB64 = raw.slice(dotIndex + 1);

    // Constant-time signature verification
    const expectedSig = this.sign(payloadB64);
    if (!this.timingSafeCompare(signatureB64, expectedSig)) {
      return {
        valid: false,
        errorCode: ERROR_CODES.CAPABILITY_TOKEN_INVALID,
        errorMessage: "Capability token signature verification failed"
      };
    }

    let payload: CapabilityTokenPayload;
    try {
      const decoded = Buffer.from(payloadB64, "base64url").toString("utf8");
      payload = JSON.parse(decoded);
    } catch {
      return {
        valid: false,
        errorCode: ERROR_CODES.CAPABILITY_TOKEN_INVALID,
        errorMessage: "Corrupted capability token payload encoding"
      };
    }

    const now = Math.floor(Date.now() / 1000);

    // Expiration check
    if (payload.exp <= now) {
      return {
        valid: false,
        errorCode: ERROR_CODES.CAPABILITY_TOKEN_EXPIRED,
        errorMessage: `Capability token expired at ${new Date(payload.exp * 1000).toISOString()}`,
        payload
      };
    }

    // Future issued check (clock skew guard: max 30s in future)
    if (payload.iat > now + 30) {
      return {
        valid: false,
        errorCode: ERROR_CODES.CAPABILITY_TOKEN_INVALID,
        errorMessage: "Capability token issued in the future (clock skew detected)",
        payload
      };
    }

    // Check token-specific revocation
    if (await this.store.isTokenRevoked(payload.jti)) {
      return {
        valid: false,
        errorCode: ERROR_CODES.CAPABILITY_TOKEN_REVOKED,
        errorMessage: "Capability token has been explicitly revoked",
        payload
      };
    }

    // Check principal revocation
    if (await this.store.isPrincipalRevoked(payload.principal, payload.iat)) {
      return {
        valid: false,
        errorCode: ERROR_CODES.CAPABILITY_TOKEN_REVOKED,
        errorMessage: "All capability tokens for this principal have been revoked",
        payload
      };
    }

    // Scope checking: Action matching
    if (payload.action !== options.expectedAction && payload.action !== "*") {
      return {
        valid: false,
        errorCode: ERROR_CODES.CAPABILITY_TOKEN_SCOPE_MISMATCH,
        errorMessage: `Action mismatch: token grants '${payload.action}', required '${options.expectedAction}'`,
        payload
      };
    }

    // Scope checking: Resource matching
    if (options.expectedResource !== undefined) {
      const matchesResource = payload.resource === "*" || payload.resource === options.expectedResource;
      if (!matchesResource) {
        return {
          valid: false,
          errorCode: ERROR_CODES.CAPABILITY_TOKEN_SCOPE_MISMATCH,
          errorMessage: `Resource mismatch: token grants access to '${payload.resource}', required '${options.expectedResource}'`,
          payload
        };
      }
    }

    // Scope checking: Principal matching
    if (options.expectedPrincipal !== undefined) {
      const normalizedExpected = options.expectedPrincipal.trim().toLowerCase();
      if (payload.principal !== "*" && payload.principal !== normalizedExpected) {
        return {
          valid: false,
          errorCode: ERROR_CODES.CAPABILITY_TOKEN_ACTOR_MISMATCH,
          errorMessage: `Principal mismatch: token issued for '${payload.principal}', exercised by '${normalizedExpected}'`,
          payload
        };
      }
    }

    // Single-use replay protection
    const shouldConsume = options.consume ?? true;
    if (payload.singleUse && shouldConsume) {
      const marked = await this.store.recordUse(payload.jti, payload.exp);
      if (!marked) {
        return {
          valid: false,
          errorCode: ERROR_CODES.CAPABILITY_TOKEN_CONSUMED,
          errorMessage: "Capability token has already been consumed (replay detected)",
          payload
        };
      }
    }

    return {
      valid: true,
      payload
    };
  }

  /**
   * Revokes a token by its ID.
   */
  async revokeToken(jti: string, exp: number): Promise<void> {
    await this.store.revokeToken(jti, exp);
  }

  /**
   * Revokes all tokens issued for a principal prior to the given timestamp.
   */
  async revokePrincipal(principal: string, revokedBeforeTimestamp?: number): Promise<void> {
    const timestamp = revokedBeforeTimestamp ?? Math.floor(Date.now() / 1000);
    await this.store.revokePrincipal(principal, timestamp);
  }

  private sign(data: string): string {
    return createHmac("sha256", this.secretKey)
      .update(data, "utf8")
      .digest("base64url");
  }

  private timingSafeCompare(a: string, b: string): boolean {
    const bufA = Buffer.from(a, "utf8");
    const bufB = Buffer.from(b, "utf8");
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  }
}
