/**
 * Webhook delivery (#content-boundaries)
 *
 * Delivers allow-listed events to allow-listed HTTPS targets with an HMAC
 * signature. The delivery path is intentionally strict:
 *
 * - targets are validated against a host allow-list before any DNS/connect
 *   work happens (see {@link validateWebhookTarget});
 * - redirects are never followed — a 3xx response is a delivery failure;
 * - the request body is a fully-projected envelope so subscriber payloads
 *   can never carry private fields;
 * - failures return a structured outcome instead of throwing, so an unhealthy
 *   subscriber can never break the action that triggered the webhook.
 */

import { randomUUID } from "node:crypto";
import {
  buildWebhookEnvelope,
  signWebhookPayload,
  validateWebhookTarget,
  type WebhookTargetPolicy
} from "./contentBoundary.js";

export type WebhookDeliveryOutcome = {
  ok: boolean;
  delivery_id: string;
  /** Host (and path) of the target; never includes credentials or query. */
  target: string;
  event: string;
  attempts: number;
  latency_ms: number;
  status_code?: number;
  error?: string;
};

export type WebhookDeliveryLogger = {
  info?: (obj: unknown, msg?: string) => void;
  warn?: (obj: unknown, msg?: string) => void;
};

export type WebhookDeliveryOptions = {
  secret: string;
  policy: WebhookTargetPolicy;
  timeoutMs?: number;
  maxAttempts?: number;
  backoffMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  logger?: WebhookDeliveryLogger;
  now?: () => number;
};

export type WebhookDeliveryInput = {
  eventType: string;
  data: unknown;
  occurredAt?: Date;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function safeTargetLabel(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.host}${url.pathname}`;
  } catch {
    return "invalid";
  }
}

export class WebhookDeliveryService {
  private readonly secret: string;
  private readonly policy: WebhookTargetPolicy;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly backoffMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logger: WebhookDeliveryLogger;
  private readonly now: () => number;

  constructor(options: WebhookDeliveryOptions) {
    this.secret = options.secret;
    this.policy = options.policy;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.backoffMs = options.backoffMs ?? 250;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.sleep = options.sleep ?? defaultSleep;
    this.logger = options.logger ?? {};
    this.now = options.now ?? (() => Date.now());
  }

  async deliver(target: string, input: WebhookDeliveryInput): Promise<WebhookDeliveryOutcome> {
    const startedAt = this.now();
    const deliveryId = randomUUID();
    const base: Pick<WebhookDeliveryOutcome, "delivery_id" | "target" | "event"> = {
      delivery_id: deliveryId,
      target: safeTargetLabel(target),
      event: input.eventType
    };

    const decision = validateWebhookTarget(target, this.policy);
    if (!decision.allowed) {
      this.logger.warn?.(
        { target: safeTargetLabel(target), reason: decision.reason },
        "webhook target rejected"
      );
      return {
        ...base,
        ok: false,
        attempts: 0,
        latency_ms: Math.round(this.now() - startedAt),
        error: `target_rejected:${decision.reason}`
      };
    }

    let body: string;
    try {
      body = JSON.stringify(
        buildWebhookEnvelope({
          eventType: input.eventType,
          data: input.data,
          deliveryId,
          occurredAt: input.occurredAt
        })
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ...base,
        ok: false,
        attempts: 0,
        latency_ms: Math.round(this.now() - startedAt),
        error: `envelope_rejected:${message}`
      };
    }

    const signature = signWebhookPayload(this.secret, body);
    let attempts = 0;
    let lastError = "unknown_error";
    let lastStatus: number | undefined;

    while (attempts < this.maxAttempts) {
      attempts += 1;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(decision.url.toString(), {
          method: "POST",
          redirect: "manual",
          headers: {
            "content-type": "application/json",
            "x-vaultquest-event": input.eventType,
            "x-vaultquest-delivery": deliveryId,
            "x-vaultquest-signature": signature
          },
          body,
          signal: controller.signal
        });
        lastStatus = response.status;

        // Never follow redirects: a compromised allow-listed host must not be
        // able to bounce delivery to an internal address.
        if (lastStatus >= 300 && lastStatus < 400) {
          lastError = "redirect_rejected";
          break;
        }

        if (lastStatus >= 200 && lastStatus < 300) {
          // Discard any response body without interpreting it.
          response.body?.cancel?.().catch(() => undefined);
          return {
            ...base,
            ok: true,
            attempts,
            latency_ms: Math.round(this.now() - startedAt),
            status_code: lastStatus
          };
        }

        lastError = `http_${lastStatus}`;
      } catch (err) {
        lastError = controller.signal.aborted
          ? "timeout"
          : err instanceof Error
            ? err.message
            : String(err);
      } finally {
        clearTimeout(timer);
      }

      if (attempts < this.maxAttempts) {
        await this.sleep(this.backoffMs * attempts);
      }
    }

    this.logger.warn?.(
      { target: safeTargetLabel(target), attempts, error: lastError },
      "webhook delivery failed"
    );

    return {
      ...base,
      ok: false,
      attempts,
      latency_ms: Math.round(this.now() - startedAt),
      ...(lastStatus !== undefined ? { status_code: lastStatus } : {}),
      error: lastError
    };
  }
}
