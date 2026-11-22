/**
 * Idempotency Service for High-Risk Write Operations
 *
 * Provides centralized idempotency and replay protection for operations that
 * can be retried by clients, workers, webhooks, or wallets.
 *
 * This service:
 * - Stores idempotency keys with expiration
 * - Caches operation outcomes for consistent responses
 * - Handles key collisions and expired keys
 * - Supports multiple operation types (actions, settlements, saved pools, notifications)
 */

import type { PrismaClient } from "@prisma/client";

/**
 * Operation types that require idempotency protection
 */
export type IdempotentOperation =
  | "action"
  | "settlement"
  | "saved_pool"
  | "notification"
  | "vault_settlement";

/**
 * Idempotency key status
 */
export type IdempotencyStatus = "pending" | "completed" | "failed" | "expired";

/**
 * Idempotency key record
 */
export interface IdempotencyKeyRecord {
  id: string;
  key: string;
  operationType: IdempotentOperation;
  walletAddress?: string;
  status: IdempotencyStatus;
  response: Record<string, unknown> | null;
  errorCode?: string | null;
  errorDetail?: string | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Idempotency check result
 */
export interface IdempotencyCheckResult {
  isDuplicate: boolean;
  record?: IdempotencyKeyRecord;
  isExpired: boolean;
}

/**
 * Idempotency execution options
 */
export interface IdempotencyOptions {
  key: string;
  operationType: IdempotentOperation;
  walletAddress?: string;
  ttlSeconds?: number;
}

/**
 * Idempotency execution result
 */
export interface IdempotencyResult<T> {
  wasDuplicate: boolean;
  data: T;
  fromCache: boolean;
}

/**
 * Default TTL for idempotency keys (24 hours)
 */
export const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

/**
 * Minimum TTL (1 minute)
 */
export const MIN_TTL_SECONDS = 60;

/**
 * Maximum TTL (30 days)
 */
export const MAX_TTL_SECONDS = 30 * 24 * 60 * 60;

export class IdempotencyService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Check if an idempotency key exists and return its status
   *
   * @param key Idempotency key to check
   * @returns Check result with duplicate status and record if found
   */
  async checkKey(key: string): Promise<IdempotencyCheckResult> {
    const record = await this.prisma.idempotencyKey.findUnique({
      where: { key },
    });

    if (!record) {
      return { isDuplicate: false, isExpired: false };
    }

    const isExpired = record.expiresAt < new Date();

    if (isExpired) {
      // Mark as expired for cleanup
      await this.prisma.idempotencyKey.update({
        where: { key },
        data: { status: "expired" },
      });
    }

    return {
      isDuplicate: !isExpired,
      record: record as unknown as IdempotencyKeyRecord,
      isExpired,
    };
  }

  /**
   * Create a new idempotency key record
   *
   * @param options Idempotency options
   * @returns Created record
   */
  async createKey(options: IdempotencyOptions): Promise<IdempotencyKeyRecord> {
    const ttlSeconds = this.validateTTL(options.ttlSeconds);
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

    const record = await this.prisma.idempotencyKey.create({
      data: {
        key: options.key,
        operationType: options.operationType,
        walletAddress: options.walletAddress,
        status: "pending",
        response: null,
        expiresAt,
      },
    });

    return record as unknown as IdempotencyKeyRecord;
  }

  /**
   * Execute an operation with idempotency protection
   *
   * @param options Idempotency options
   * @param operation Function to execute if key is not duplicate
   * @returns Operation result with duplicate flag
   */
  async executeWithIdempotency<T>(
    options: IdempotencyOptions,
    operation: () => Promise<T>
  ): Promise<IdempotencyResult<T>> {
    // Check for existing key
    const check = await this.checkKey(options.key);

    if (check.isDuplicate && check.record) {
      // Return cached response for duplicate
      if (check.record.status === "completed" && check.record.response) {
        return {
          wasDuplicate: true,
          data: check.record.response as T,
          fromCache: true,
        };
      }

      // If failed, return error
      if (check.record.status === "failed") {
        throw new Error(
          `Operation previously failed: ${check.record.errorCode} - ${check.record.errorDetail}`
        );
      }

      // If pending, throw conflict
      throw new Error("Operation is already in progress with this idempotency key");
    }

    if (check.isExpired) {
      // Key expired, delete and proceed with new operation
      await this.prisma.idempotencyKey.delete({
        where: { key: options.key },
      });
    }

    // Create new key record
    await this.createKey(options);

    try {
      // Execute the operation
      const result = await operation();

      // Store successful response
      await this.prisma.idempotencyKey.update({
        where: { key: options.key },
        data: {
          status: "completed",
          response: result as unknown as Record<string, unknown>,
        },
      });

      return {
        wasDuplicate: false,
        data: result,
        fromCache: false,
      };
    } catch (error) {
      // Store error information
      const errorCode = error instanceof Error ? error.name : "UNKNOWN_ERROR";
      const errorDetail = error instanceof Error ? error.message : String(error);

      await this.prisma.idempotencyKey.update({
        where: { key: options.key },
        data: {
          status: "failed",
          errorCode,
          errorDetail,
        },
      });

      throw error;
    }
  }

  /**
   * Mark an idempotency key as completed with a response
   *
   * @param key Idempotency key
   * @param response Response to cache
   */
  async markCompleted(key: string, response: Record<string, unknown>): Promise<void> {
    await this.prisma.idempotencyKey.update({
      where: { key },
      data: {
        status: "completed",
        response,
      },
    });
  }

  /**
   * Mark an idempotency key as failed
   *
   * @param key Idempotency key
   * @param errorCode Error code
   * @param errorDetail Error detail
   */
  async markFailed(key: string, errorCode: string, errorDetail?: string): Promise<void> {
    await this.prisma.idempotencyKey.update({
      where: { key },
      data: {
        status: "failed",
        errorCode,
        errorDetail,
      },
    });
  }

  /**
   * Delete an idempotency key
   *
   * @param key Idempotency key to delete
   */
  async deleteKey(key: string): Promise<void> {
    await this.prisma.idempotencyKey.delete({
      where: { key },
    });
  }

  /**
   * Clean up expired idempotency keys
   *
   * @returns Number of keys deleted
   */
  async cleanupExpired(): Promise<number> {
    const result = await this.prisma.idempotencyKey.deleteMany({
      where: {
        expiresAt: { lt: new Date() },
      },
    });
    return result.count;
  }

  /**
   * Get idempotency keys for a wallet
   *
   * @param walletAddress Wallet address
   * @param operationType Optional operation type filter
   * @returns Array of idempotency key records
   */
  async getKeysForWallet(
    walletAddress: string,
    operationType?: IdempotentOperation
  ): Promise<IdempotencyKeyRecord[]> {
    const records = await this.prisma.idempotencyKey.findMany({
      where: {
        walletAddress,
        ...(operationType ? { operationType } : {}),
      },
      orderBy: { createdAt: "desc" },
    });

    return records as unknown as IdempotencyKeyRecord[];
  }

  /**
   * Validate and clamp TTL to acceptable range
   *
   * @param ttlSeconds TTL in seconds
   * @returns Validated TTL
   */
  private validateTTL(ttlSeconds?: number): number {
    if (ttlSeconds === undefined) {
      return DEFAULT_TTL_SECONDS;
    }

    return Math.max(MIN_TTL_SECONDS, Math.min(MAX_TTL_SECONDS, ttlSeconds));
  }

  /**
   * Generate a deterministic idempotency key from parameters
   *
   * @param operationType Operation type
   * @param params Operation parameters
   * @returns Deterministic key
   */
  static generateKey(operationType: IdempotentOperation, params: Record<string, unknown>): string {
    const sortedParams = Object.keys(params)
      .sort()
      .reduce((acc, key) => {
        acc[key] = params[key];
        return acc;
      }, {} as Record<string, unknown>);

    const hash = require("crypto")
      .createHash("sha256")
      .update(JSON.stringify(sortedParams))
      .digest("hex");

    return `${operationType}:${hash}`;
  }
}
