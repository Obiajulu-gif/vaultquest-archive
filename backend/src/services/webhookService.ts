/**
 * Signed Webhook Verification and Replay-Window Enforcement Service (#799)
 *
 * Provides cryptographic signature verification, replay-window enforcement,
 * and event deduplication for inbound webhooks and integration callbacks.
 *
 * Supported providers:
 * - `stripe`: HMAC-SHA256 verification using Stripe timestamped signature format (t=...,v1=...)
 * - `internal` / `vaultquest`: HMAC-SHA256 verification for internal subsystem callbacks
 * - `stellar` / `ed25519`: Ed25519 signature verification using Stellar public keys
 * - `custom`: Generic HMAC-SHA256 webhook provider
 */

import { createHash, createHmac } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";
import type { PrismaClient } from "@prisma/client";
import { ERROR_CODES } from "../constants.js";
import { AppError } from "../errors.js";
import { timingSafeStringEqual } from "../utils/timingSafeCompare.js";
import type { WebhookProvider } from "../schemas/webhooks.js";

export const DEFAULT_WEBHOOK_TOLERANCE_SECONDS = 300; // 5 minutes
export const DEFAULT_FUTURE_TOLERANCE_SECONDS = 60; // 1 minute allowed clock drift into future
export const DEFAULT_EVENT_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days retention

export const STELLAR_WEBHOOK_DOMAIN = "vaultquest-webhook:v1\n";

export interface WebhookEventRecord {
  id: string;
  provider: string;
  eventId: string;
  eventType: string;
  payloadHash: string;
  status: "processing" | "processed" | "failed";
  response?: Record<string, unknown> | null;
  error?: string | null;
  receivedAt: Date;
  processedAt?: Date | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface WebhookEventStore {
  findEvent(provider: string, eventId: string): Promise<WebhookEventRecord | null>;
  claimEvent(
    record: Omit<WebhookEventRecord, "id" | "receivedAt" | "createdAt" | "updatedAt">
  ): Promise<{ claimed: boolean; existing?: WebhookEventRecord; record: WebhookEventRecord }>;
  markProcessed(provider: string, eventId: string, response?: Record<string, unknown> | null): Promise<void>;
  markFailed(provider: string, eventId: string, error: string): Promise<void>;
  cleanupExpired(): Promise<number>;
}

export class InMemoryWebhookEventStore implements WebhookEventStore {
  private events = new Map<string, WebhookEventRecord>();
  private readonly now: () => Date;

  constructor(options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }

  private key(provider: string, eventId: string): string {
    return `${provider}:${eventId}`;
  }

  async findEvent(provider: string, eventId: string): Promise<WebhookEventRecord | null> {
    const record = this.events.get(this.key(provider, eventId));
    if (!record) return null;
    if (record.expiresAt < this.now()) {
      this.events.delete(this.key(provider, eventId));
      return null;
    }
    return structuredClone(record);
  }

  async claimEvent(
    record: Omit<WebhookEventRecord, "id" | "receivedAt" | "createdAt" | "updatedAt">
  ): Promise<{ claimed: boolean; existing?: WebhookEventRecord; record: WebhookEventRecord }> {
    const k = this.key(record.provider, record.eventId);
    const existing = await this.findEvent(record.provider, record.eventId);
    if (existing) {
      return { claimed: false, existing, record: existing };
    }

    const now = this.now();
    const created: WebhookEventRecord = {
      id: crypto.randomUUID(),
      ...record,
      receivedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    this.events.set(k, created);
    return { claimed: true, record: created };
  }

  async markProcessed(provider: string, eventId: string, response?: Record<string, unknown> | null): Promise<void> {
    const k = this.key(provider, eventId);
    const record = this.events.get(k);
    if (record) {
      record.status = "processed";
      record.response = response ?? null;
      record.processedAt = this.now();
      record.updatedAt = this.now();
    }
  }

  async markFailed(provider: string, eventId: string, error: string): Promise<void> {
    const k = this.key(provider, eventId);
    const record = this.events.get(k);
    if (record) {
      record.status = "failed";
      record.error = error;
      record.updatedAt = this.now();
    }
  }

  async cleanupExpired(): Promise<number> {
    const now = this.now();
    let count = 0;
    for (const [k, v] of this.events.entries()) {
      if (v.expiresAt < now) {
        this.events.delete(k);
        count++;
      }
    }
    return count;
  }

  clear(): void {
    this.events.clear();
  }
}

export class PrismaWebhookEventStore implements WebhookEventStore {
  constructor(private readonly prisma: PrismaClient) {}

  async findEvent(provider: string, eventId: string): Promise<WebhookEventRecord | null> {
    const row = await (this.prisma as any).processedWebhookEvent.findUnique({
      where: {
        provider_eventId: {
          provider,
          eventId,
        },
      },
    });
    if (!row) return null;
    if (row.expiresAt < new Date()) {
      await (this.prisma as any).processedWebhookEvent.delete({
        where: { id: row.id },
      }).catch(() => {});
      return null;
    }
    return row as unknown as WebhookEventRecord;
  }

  async claimEvent(
    record: Omit<WebhookEventRecord, "id" | "receivedAt" | "createdAt" | "updatedAt">
  ): Promise<{ claimed: boolean; existing?: WebhookEventRecord; record: WebhookEventRecord }> {
    try {
      const created = await (this.prisma as any).processedWebhookEvent.create({
        data: {
          provider: record.provider,
          eventId: record.eventId,
          eventType: record.eventType,
          payloadHash: record.payloadHash,
          status: record.status,
          response: (record.response as any) ?? null,
          error: record.error ?? null,
          expiresAt: record.expiresAt,
          processedAt: record.processedAt ?? null,
        },
      });
      return { claimed: true, record: created as unknown as WebhookEventRecord };
    } catch (err: any) {
      if (err?.code === "P2002") {
        // Unique constraint collision — retrieve existing
        const existing = await this.findEvent(record.provider, record.eventId);
        if (existing) {
          return { claimed: false, existing, record: existing };
        }
      }
      throw err;
    }
  }

  async markProcessed(provider: string, eventId: string, response?: Record<string, unknown> | null): Promise<void> {
    await (this.prisma as any).processedWebhookEvent.update({
      where: {
        provider_eventId: {
          provider,
          eventId,
        },
      },
      data: {
        status: "processed",
        response: (response as any) ?? null,
        processedAt: new Date(),
      },
    }).catch(() => {});
  }

  async markFailed(provider: string, eventId: string, error: string): Promise<void> {
    await (this.prisma as any).processedWebhookEvent.update({
      where: {
        provider_eventId: {
          provider,
          eventId,
        },
      },
      data: {
        status: "failed",
        error,
      },
    }).catch(() => {});
  }

  async cleanupExpired(): Promise<number> {
    const result = await (this.prisma as any).processedWebhookEvent.deleteMany({
      where: {
        expiresAt: { lt: new Date() },
      },
    });
    return result.count;
  }
}

export interface VerifySignatureOptions {
  provider: WebhookProvider;
  rawBody: string | Buffer;
  headers: Record<string, string | string[] | undefined>;
  secret?: string;
  publicKey?: string;
  toleranceSeconds?: number;
  futureToleranceSeconds?: number;
  now?: () => Date;
}

export interface VerifiedWebhookEvent<T = any> {
  provider: WebhookProvider;
  eventId: string;
  eventType: string;
  timestamp: Date;
  payload: T;
  rawBody: string;
  payloadHash: string;
}

export interface ProcessWebhookResult<T = any> {
  duplicate: boolean;
  wasDuplicate: boolean;
  eventId: string;
  eventType: string;
  data: T;
}

export interface WebhookServiceDeps {
  store?: WebhookEventStore;
  secrets?: {
    stripe?: string;
    internal?: string;
    custom?: string;
    stellarPublicKey?: string;
  };
  defaultToleranceSeconds?: number;
  futureToleranceSeconds?: number;
  eventTtlSeconds?: number;
  now?: () => Date;
}

export class WebhookService {
  private readonly store: WebhookEventStore;
  private readonly secrets: {
    stripe?: string;
    internal?: string;
    custom?: string;
    stellarPublicKey?: string;
  };
  private readonly defaultToleranceSeconds: number;
  private readonly futureToleranceSeconds: number;
  private readonly eventTtlSeconds: number;
  private readonly now: () => Date;

  constructor(deps: WebhookServiceDeps = {}) {
    this.now = deps.now ?? (() => new Date());
    this.store = deps.store ?? new InMemoryWebhookEventStore({ now: this.now });
    this.secrets = deps.secrets ?? {};
    this.defaultToleranceSeconds = deps.defaultToleranceSeconds ?? DEFAULT_WEBHOOK_TOLERANCE_SECONDS;
    this.futureToleranceSeconds = deps.futureToleranceSeconds ?? DEFAULT_FUTURE_TOLERANCE_SECONDS;
    this.eventTtlSeconds = deps.eventTtlSeconds ?? DEFAULT_EVENT_TTL_SECONDS;
  }

  /**
   * Extract header value case-insensitively
   */
  private getHeader(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
    const lowerName = name.toLowerCase();
    for (const [key, val] of Object.entries(headers)) {
      if (key.toLowerCase() === lowerName) {
        if (Array.isArray(val)) return val[0];
        return val;
      }
    }
    return undefined;
  }

  /**
   * Verify signature and enforce replay window for an incoming webhook
   */
  verifyAndParse<T = any>(options: VerifySignatureOptions): VerifiedWebhookEvent<T> {
    const {
      provider,
      rawBody: inputRawBody,
      headers,
      toleranceSeconds = this.defaultToleranceSeconds,
      futureToleranceSeconds = this.futureToleranceSeconds,
      now = this.now,
    } = options;

    const rawBodyString = typeof inputRawBody === "string" ? inputRawBody : inputRawBody.toString("utf8");

    let parsedPayload: any;
    try {
      parsedPayload = JSON.parse(rawBodyString);
    } catch {
      throw AppError.badRequest(ERROR_CODES.WEBHOOK_EVENT_MALFORMED, "Malformed webhook JSON payload");
    }

    if (!parsedPayload || typeof parsedPayload !== "object") {
      throw AppError.badRequest(ERROR_CODES.WEBHOOK_EVENT_MALFORMED, "Webhook payload must be a JSON object");
    }

    const payloadHash = createHash("sha256").update(rawBodyString, "utf8").digest("hex");

    switch (provider) {
      case "stripe":
        return this.verifyStripeWebhook<T>({
          rawBodyString,
          parsedPayload,
          payloadHash,
          headers,
          secret: options.secret ?? this.secrets.stripe,
          toleranceSeconds,
          futureToleranceSeconds,
          now,
        });

      case "internal":
        return this.verifyInternalWebhook<T>({
          rawBodyString,
          parsedPayload,
          payloadHash,
          headers,
          secret: options.secret ?? this.secrets.internal,
          toleranceSeconds,
          futureToleranceSeconds,
          now,
        });

      case "stellar":
        return this.verifyStellarWebhook<T>({
          rawBodyString,
          parsedPayload,
          payloadHash,
          headers,
          publicKey: options.publicKey ?? this.secrets.stellarPublicKey,
          toleranceSeconds,
          futureToleranceSeconds,
          now,
        });

      case "custom":
        return this.verifyCustomWebhook<T>({
          rawBodyString,
          parsedPayload,
          payloadHash,
          headers,
          secret: options.secret ?? this.secrets.custom,
          toleranceSeconds,
          futureToleranceSeconds,
          now,
        });

      default:
        throw AppError.badRequest(
          ERROR_CODES.WEBHOOK_PROVIDER_UNSUPPORTED,
          `Unsupported webhook provider: ${String(provider)}`
        );
    }
  }

  /**
   * Stripe Webhook Verification (HMAC-SHA256 over timestamp.payload)
   */
  private verifyStripeWebhook<T>(ctx: {
    rawBodyString: string;
    parsedPayload: any;
    payloadHash: string;
    headers: Record<string, string | string[] | undefined>;
    secret?: string;
    toleranceSeconds: number;
    futureToleranceSeconds: number;
    now: () => Date;
  }): VerifiedWebhookEvent<T> {
    const { rawBodyString, parsedPayload, payloadHash, headers, secret, toleranceSeconds, futureToleranceSeconds, now } = ctx;

    const signatureHeader = this.getHeader(headers, "stripe-signature");
    if (!signatureHeader) {
      throw AppError.badRequest(ERROR_CODES.WEBHOOK_SIGNATURE_MISSING, "Missing Stripe-Signature header");
    }

    if (!secret) {
      throw AppError.badRequest(ERROR_CODES.WEBHOOK_SIGNATURE_INVALID, "Stripe webhook secret is not configured");
    }

    // Parse stripe-signature header: t=timestamp,v1=signature[,v0=...]
    const parts = signatureHeader.split(",").map((p) => p.trim());
    let timestampStr: string | undefined;
    const signatures: string[] = [];

    for (const part of parts) {
      const [k, v] = part.split("=");
      if (k === "t") timestampStr = v;
      if (k === "v1") signatures.push(v);
    }

    if (!timestampStr) {
      throw AppError.badRequest(ERROR_CODES.WEBHOOK_TIMESTAMP_MISSING, "Stripe signature header is missing timestamp (t=)");
    }

    if (signatures.length === 0) {
      throw AppError.badRequest(ERROR_CODES.WEBHOOK_SIGNATURE_MISSING, "Stripe signature header is missing v1 signature");
    }

    const timestampSec = parseInt(timestampStr, 10);
    if (isNaN(timestampSec) || timestampSec <= 0) {
      throw AppError.badRequest(ERROR_CODES.WEBHOOK_TIMESTAMP_STALE, "Stripe signature contains invalid timestamp");
    }

    // Enforce replay window
    const nowSec = Math.floor(now().getTime() / 1000);
    const ageSeconds = nowSec - timestampSec;

    if (ageSeconds > toleranceSeconds) {
      throw AppError.badRequest(
        ERROR_CODES.WEBHOOK_TIMESTAMP_STALE,
        `Webhook timestamp is stale (age: ${ageSeconds}s, max tolerance: ${toleranceSeconds}s)`
      );
    }

    if (ageSeconds < -futureToleranceSeconds) {
      throw AppError.badRequest(
        ERROR_CODES.WEBHOOK_TIMESTAMP_STALE,
        `Webhook timestamp is too far in the future (${Math.abs(ageSeconds)}s ahead, max skew: ${futureToleranceSeconds}s)`
      );
    }

    // Compute expected signature: HMAC-SHA256(secret, `${t}.${rawBody}`)
    const signedPayload = `${timestampStr}.${rawBodyString}`;
    const expectedSignature = createHmac("sha256", secret).update(signedPayload, "utf8").digest("hex");

    const matched = signatures.some((sig) => timingSafeStringEqual(sig, expectedSignature));
    if (!matched) {
      throw AppError.badRequest(ERROR_CODES.WEBHOOK_SIGNATURE_INVALID, "Invalid Stripe webhook signature");
    }

    const eventId = String(parsedPayload.id || parsedPayload.eventId || `stripe_${payloadHash.slice(0, 16)}`);
    const eventType = String(parsedPayload.type || parsedPayload.event || "stripe.event");

    return {
      provider: "stripe",
      eventId,
      eventType,
      timestamp: new Date(timestampSec * 1000),
      payload: parsedPayload,
      rawBody: rawBodyString,
      payloadHash,
    };
  }

  /**
   * Internal / VaultQuest Webhook Verification (HMAC-SHA256)
   */
  private verifyInternalWebhook<T>(ctx: {
    rawBodyString: string;
    parsedPayload: any;
    payloadHash: string;
    headers: Record<string, string | string[] | undefined>;
    secret?: string;
    toleranceSeconds: number;
    futureToleranceSeconds: number;
    now: () => Date;
  }): VerifiedWebhookEvent<T> {
    const { rawBodyString, parsedPayload, payloadHash, headers, secret, toleranceSeconds, futureToleranceSeconds, now } = ctx;

    const signature =
      this.getHeader(headers, "x-webhook-signature") ||
      this.getHeader(headers, "x-vaultquest-signature") ||
      this.getHeader(headers, "x-signature");

    if (!signature) {
      throw AppError.badRequest(ERROR_CODES.WEBHOOK_SIGNATURE_MISSING, "Missing X-Webhook-Signature header");
    }

    if (!secret) {
      throw AppError.badRequest(ERROR_CODES.WEBHOOK_SIGNATURE_INVALID, "Internal webhook secret is not configured");
    }

    const timestampHeader =
      this.getHeader(headers, "x-webhook-timestamp") ||
      this.getHeader(headers, "x-timestamp") ||
      parsedPayload.timestamp;

    if (!timestampHeader) {
      throw AppError.badRequest(ERROR_CODES.WEBHOOK_TIMESTAMP_MISSING, "Missing X-Webhook-Timestamp header");
    }

    let timestampMs: number;
    if (typeof timestampHeader === "number") {
      timestampMs = timestampHeader < 10000000000 ? timestampHeader * 1000 : timestampHeader;
    } else {
      const parsedNum = Number(timestampHeader);
      if (!isNaN(parsedNum) && parsedNum > 0) {
        timestampMs = parsedNum < 10000000000 ? parsedNum * 1000 : parsedNum;
      } else {
        timestampMs = new Date(timestampHeader).getTime();
      }
    }

    if (isNaN(timestampMs) || timestampMs <= 0) {
      throw AppError.badRequest(ERROR_CODES.WEBHOOK_TIMESTAMP_STALE, "Invalid webhook timestamp");
    }

    // Enforce replay window
    const nowMs = now().getTime();
    const ageSeconds = Math.floor((nowMs - timestampMs) / 1000);

    if (ageSeconds > toleranceSeconds) {
      throw AppError.badRequest(
        ERROR_CODES.WEBHOOK_TIMESTAMP_STALE,
        `Webhook event is stale (age: ${ageSeconds}s, allowed window: ${toleranceSeconds}s)`
      );
    }

    if (ageSeconds < -futureToleranceSeconds) {
      throw AppError.badRequest(
        ERROR_CODES.WEBHOOK_TIMESTAMP_STALE,
        `Webhook timestamp is too far in the future (${Math.abs(ageSeconds)}s ahead)`
      );
    }

    const eventId = String(
      this.getHeader(headers, "x-webhook-id") ||
      this.getHeader(headers, "x-event-id") ||
      parsedPayload.id ||
      parsedPayload.eventId ||
      parsedPayload.event_id ||
      `evt_${payloadHash.slice(0, 16)}`
    );

    const eventType = String(
      parsedPayload.event ||
      parsedPayload.type ||
      parsedPayload.event_type ||
      this.getHeader(headers, "x-webhook-event") ||
      "vaultquest.event"
    );

    // Verify signature: check `${timestamp}.${rawBody}` or `${timestamp}.${eventId}.${rawBody}`
    const expectedSig1 = createHmac("sha256", secret).update(`${timestampHeader}.${rawBodyString}`, "utf8").digest("hex");
    const expectedSig2 = createHmac("sha256", secret).update(`${timestampHeader}.${eventId}.${rawBodyString}`, "utf8").digest("hex");
    const expectedSig3 = createHmac("sha256", secret).update(rawBodyString, "utf8").digest("hex");

    const matched =
      timingSafeStringEqual(signature, expectedSig1) ||
      timingSafeStringEqual(signature, expectedSig2) ||
      timingSafeStringEqual(signature, expectedSig3) ||
      timingSafeStringEqual(signature, `sha256=${expectedSig1}`) ||
      timingSafeStringEqual(signature, `sha256=${expectedSig2}`);

    if (!matched) {
      throw AppError.badRequest(ERROR_CODES.WEBHOOK_SIGNATURE_INVALID, "Invalid internal webhook signature");
    }

    return {
      provider: "internal",
      eventId,
      eventType,
      timestamp: new Date(timestampMs),
      payload: parsedPayload,
      rawBody: rawBodyString,
      payloadHash,
    };
  }

  /**
   * Stellar / Ed25519 Webhook Verification
   */
  private verifyStellarWebhook<T>(ctx: {
    rawBodyString: string;
    parsedPayload: any;
    payloadHash: string;
    headers: Record<string, string | string[] | undefined>;
    publicKey?: string;
    toleranceSeconds: number;
    futureToleranceSeconds: number;
    now: () => Date;
  }): VerifiedWebhookEvent<T> {
    const { rawBodyString, parsedPayload, payloadHash, headers, publicKey, toleranceSeconds, futureToleranceSeconds, now } = ctx;

    const signature =
      this.getHeader(headers, "x-signature") ||
      this.getHeader(headers, "x-webhook-signature");

    if (!signature) {
      throw AppError.badRequest(ERROR_CODES.WEBHOOK_SIGNATURE_MISSING, "Missing X-Signature header");
    }

    const key =
      this.getHeader(headers, "x-public-key") ||
      this.getHeader(headers, "x-key-id") ||
      publicKey;

    if (!key) {
      throw AppError.badRequest(ERROR_CODES.WEBHOOK_SIGNATURE_INVALID, "Missing public key for Stellar webhook verification");
    }

    const timestampHeader =
      this.getHeader(headers, "x-timestamp") ||
      this.getHeader(headers, "x-webhook-timestamp") ||
      parsedPayload.timestamp;

    if (!timestampHeader) {
      throw AppError.badRequest(ERROR_CODES.WEBHOOK_TIMESTAMP_MISSING, "Missing X-Timestamp header");
    }

    let timestampMs: number;
    const parsedNum = Number(timestampHeader);
    if (!isNaN(parsedNum) && parsedNum > 0) {
      timestampMs = parsedNum < 10000000000 ? parsedNum * 1000 : parsedNum;
    } else {
      timestampMs = new Date(timestampHeader).getTime();
    }

    if (isNaN(timestampMs) || timestampMs <= 0) {
      throw AppError.badRequest(ERROR_CODES.WEBHOOK_TIMESTAMP_STALE, "Invalid webhook timestamp");
    }

    const nowMs = now().getTime();
    const ageSeconds = Math.floor((nowMs - timestampMs) / 1000);

    if (ageSeconds > toleranceSeconds) {
      throw AppError.badRequest(
        ERROR_CODES.WEBHOOK_TIMESTAMP_STALE,
        `Webhook event is stale (age: ${ageSeconds}s, allowed window: ${toleranceSeconds}s)`
      );
    }

    if (ageSeconds < -futureToleranceSeconds) {
      throw AppError.badRequest(
        ERROR_CODES.WEBHOOK_TIMESTAMP_STALE,
        `Webhook timestamp is too far in the future (${Math.abs(ageSeconds)}s ahead)`
      );
    }

    // Verify Ed25519 signature
    let sigBuffer: Buffer;
    try {
      sigBuffer = Buffer.from(signature, signature.length === 128 ? "hex" : "base64");
    } catch {
      throw AppError.badRequest(ERROR_CODES.WEBHOOK_SIGNATURE_INVALID, "Malformed signature encoding");
    }

    let verified = false;
    try {
      const keypair = Keypair.fromPublicKey(key);
      const msg1 = Buffer.from(`${STELLAR_WEBHOOK_DOMAIN}${timestampHeader}.${rawBodyString}`, "utf8");
      const msg2 = Buffer.from(`${timestampHeader}.${rawBodyString}`, "utf8");
      const msg3 = Buffer.from(rawBodyString, "utf8");

      verified = keypair.verify(msg1, sigBuffer) || keypair.verify(msg2, sigBuffer) || keypair.verify(msg3, sigBuffer);
    } catch {
      verified = false;
    }

    if (!verified) {
      throw AppError.badRequest(ERROR_CODES.WEBHOOK_SIGNATURE_INVALID, "Invalid Stellar ed25519 webhook signature");
    }

    const eventId = String(
      this.getHeader(headers, "x-webhook-id") ||
      this.getHeader(headers, "x-event-id") ||
      parsedPayload.id ||
      parsedPayload.eventId ||
      `stellar_${payloadHash.slice(0, 16)}`
    );

    const eventType = String(parsedPayload.event || parsedPayload.type || "stellar.callback");

    return {
      provider: "stellar",
      eventId,
      eventType,
      timestamp: new Date(timestampMs),
      payload: parsedPayload,
      rawBody: rawBodyString,
      payloadHash,
    };
  }

  /**
   * Custom / Third-party HMAC Webhook Verification
   */
  private verifyCustomWebhook<T>(ctx: {
    rawBodyString: string;
    parsedPayload: any;
    payloadHash: string;
    headers: Record<string, string | string[] | undefined>;
    secret?: string;
    toleranceSeconds: number;
    futureToleranceSeconds: number;
    now: () => Date;
  }): VerifiedWebhookEvent<T> {
    const { rawBodyString, parsedPayload, payloadHash, headers, secret, toleranceSeconds, futureToleranceSeconds, now } = ctx;

    const signature =
      this.getHeader(headers, "x-webhook-signature") ||
      this.getHeader(headers, "x-signature") ||
      this.getHeader(headers, "x-hub-signature-256");

    if (!signature) {
      throw AppError.badRequest(ERROR_CODES.WEBHOOK_SIGNATURE_MISSING, "Missing webhook signature header");
    }

    if (!secret) {
      throw AppError.badRequest(ERROR_CODES.WEBHOOK_SIGNATURE_INVALID, "Custom webhook secret is not configured");
    }

    const timestampHeader =
      this.getHeader(headers, "x-webhook-timestamp") ||
      this.getHeader(headers, "x-timestamp") ||
      parsedPayload.timestamp;

    if (!timestampHeader) {
      throw AppError.badRequest(ERROR_CODES.WEBHOOK_TIMESTAMP_MISSING, "Missing webhook timestamp header");
    }

    let timestampMs: number;
    const parsedNum = Number(timestampHeader);
    if (!isNaN(parsedNum) && parsedNum > 0) {
      timestampMs = parsedNum < 10000000000 ? parsedNum * 1000 : parsedNum;
    } else {
      timestampMs = new Date(timestampHeader).getTime();
    }

    if (isNaN(timestampMs) || timestampMs <= 0) {
      throw AppError.badRequest(ERROR_CODES.WEBHOOK_TIMESTAMP_STALE, "Invalid webhook timestamp");
    }

    const nowMs = now().getTime();
    const ageSeconds = Math.floor((nowMs - timestampMs) / 1000);

    if (ageSeconds > toleranceSeconds) {
      throw AppError.badRequest(
        ERROR_CODES.WEBHOOK_TIMESTAMP_STALE,
        `Webhook event is stale (age: ${ageSeconds}s, allowed window: ${toleranceSeconds}s)`
      );
    }

    if (ageSeconds < -futureToleranceSeconds) {
      throw AppError.badRequest(
        ERROR_CODES.WEBHOOK_TIMESTAMP_STALE,
        `Webhook timestamp is too far in the future (${Math.abs(ageSeconds)}s ahead)`
      );
    }

    const expectedSig = createHmac("sha256", secret).update(`${timestampHeader}.${rawBodyString}`, "utf8").digest("hex");
    const rawExpectedSig = createHmac("sha256", secret).update(rawBodyString, "utf8").digest("hex");

    const matched =
      timingSafeStringEqual(signature, expectedSig) ||
      timingSafeStringEqual(signature, `sha256=${expectedSig}`) ||
      timingSafeStringEqual(signature, rawExpectedSig) ||
      timingSafeStringEqual(signature, `sha256=${rawExpectedSig}`);

    if (!matched) {
      throw AppError.badRequest(ERROR_CODES.WEBHOOK_SIGNATURE_INVALID, "Invalid webhook signature");
    }

    const eventId = String(
      this.getHeader(headers, "x-webhook-id") ||
      this.getHeader(headers, "x-event-id") ||
      parsedPayload.id ||
      parsedPayload.eventId ||
      `custom_${payloadHash.slice(0, 16)}`
    );

    const eventType = String(parsedPayload.event || parsedPayload.type || "custom.event");

    return {
      provider: "custom",
      eventId,
      eventType,
      timestamp: new Date(timestampMs),
      payload: parsedPayload,
      rawBody: rawBodyString,
      payloadHash,
    };
  }

  /**
   * Process a verified webhook event with atomic deduplication and replay prevention.
   *
   * If the event ID was already processed, returns the cached result with `duplicate: true`
   * and DOES NOT execute the side-effect handler again.
   */
  async processEvent<TResult = any, TPayload = any>(
    verified: VerifiedWebhookEvent<TPayload>,
    handler: (event: VerifiedWebhookEvent<TPayload>) => Promise<TResult>
  ): Promise<ProcessWebhookResult<TResult>> {
    const expiresAt = new Date(this.now().getTime() + this.eventTtlSeconds * 1000);

    // Atomically claim or inspect event
    const claim = await this.store.claimEvent({
      provider: verified.provider,
      eventId: verified.eventId,
      eventType: verified.eventType,
      payloadHash: verified.payloadHash,
      status: "processing",
      response: null,
      error: null,
      processedAt: null,
      expiresAt,
    });

    if (!claim.claimed && claim.existing) {
      // Event was already registered
      if (claim.existing.status === "processed") {
        return {
          duplicate: true,
          wasDuplicate: true,
          eventId: verified.eventId,
          eventType: verified.eventType,
          data: (claim.existing.response ?? { acknowledged: true }) as TResult,
        };
      }

      if (claim.existing.status === "processing") {
        throw AppError.conflict(
          ERROR_CODES.WEBHOOK_DUPLICATE_EVENT,
          `Webhook event ${verified.eventId} is already in progress`
        );
      }

      // If previously failed, allow retry
    }

    try {
      const result = await handler(verified);

      await this.store.markProcessed(
        verified.provider,
        verified.eventId,
        (result as unknown as Record<string, unknown>) ?? { acknowledged: true }
      );

      return {
        duplicate: false,
        wasDuplicate: false,
        eventId: verified.eventId,
        eventType: verified.eventType,
        data: result,
      };
    } catch (err: any) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      await this.store.markFailed(verified.provider, verified.eventId, errorMsg);
      throw err;
    }
  }

  /**
   * Helper to verify and process in a single call
   */
  async handleInboundWebhook<TResult = any>(
    options: VerifySignatureOptions,
    handler: (event: VerifiedWebhookEvent) => Promise<TResult>
  ): Promise<ProcessWebhookResult<TResult>> {
    const verified = this.verifyAndParse(options);
    return this.processEvent(verified, handler);
  }

  /**
   * Cleanup expired event records
   */
  async cleanupExpiredEvents(): Promise<number> {
    return this.store.cleanupExpired();
  }
}

/**
 * Utility function to generate valid webhook signatures for testing or outbound internal callbacks
 */
export function generateWebhookSignature(options: {
  provider: WebhookProvider;
  secret?: string;
  keypair?: Keypair;
  payload: string | Record<string, unknown>;
  timestamp?: number | string;
  eventId?: string;
}): {
  signature: string;
  timestamp: string;
  headers: Record<string, string>;
  rawBody: string;
} {
  const rawBody = typeof options.payload === "string" ? options.payload : JSON.stringify(options.payload);
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
  let extractedId: string | undefined;
  if (typeof options.payload === "object" && options.payload !== null) {
    extractedId = (options.payload as any).id || (options.payload as any).eventId || (options.payload as any).event_id;
  } else if (typeof options.payload === "string") {
    try {
      const parsed = JSON.parse(options.payload);
      extractedId = parsed?.id || parsed?.eventId || parsed?.event_id;
    } catch {
      // ignore
    }
  }
  const eventId = options.eventId ?? extractedId ?? crypto.randomUUID();

  switch (options.provider) {
    case "stripe": {
      if (!options.secret) throw new Error("Stripe signature requires secret");
      const sig = createHmac("sha256", options.secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex");
      const stripeSig = `t=${timestamp},v1=${sig}`;
      return {
        signature: stripeSig,
        timestamp,
        rawBody,
        headers: {
          "stripe-signature": stripeSig,
          "content-type": "application/json",
        },
      };
    }

    case "internal": {
      if (!options.secret) throw new Error("Internal signature requires secret");
      const sig = createHmac("sha256", options.secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex");
      return {
        signature: sig,
        timestamp,
        rawBody,
        headers: {
          "x-webhook-signature": sig,
          "x-webhook-timestamp": timestamp,
          "x-webhook-id": eventId,
          "content-type": "application/json",
        },
      };
    }

    case "stellar": {
      if (!options.keypair) throw new Error("Stellar signature requires Keypair");
      const msg = Buffer.from(`${STELLAR_WEBHOOK_DOMAIN}${timestamp}.${rawBody}`, "utf8");
      const sig = options.keypair.sign(msg).toString("base64");
      return {
        signature: sig,
        timestamp,
        rawBody,
        headers: {
          "x-signature": sig,
          "x-timestamp": timestamp,
          "x-public-key": options.keypair.publicKey(),
          "x-webhook-id": eventId,
          "content-type": "application/json",
        },
      };
    }

    case "custom": {
      if (!options.secret) throw new Error("Custom signature requires secret");
      const sig = createHmac("sha256", options.secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex");
      return {
        signature: sig,
        timestamp,
        rawBody,
        headers: {
          "x-webhook-signature": sig,
          "x-webhook-timestamp": timestamp,
          "x-webhook-id": eventId,
          "content-type": "application/json",
        },
      };
    }
  }
}
