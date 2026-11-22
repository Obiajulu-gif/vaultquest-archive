import crypto from "crypto";

/**
 * Canonical JSON serialization for VaultQuest payloads.
 *
 * Receipts are signed and audit records are hash-chained, so the bytes that
 * get signed/hashed must not depend on object key order or on how a value was
 * built. This module implements VaultQuest's canonical JSON profile: object
 * keys are sorted lexicographically by UTF-16 code unit, array order is
 * preserved, and domain-specific whitespace, enum casing, and decimal
 * normalization are applied before serialization.
 *
 *  - sorts object keys lexicographically at every depth,
 *  - drops `undefined` object values (JSON has no undefined),
 *  - renders `Date` as its ISO string and `bigint` as a decimal string,
 *  - rejects non-finite numbers, functions and symbols instead of silently
 *    turning them into `null` (a silent change would make a signature verify
 *    against data that was never signed).
 *
 * The goal is that equivalent payloads (differing only in key order,
 * whitespace, casing of known enum fields, or numeric representation)
 * produce the same canonical output, and that non-canonical inputs
 * are either normalized or rejected consistently.
 *
 * It is deliberately independent of `ledger.ts` so signing never depends on
 * that module loading.
 */

export type CanonicalValue =
  | null
  | boolean
  | string
  | number
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

export interface CanonicalizeOptions {
  /** With `allowedKeys`, reject top-level keys outside that allowlist. */
  strict?: boolean;
  /** Optional allowlist of top-level keys to keep. */
  allowedKeys?: readonly string[];
  /** Optional denylist of top-level keys to drop. */
  deniedKeys?: readonly string[];
  /** Maximum depth before throwing. Defaults to 20. */
  maxDepth?: number;
}

export class CanonicalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalizationError";
  }
}

/**
 * Known enum-like fields whose casing is normalized to lower-case.
 * This lets the same logical payload hash equally regardless of
 * whether a caller sent `"USDC"`, `"usdc"`, or `"Usdc"`.
 */
const LOWERCASE_ENUM_KEYS: ReadonlySet<string> = new Set([
  "asset",
  "currency",
  "networkId",
  "network_id",
  "source",
  "status",
  "actionType",
  "action_type",
]);

/**
 * Keys that must always be treated as decimal strings (never lossy
 * floating-point rounding). These are normalized to a single canonical
 * decimal representation with no trailing zeros and no exponent notation.
 */
const DECIMAL_KEYS: ReadonlySet<string> = new Set([
  "amount",
  "prize",
  "prizeAmount",
  "prize_amount",
  "weight",
  "winnerWeight",
  "winner_weight",
  "totalWeight",
  "total_weight",
  "principal_snapshot",
  "roundPrincipalSnapshot",
  "totalDeposits",
  "total_deposits",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Normalize a numeric value to a canonical decimal string.
 *
 * Accepts `number`, `bigint`, and numeric strings. Rejects NaN,
 * Infinity, and malformed numeric strings. Results are emitted without
 * trailing zeros and without exponent notation so that `1000`, `1000.0`
 * and `1e+3` all collapse to the same output.
 */
export function normalizeDecimal(value: unknown): string {
  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new CanonicalizationError(
        `unsupported numeric value: ${String(value)}`,
      );
    }
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new CanonicalizationError(
        "unsafe integer: provide precision-sensitive values as decimal strings",
      );
    }
    return normalizeDecimalString(value.toString());
  }

  if (typeof value === "string") {
    return normalizeDecimalString(value);
  }

  throw new CanonicalizationError(
    `expected numeric value, received ${typeof value}`,
  );
}

function normalizeDecimalString(raw: string): string {
  if (raw.length > 1024) {
    throw new CanonicalizationError("numeric string exceeds 1024 characters");
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    throw new CanonicalizationError("empty numeric string");
  }

  // Reject hex-like or non-numeric strings that could slip through
  // Number() coercion (e.g. "0x10", "123abc").
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) {
    throw new CanonicalizationError(`malformed numeric string: "${raw}"`);
  }

  // Expand scientific notation into a plain decimal string.
  const expanded = expandExponent(trimmed);

  const negative = expanded.startsWith("-");
  const unsigned = negative
    ? expanded.slice(1)
    : expanded.startsWith("+")
      ? expanded.slice(1)
      : expanded;

  const dotIdx = unsigned.indexOf(".");
  const intPart = dotIdx === -1 ? unsigned : unsigned.slice(0, dotIdx);
  const fracPart = dotIdx === -1 ? "" : unsigned.slice(dotIdx + 1);

  const normalizedInt = intPart.replace(/^0+(?=\d)/, "") || "0";
  const normalizedFrac = fracPart.replace(/0+$/, "");

  const body =
    normalizedFrac.length > 0
      ? `${normalizedInt}.${normalizedFrac}`
      : normalizedInt;

  const isZero = /^0(?:\.0*)?$/.test(body);
  if (isZero) {
    return "0";
  }

  return negative ? `-${body}` : body;
}

function expandExponent(value: string): string {
  const match = /^([+-]?)((?:\d+(?:\.\d*)?|\.\d+))(?:[eE]([+-]?\d+))?$/.exec(
    value,
  );
  if (!match) {
    throw new CanonicalizationError(`malformed numeric string: "${value}"`);
  }

  const sign = match[1] === "-" ? "-" : "";
  const mantissa = match[2];
  const exponent = match[3] ? Number(match[3]) : 0;

  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1024) {
    throw new CanonicalizationError("numeric exponent exceeds supported range");
  }

  if (!exponent) return `${sign}${mantissa}`;

  const dot = mantissa.indexOf(".");
  const integer = dot === -1 ? mantissa : mantissa.slice(0, dot);
  const fraction = dot === -1 ? "" : mantissa.slice(dot + 1);
  const digits = integer + fraction;
  const point = integer.length + exponent;

  if (point <= 0) {
    return `${sign}0.${"0".repeat(-point)}${digits}`;
  }

  if (point >= digits.length) {
    return `${sign}${digits}${"0".repeat(point - digits.length)}`;
  }

  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

function normalizeKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed === "") {
    throw new CanonicalizationError("object keys must be non-empty");
  }
  return trimmed;
}

function normalizeString(key: string, value: string): string {
  const trimmed = value.trim();
  if (LOWERCASE_ENUM_KEYS.has(key)) {
    return trimmed.toLowerCase();
  }
  return trimmed;
}

function canonicalizeValue(
  key: string | null,
  value: unknown,
  depth: number,
  options: CanonicalizeOptions,
  maxDepth: number,
): CanonicalValue {
  if (depth > maxDepth) {
    throw new CanonicalizationError(
      `payload exceeds maximum depth of ${maxDepth}`,
    );
  }

  if (value === null || value === undefined) {
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new CanonicalizationError(
        `unsupported numeric value: ${String(value)}`,
      );
    }
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new CanonicalizationError(
        "unsafe integer: provide precision-sensitive values as decimal strings",
      );
    }
    if (key !== null && DECIMAL_KEYS.has(key)) {
      return normalizeDecimal(value);
    }
    if (Number.isInteger(value)) {
      return value.toString();
    }
    return normalizeDecimal(value);
  }

  if (typeof value === "string") {
    if (key !== null && DECIMAL_KEYS.has(key)) {
      return normalizeDecimal(value);
    }
    return key !== null ? normalizeString(key, value) : value.trim();
  }

  if (Array.isArray(value)) {
    return value.map((v) =>
      canonicalizeValue(null, v, depth + 1, options, maxDepth),
    );
  }

  if (isPlainObject(value)) {
    // A null prototype keeps a payload key named `__proto__` as data instead
    // of invoking Object.prototype's legacy setter during serialization.
    const out = Object.create(null) as Record<string, CanonicalValue>;
    const originalKeys = Object.keys(value).filter(
      (k) => value[k] !== undefined,
    );
    const keys = originalKeys
      .map(normalizeKey)
      .filter((key) => {
        if (depth !== 0) return true;
        if (options.deniedKeys?.includes(key)) return false;
        if (options.allowedKeys && !options.allowedKeys.includes(key)) {
          if (options.strict) {
            throw new CanonicalizationError(`unknown top-level key: "${key}"`);
          }
          return false;
        }
        return true;
      })
      .sort();

    const normalizedOriginal = originalKeys.map(normalizeKey);
    const dupes = new Set<string>();
    for (const k of normalizedOriginal) {
      if (dupes.has(k)) {
        throw new CanonicalizationError(
          `duplicate key after normalization: "${k}"`,
        );
      }
      dupes.add(k);
    }

    for (const key of keys) {
      const originalKey = originalKeys.find((ok) => normalizeKey(ok) === key)!;
      out[key] = canonicalizeValue(
        key,
        value[originalKey],
        depth + 1,
        options,
        maxDepth,
      );
    }

    return out;
  }

  throw new CanonicalizationError(
    `unsupported value type: ${Object.prototype.toString.call(value)}`,
  );
}

/**
 * Produce a canonical JSON string for a payload.
 *
 * - Object keys are sorted lexicographically by UTF-16 code unit.
 * - Array order is preserved (arrays are order-sensitive by definition).
 * - Strings are trimmed; known enum fields are lowercased.
 * - Numeric fields are normalized to a canonical decimal representation.
 * - `null` and `undefined` collapse to `null`.
 */
export function canonicalize(
  value: unknown,
  options: CanonicalizeOptions = {},
): CanonicalValue {
  const maxDepth = options.maxDepth ?? 20;
  return canonicalizeValue(null, value, 0, options, maxDepth);
}

/**
 * Serialize a payload to canonical JSON. Equivalent payloads produce
 * identical output bytes.
 */
export function canonicalStringify(
  value: unknown,
  options: CanonicalizeOptions = {},
): string {
  return JSON.stringify(canonicalize(value, options));
}

/**
 * Backwards-compatible alias for the legacy `canonicalJson` entry point.
 */
export function canonicalJson(value: unknown): string {
  return canonicalStringify(value);
}

/**
 * SHA256 hash of the canonical JSON representation of a payload.
 */
export function canonicalHash(
  value: unknown,
  options: CanonicalizeOptions = {},
): string {
  return crypto
    .createHash("sha256")
    .update(canonicalStringify(value, options), "utf8")
    .digest("hex");
}

/**
 * Backwards-compatibility helper for legacy records.
 *
 * Older records were signed with `JSON.stringify` over the raw object
 * (key order dependent). This function returns the legacy bytes so verifiers
 * can attempt both the canonical and legacy representations during the
 * migration window.
 */
export function legacyStringify(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * Return true when a value is already in canonical form (i.e. round-trip
 * through `canonicalize` is identical). Useful for validation and for
 * deciding whether a legacy record needs re-hashing.
 */
export function isCanonical(
  value: unknown,
  options: CanonicalizeOptions = {},
): boolean {
  try {
    const canonical = canonicalize(value, options);
    return JSON.stringify(canonical) === JSON.stringify(value);
  } catch {
    return false;
  }
}
