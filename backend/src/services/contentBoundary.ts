/**
 * Sensitive-content boundaries (#content-boundaries)
 *
 * Every payload that crosses a trust boundary — rendered into user-visible
 * notices, exported as CSV/JSON downloads, or forwarded to webhook
 * subscribers — flows through this module first.
 *
 * The helpers are deliberately conservative: instead of trying to detect
 * "bad" inputs they structurally neutralise the dangerous encodings:
 *
 * - spreadsheet formula injection for CSV exports (`=`, `+`, `-`, `@`, ...)
 * - path traversal / CRLF / header injection in download filenames
 * - control characters and HTML in rendered text
 * - private / personally-identifying keys in outbound payloads
 * - SSRF via webhook targets (scheme, credentials, ports, IP literals and
 *   host allow-lists)
 *
 * The corresponding operational contract lives in
 * `docs/SECURITY_BOUNDARIES.md`.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

const MAX_PAYLOAD_DEPTH = 12;
const MAX_CELL_CHARS = 32_000;
const MAX_FILENAME_CHARS = 100;

/**
 * Keys that must never leave the backend in an export, webhook, or rendered
 * response, regardless of how they were supplied. Matching is done on a
 * normalised form of the key (case, underscores and dashes ignored) so
 * `private_key`, `privateKey`, and `PRIVATE-KEY` are all caught.
 *
 * `token` is intentionally NOT listed: it is a legitimate vault asset field
 * (e.g. `USDC`). Wallet secrets are represented by `secret`, `private_key`,
 * and `seed_phrase` instead.
 */
export const PRIVATE_FIELD_KEYS: readonly string[] = [
  "secret",
  "secret_key",
  "private_key",
  "privatekey",
  "seed",
  "seed_phrase",
  "seedphrase",
  "recovery_phrase",
  "mnemonic",
  "password",
  "passphrase",
  "authorization",
  "access_token",
  "refresh_token",
  "api_key",
  "apikey",
  "email",
  "phone",
  "phone_number",
  "ssn",
  "national_id",
  "date_of_birth",
  "dob",
  "ip_address",
  "credit_card",
  "card_number",
  "cvv",
  "bank_account",
  "routing_number",
  // Prototype-pollution vectors are treated as private too.
  "__proto__",
  "constructor",
  "prototype"
];

const NORMALIZED_PRIVATE_KEYS = new Set(PRIVATE_FIELD_KEYS.map((key) => normalizeKey(key)));

export function normalizeKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

export function isPrivateKey(key: string): boolean {
  return NORMALIZED_PRIVATE_KEYS.has(normalizeKey(key));
}

/**
 * Returns a structurally-cloned value with every private key removed at any
 * depth. Cycles and over-deep structures are replaced with markers instead of
 * being rejected so a malformed payload can never crash a response path.
 */
export function projectPublicFields(value: unknown, options: { maxDepth?: number } = {}): unknown {
  const maxDepth = options.maxDepth ?? MAX_PAYLOAD_DEPTH;
  return project(value, maxDepth, new WeakSet<object>());
}

function project(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  if (depth <= 0) return "[truncated]";
  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => project(item, depth - 1, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (isPrivateKey(key)) continue;
    out[key] = project(item, depth - 1, seen);
  }
  return out;
}

// eslint-disable-next-line no-control-regex -- control characters are exactly what this strips
const CELL_CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

/** Does the value (ignoring leading whitespace) start with a formula trigger? */
export function looksLikeSpreadsheetFormula(value: string): boolean {
  return FORMULA_TRIGGER.test(value) || FORMULA_TRIGGER.test(value.replace(/^\s+/, ""));
}

/**
 * Escapes a single CSV cell:
 *
 * - newlines / tabs / control characters are replaced so a cell can never
 *   break out of its row or smuggle control sequences into a spreadsheet
 * - values starting with `=`, `+`, `-`, `@`, tab, or CR are prefixed with a
 *   single quote (spreadsheet formula-injection mitigation)
 * - the result is always double-quoted with embedded quotes doubled
 */
export function escapeCsvCell(value: unknown): string {
  const raw = value === null || value === undefined ? "" : String(value);
  const flattened = raw.replace(/[\r\n\t]/g, " ").replace(CELL_CONTROL_CHARS, "");
  const neutralized = looksLikeSpreadsheetFormula(flattened) ? `'${flattened}` : flattened;
  const truncated =
    neutralized.length > MAX_CELL_CHARS
      ? `${neutralized.slice(0, MAX_CELL_CHARS)}[truncated]`
      : neutralized;
  return `"${truncated.replace(/"/g, '""')}"`;
}

/**
 * Sanitises a value used in a `Content-Disposition` filename. Strips path
 * segments, traversal sequences, quotes, CRLF, and any character outside a
 * conservative allow-list.
 */
export function sanitizeDownloadFilename(name: unknown, fallback = "download"): string {
  const raw = typeof name === "string" ? name : "";
  const base = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._]+/, "")
    .replace(/\.{2,}/g, ".")
    .slice(0, MAX_FILENAME_CHARS);
  return cleaned.length > 0 ? cleaned : fallback;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Renders untrusted text for a user-visible surface (notices, summaries).
 * Control characters are stripped, whitespace is collapsed, the length is
 * capped, and by default the result is HTML-escaped so a naive renderer can
 * never execute embedded markup.
 */
export function sanitizeRenderedText(
  text: unknown,
  options: { maxLength?: number; htmlEscape?: boolean } = {}
): string {
  const maxLength = options.maxLength ?? 400;
  const raw =
    typeof text === "string" ? text : text === null || text === undefined ? "" : String(text);
  const cleaned = raw
    // eslint-disable-next-line no-control-regex -- control characters are exactly what this strips
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const truncated = cleaned.length > maxLength ? `${cleaned.slice(0, maxLength)}...` : cleaned;
  return options.htmlEscape === false ? truncated : escapeHtml(truncated);
}

/* ------------------------------------------------------------------------- */
/* Webhook target policy                                                     */
/* ------------------------------------------------------------------------- */

export type WebhookTargetPolicy = {
  /** Hostnames, exact (`hooks.example.com`) or wildcard (`*.example.com`). */
  allowedHosts: readonly string[];
  /** Schemes accepted for delivery. Defaults to HTTPS only. */
  allowedSchemes?: readonly string[];
  /** Explicit ports accepted. Defaults to the scheme defaults (443). */
  allowedPorts?: readonly number[];
};

export type WebhookTargetDecision =
  | { allowed: true; url: URL }
  | { allowed: false; reason: string };

const IPV4_RE = /^(\d{1,3})(\.\d{1,3}){3}$/;

function isIpLiteralHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (IPV4_RE.test(host)) {
    return host.split(".").every((octet) => Number(octet) <= 255);
  }
  return host.includes(":");
}

function hostMatchesAllowList(hostname: string, entries: readonly string[]): boolean {
  const host = hostname.toLowerCase();
  for (const entryRaw of entries) {
    const entry = entryRaw.trim().toLowerCase();
    if (entry.length === 0) continue;
    if (entry.startsWith("*.")) {
      const suffix = entry.slice(1); // ".example.com"
      if (host !== entry.slice(2) && host.endsWith(suffix)) return true;
    } else if (host === entry) {
      return true;
    }
  }
  return false;
}

const DEFAULT_ALLOWED_SCHEMES = ["https:"] as const;
const DEFAULT_ALLOWED_PORTS = [443] as const;

/**
 * Validates an outbound webhook target against an explicit allow-list.
 *
 * Rejected outright (regardless of allow-list contents):
 * - non-HTTPS schemes (unless overridden, e.g. http for local tests)
 * - embedded credentials (`https://user:pass@host`)
 * - non-allow-listed ports
 * - IP-literal hosts (defeats DNS-rebinding-free SSRF to
 *   `169.254.169.254`, `127.0.0.1`, `10.x`, `::1`, ...)
 * - hosts not matching the allow-list; an empty allow-list denies everything
 */
export function validateWebhookTarget(
  target: string,
  policy: WebhookTargetPolicy
): WebhookTargetDecision {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return { allowed: false, reason: "invalid_url" };
  }

  const schemes = policy.allowedSchemes ?? DEFAULT_ALLOWED_SCHEMES;
  if (!schemes.includes(url.protocol)) {
    return { allowed: false, reason: "scheme_not_allowed" };
  }

  if (url.username.length > 0 || url.password.length > 0) {
    return { allowed: false, reason: "credentials_not_allowed" };
  }

  const ports = policy.allowedPorts ?? DEFAULT_ALLOWED_PORTS;
  const effectivePort = url.port
    ? Number(url.port)
    : url.protocol === "https:"
      ? 443
      : url.protocol === "http:"
        ? 80
        : -1;
  if (!ports.includes(effectivePort)) {
    return { allowed: false, reason: "port_not_allowed" };
  }

  if (isIpLiteralHost(url.hostname)) {
    return { allowed: false, reason: "ip_literal_not_allowed" };
  }

  if (policy.allowedHosts.length === 0) {
    return { allowed: false, reason: "allowlist_empty" };
  }

  if (!hostMatchesAllowList(url.hostname, policy.allowedHosts)) {
    return { allowed: false, reason: "host_not_allowed" };
  }

  return { allowed: true, url };
}

/* ------------------------------------------------------------------------- */
/* Webhook envelopes & signatures                                            */
/* ------------------------------------------------------------------------- */

export const WEBHOOK_EVENT_TYPES = [
  "action.created",
  "action.submitted",
  "action.confirmed",
  "action.reverted",
  "round.settled",
  "import.committed",
  "support_access.used"
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export function isAllowedWebhookEventType(eventType: string): eventType is WebhookEventType {
  return (WEBHOOK_EVENT_TYPES as readonly string[]).includes(eventType);
}

export type WebhookEnvelope = {
  id: string;
  event: WebhookEventType;
  occurred_at: string;
  source: string;
  data: unknown;
};

/**
 * Builds the outbound webhook envelope. The event type must be on the
 * allow-list (fail closed) and all data is projected so private fields never
 * reach a subscriber.
 */
export function buildWebhookEnvelope(input: {
  eventType: string;
  data: unknown;
  deliveryId: string;
  occurredAt?: Date;
  source?: string;
}): WebhookEnvelope {
  if (!isAllowedWebhookEventType(input.eventType)) {
    throw new Error(`webhook event type not allowed: ${input.eventType}`);
  }
  return {
    id: input.deliveryId,
    event: input.eventType,
    occurred_at: (input.occurredAt ?? new Date()).toISOString(),
    source: input.source ?? "vaultquest-backend",
    data: projectPublicFields(input.data)
  };
}

export function signWebhookPayload(secret: string, body: string): string {
  const digest = createHmac("sha256", secret).update(body, "utf8").digest("hex");
  return `sha256=${digest}`;
}

/** Constant-time comparison so signature checks cannot be timing-probed. */
export function verifyWebhookSignature(secret: string, body: string, header: string): boolean {
  const expected = signWebhookPayload(secret, body);
  const expectedBuf = Buffer.from(expected, "utf8");
  const providedBuf = Buffer.from(header ?? "", "utf8");
  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}
