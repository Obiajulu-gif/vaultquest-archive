import type { PrismaClient } from "@prisma/client";
import { createLogger } from "../logger.js";

const logger = createLogger(process.env.LOG_LEVEL ?? "info");

/**
 * Typed feature flag definitions with safe defaults (safer behavior = false for new features)
 */
export const FEATURE_FLAGS = {
  /**
   * Controls prize draw execution. When disabled (default), draw_winner events are logged
   * but proof generation and prize distribution are skipped. Safe default: disabled.
   * Use case: Staged rollout of draw logic, emergency rollback if draw mechanism breaks.
   */
  PRIZE_DRAW_EXECUTION: "prize-draw-execution",

  /**
   * Controls vault reconciliation repair plan execution. When disabled (default),
   * detected drift is logged and repair steps proposed but NOT applied. Safe default: disabled.
   * Use case: Staged rollout of reconciliation fixes, prevents accidental state mutations.
   */
  RECONCILIATION_AUTO_REPAIR: "reconciliation-auto-repair",

  /**
   * Controls withdrawal processing submission. When disabled (default), withdrawal
   * actions remain pending and are never submitted to chain. Safe default: disabled.
   * Use case: Emergency stop for withdrawal flow, staged rollout of new submission logic.
   */
  WITHDRAWAL_SUBMISSION_ENABLED: "withdrawal-submission-enabled",
} as const;

export type FeatureFlagKey = (typeof FEATURE_FLAGS)[keyof typeof FEATURE_FLAGS];

export interface FeatureFlagScope {
  global?: boolean;
  vault?: string;
  wallet?: string;
}

/** Stored scope string for a {@link FeatureFlagScope}: "global", "vault:{id}" or "wallet:{address}". */
export function toScopeString(scope?: FeatureFlagScope): string {
  if (scope?.vault) return `vault:${scope.vault}`;
  if (scope?.wallet) return `wallet:${scope.wallet}`;
  return "global";
}

/** Inverse of {@link toScopeString}; returns null for a malformed scope string. */
export function parseScopeString(scope: string): FeatureFlagScope | null {
  if (scope === "global") return { global: true };
  const match = /^(vault|wallet):(.+)$/.exec(scope);
  if (!match) return null;
  return match[1] === "vault" ? { vault: match[2] } : { wallet: match[2] };
}

/**
 * Service for runtime feature flag resolution with database caching.
 * Falls back to safe defaults (disabled) when configuration is missing.
 */
export class FeatureFlagService {
  private flagCache = new Map<string, { enabled: boolean; timestamp: number }>();
  private readonly CACHE_TTL_MS = 30_000; // 30s cache for runtime flags

  /** How long another replica may keep serving a stale value after a change. */
  get cacheTtlMs(): number {
    return this.CACHE_TTL_MS;
  }

  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Check if a feature flag is enabled. Consult database with cache layer.
   * Falls back to safe default (disabled) if not found in database.
   *
   * @param key - Feature flag key from FEATURE_FLAGS
   * @param scope - Optional scope: { global, vault, wallet }
   * @returns true if flag is explicitly enabled, false otherwise
   */
  async isEnabled(key: FeatureFlagKey, scope?: FeatureFlagScope): Promise<boolean> {
    const scopeStr = toScopeString(scope);
    const cacheKey = `${key}:${scopeStr}`;
    const cached = this.flagCache.get(cacheKey);

    // Return cached value if fresh
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL_MS) {
      return cached.enabled;
    }

    try {
      const flag = await this.prisma.featureFlag.findUnique({
        where: {
          key_scope: {
            key,
            scope: scopeStr,
          },
        },
      });

      const enabled = flag?.enabled ?? false; // Safe default: disabled
      this.flagCache.set(cacheKey, { enabled, timestamp: Date.now() });
      return enabled;
    } catch (err) {
      logger.error({ err, key, scope }, "feature flag lookup failed, defaulting to disabled");
      return false; // Safe default on error
    }
  }

  /**
   * Set a feature flag and audit the change.
   * Server-side only; protected by RBAC middleware.
   */
  async setFlag(
    key: FeatureFlagKey,
    enabled: boolean,
    opts?: { actor?: string; reason?: string; scope?: string }
  ): Promise<void> {
    const scope = opts?.scope ?? "global";

    try {
      // Fetch current state for audit
      const existing = await this.prisma.featureFlag.findUnique({
        where: {
          key_scope: { key, scope },
        },
      });

      const previousValue = existing?.enabled ?? false;

      // Upsert flag
      await this.prisma.featureFlag.upsert({
        where: {
          key_scope: { key, scope },
        },
        create: {
          key,
          enabled,
          scope,
        },
        update: {
          enabled,
        },
      });

      // Audit trail
      await this.prisma.featureFlagAudit.create({
        data: {
          flagKey: key,
          previousValue,
          newValue: enabled,
          actor: opts?.actor,
          reason: opts?.reason,
        },
      });

      // Invalidate cache
      this.flagCache.delete(`${key}:${scope}`);

      logger.info(
        { key, scope, previousValue, newValue: enabled, actor: opts?.actor },
        "feature flag updated"
      );
    } catch (err) {
      logger.error({ err, key, enabled, scope }, "feature flag update failed");
      throw err;
    }
  }

  /** Drop the cached value for one flag + scope string so the next read hits the database. */
  invalidate(key: FeatureFlagKey, scope: string): void {
    this.flagCache.delete(`${key}:${scope}`);
  }

  /**
   * Invalidate entire cache (useful after bulk migrations or admin operations).
   */
  clearCache(): void {
    this.flagCache.clear();
  }
}
