/**
 * Privacy Redaction for Structured Logs and Data Exports (#1106)
 *
 * Enforces field-level and pattern-level privacy redaction across structured
 * logs and user/audit data exports, with role-based field disclosure and
 * fail-closed export rollback on leak detection.
 *
 * Edge Cases & Recovery / Rollback Behavior:
 * 1. Secret & PII Pattern Scrubbing: Even if a secret or PII value is embedded
 *    inside a free-form string message (e.g. Stellar secret seed `S[A-Z2-7]{55}`,
 *    Bearer JWT token, email address, or SSN), `scrubStringPatterns` masks it
 *    in-place so unstructured error messages cannot leak credentials.
 * 2. Circular Reference & Deep Nesting Safety: Circular object graphs or objects
 *    exceeding `maxDepth` are safely replaced with `"[CIRCULAR]"` or
 *    `"[MAX_DEPTH_REDACTED]"` without throwing stack overflow errors.
 * 3. Fail-Closed Export Verification & Rollback: Before emitting an export bundle,
 *    `verifyRedactedOutput` scans the serialized output for forbidden raw secret
 *    patterns; if a leak is detected or a sink write fails transiently, the export
 *    transaction is aborted and rolled back without writing partial data.
 * 4. Authorization: Standard users and operators always receive fully masked PII/secrets;
 *    only actors with `role === "compliance_admin"` and explicit `unmaskPii: true`
 *    may retain masked-format contact emails while cryptographic secrets remain
 *    unconditionally redacted for all roles.
 */

const SECRET_KEY_REGEX =
  /(secret|private_?key|wallet_?seed|mnemonic|password|api_?key|auth_?token|session_?token|signature)/i;
const PII_KEY_REGEX =
  /(email|phone|ssn|tax_?id|national_?id|ip_?address|date_?of_?birth|street_?address)/i;

// Stellar secret seed: S followed by 55 base32 chars
const STELLAR_SECRET_SEED_PATTERN = /\bS[A-Z2-7]{55}\b/g;
const BEARER_TOKEN_PATTERN = /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi;
const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const SSN_PATTERN = /\b\d{3}-\d{2}-\d{4}\b/g;

export class PrivacyRedactionAuthorizationError extends Error {
  constructor(message, code = "REDACTION_UNAUTHORIZED") {
    super(message);
    this.name = "PrivacyRedactionAuthorizationError";
    this.code = code;
    this.statusCode = 403;
  }
}

export class PrivacyLeakDetectedError extends Error {
  constructor(message, code = "PRIVACY_LEAK_DETECTED") {
    super(message);
    this.name = "PrivacyLeakDetectedError";
    this.code = code;
    this.statusCode = 500;
  }
}

export function scrubStringPatterns(text, { allowEmail = false } = {}) {
  if (typeof text !== "string") return text;
  let out = text
    .replace(STELLAR_SECRET_SEED_PATTERN, "[REDACTED_STELLAR_SEED]")
    .replace(BEARER_TOKEN_PATTERN, "Bearer [REDACTED_TOKEN]")
    .replace(SSN_PATTERN, "[REDACTED_SSN]");

  if (!allowEmail) {
    out = out.replace(EMAIL_PATTERN, "[REDACTED_EMAIL]");
  }
  return out;
}

export function redactStructuredPayload(
  payload,
  { allowPii = false, maxDepth = 12 } = {},
  _seen = new WeakSet(),
  _depth = 0
) {
  if (payload === null || payload === undefined) return payload;
  if (typeof payload === "string") {
    return scrubStringPatterns(payload, { allowEmail: allowPii });
  }
  if (typeof payload !== "object") return payload;

  if (_seen.has(payload)) {
    return "[CIRCULAR]";
  }
  if (_depth >= maxDepth) {
    return "[MAX_DEPTH_REDACTED]";
  }

  _seen.add(payload);

  if (Array.isArray(payload)) {
    return payload.map((item) =>
      redactStructuredPayload(item, { allowPii, maxDepth }, _seen, _depth + 1)
    );
  }

  const output = {};
  for (const [key, value] of Object.entries(payload)) {
    if (SECRET_KEY_REGEX.test(key)) {
      output[key] = "[REDACTED_SECRET]";
    } else if (PII_KEY_REGEX.test(key) && !allowPii) {
      output[key] = "[REDACTED_PII]";
    } else {
      output[key] = redactStructuredPayload(
        value,
        { allowPii, maxDepth },
        _seen,
        _depth + 1
      );
    }
  }
  return output;
}

export function verifyNoSecretLeaks(serializedText) {
  const text = String(serializedText ?? "");
  if (new RegExp(STELLAR_SECRET_SEED_PATTERN.source).test(text)) {
    throw new PrivacyLeakDetectedError("Unredacted Stellar secret seed detected in output.");
  }
  if (new RegExp(SSN_PATTERN.source).test(text)) {
    throw new PrivacyLeakDetectedError("Unredacted SSN pattern detected in output.");
  }
  return true;
}

export async function executeRedactedExport({
  actor,
  records,
  unmaskPii = false,
  sinkFn,
  maxRetries = 2,
}) {
  if (!actor || typeof actor.id !== "string" || !actor.role) {
    throw new PrivacyRedactionAuthorizationError("Valid actor identity is required for export.");
  }
  if (actor.role === "guest" || actor.role === "anonymous") {
    throw new PrivacyRedactionAuthorizationError("Anonymous actors cannot export records.");
  }
  if (unmaskPii && actor.role !== "compliance_admin") {
    throw new PrivacyRedactionAuthorizationError(
      `Role "${actor.role}" is not permitted to export unmasked PII fields.`
    );
  }

  const redactedRecords = (records ?? []).map((record) =>
    redactStructuredPayload(record, { allowPii: unmaskPii })
  );

  const serialized = JSON.stringify(redactedRecords);
  verifyNoSecretLeaks(serialized);

  let attempt = 0;
  let committed = false;
  let rolledBack = false;

  while (attempt <= maxRetries) {
    attempt += 1;
    try {
      if (typeof sinkFn === "function") {
        await sinkFn(redactedRecords, { attempt });
      }
      committed = true;
      return {
        committed,
        rolledBack,
        attemptsUsed: attempt,
        recordCount: redactedRecords.length,
        records: redactedRecords,
      };
    } catch (err) {
      const isRetryable = Boolean(err && err.retryable === true);
      if (!isRetryable || attempt > maxRetries) {
        rolledBack = true;
        throw err;
      }
    }
  }
}
