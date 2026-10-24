/**
 * Deterministic webhook replay tool (#852).
 *
 * Safe local replay of webhook payloads for debugging and idempotency verification.
 */

import * as crypto from 'crypto';

export interface WebhookPayload {
  id: string;
  event: string;
  timestamp: number;
  data: Record<string, unknown>;
  signature: string;
}

export interface ReplayOptions {
  secret: string;
  skipSignatureCheck?: boolean;
  dryRun?: boolean;
}

export interface ReplayResult {
  success: boolean;
  status: 'success' | 'duplicate' | 'stale' | 'invalid_signature' | 'malformed';
  message: string;
  payloadId: string;
}

const processedPayloads = new Set<string>();
const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Generate webhook signature.
 */
export function generateSignature(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Verify webhook signature.
 */
export function verifySignature(
  payload: string,
  signature: string,
  secret: string
): boolean {
  const expected = generateSignature(payload, secret);
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

/**
 * Replay a webhook payload.
 */
export function replayWebhook(
  payload: WebhookPayload,
  options: ReplayOptions
): ReplayResult {
  // Check for malformed payload
  if (!payload.id || !payload.event || !payload.timestamp) {
    return {
      success: false,
      status: 'malformed',
      message: 'Missing required fields',
      payloadId: payload.id || 'unknown',
    };
  }

  // Check signature unless skipped
  if (!options.skipSignatureCheck) {
    const payloadStr = JSON.stringify({ ...payload, signature: '' });
    if (!verifySignature(payloadStr, payload.signature, options.secret)) {
      return {
        success: false,
        status: 'invalid_signature',
        message: 'Signature verification failed',
        payloadId: payload.id,
      };
    }
  }

  // Check for duplicate
  if (processedPayloads.has(payload.id)) {
    return {
      success: true,
      status: 'duplicate',
      message: 'Payload already processed - no side effects',
      payloadId: payload.id,
    };
  }

  // Check for stale payload
  const age = Date.now() - payload.timestamp;
  if (age > STALE_THRESHOLD_MS) {
    return {
      success: false,
      status: 'stale',
      message: `Payload is ${Math.round(age / 1000)}s old (threshold: ${STALE_THRESHOLD_MS / 1000}s)`,
      payloadId: payload.id,
    };
  }

  // Process payload (dry run or actual)
  if (!options.dryRun) {
    processedPayloads.add(payload.id);
  }

  return {
    success: true,
    status: 'success',
    message: 'Payload processed successfully',
    payloadId: payload.id,
  };
}

/**
 * Load fixture payload from JSON.
 */
export function loadFixture(fixtureJson: string): WebhookPayload {
  try {
    return JSON.parse(fixtureJson) as WebhookPayload;
  } catch {
    throw new Error('Invalid fixture JSON');
  }
}

/**
 * Reset processed payloads (for testing).
 */
export function resetProcessed(): void {
  processedPayloads.clear();
}
