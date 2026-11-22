/**
 * Strict Allow-List Validation Service (#990)
 *
 * Implements strict, defensive allow-list validation for URLs, file types,
 * and data destinations to prevent SSRF, remote code execution, file path traversal,
 * MIME confusion, and unauthorized data egress across trust boundaries.
 *
 * Design:
 * - Fail-Closed: Everything not explicitly allowed is denied.
 * - Time Complexity: O(L) where L is string length, O(H) for host matching.
 * - Space Complexity: O(1) auxiliary memory.
 */

import { AppError } from "../errors.js";
import { ERROR_CODES } from "../constants.js";
import { StrKey } from "@stellar/stellar-sdk";

/* ------------------------------------------------------------------------- */
/* 1. URL Allow-List Validation                                              */
/* ------------------------------------------------------------------------- */

export interface UrlPolicy {
  /** Explicit allowed hostnames (e.g. "horizon.stellar.org") or wildcards ("*.stellar.org"). */
  allowedHosts: readonly string[];
  /** Allowed protocols (schemes). Defaults to ["https:"] only. */
  allowedSchemes?: readonly string[];
  /** Allowed TCP ports. Defaults to [443] for https (and 80 if http is explicitly allowed). */
  allowedPorts?: readonly number[];
  /** Whether to allow localhost/127.0.0.1 (strictly for dev/test environments). Defaults to false. */
  allowLocalhost?: boolean;
}

export type UrlValidationResult =
  | { allowed: true; url: URL; normalized: string }
  | { allowed: false; reason: string; code: string };

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const CONTROL_OR_WHITESPACE = /[\u0000-\u001F\u007F-\u009F\s]/;

// Private/Reserved IPv4 CIDR blocks
function isPrivateOrReservedIpv4(parts: number[]): boolean {
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8 (Private)
  if (a === 127) return true; // 127.0.0.0/8 (Loopback)
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (Link-local / Cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 (Private)
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 (Private)
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
  if (a >= 224) return true; // 224.0.0.0/4 (Multicast/Reserved)
  return false;
}

function isIpLiteral(hostname: string): boolean {
  const clean = hostname.replace(/^\[|\]$/g, "").trim().toLowerCase();
  
  // IPv4 check
  const v4Match = clean.match(IPV4_PATTERN);
  if (v4Match) {
    const octets = [Number(v4Match[1]), Number(v4Match[2]), Number(v4Match[3]), Number(v4Match[4])];
    if (octets.every((o) => o <= 255)) {
      return true;
    }
  }

  // IPv6 check or hex/octal IP representation
  if (clean.includes(":") || /^0x[0-9a-f]+$/i.test(clean) || /^\d+$/.test(clean)) {
    return true;
  }

  return false;
}

function matchHostAllowlist(hostname: string, allowedHosts: readonly string[]): boolean {
  const host = hostname.toLowerCase();
  for (const entryRaw of allowedHosts) {
    const entry = entryRaw.trim().toLowerCase();
    if (!entry) continue;
    if (entry.startsWith("*.")) {
      const suffix = entry.slice(1); // e.g. ".stellar.org"
      if (host !== entry.slice(2) && host.endsWith(suffix)) {
        return true;
      }
    } else if (host === entry) {
      return true;
    }
  }
  return false;
}

export const DEFAULT_URL_POLICY: UrlPolicy = {
  allowedHosts: [
    "stellar.org",
    "*.stellar.org",
    "soroban-testnet.stellar.org",
    "horizon-testnet.stellar.org",
    "rpc.testnet.stellar.org",
    "horizon.stellar.org",
    "vaultquest.app",
    "*.vaultquest.app"
  ],
  allowedSchemes: ["https:"],
  allowedPorts: [443],
  allowLocalhost: false
};

export function validateUrl(rawUrl: string, policy: UrlPolicy = DEFAULT_URL_POLICY): UrlValidationResult {
  if (!rawUrl || typeof rawUrl !== "string") {
    return { allowed: false, reason: "URL must be a non-empty string", code: ERROR_CODES.URL_NOT_ALLOWED };
  }

  if (CONTROL_OR_WHITESPACE.test(rawUrl)) {
    return { allowed: false, reason: "URL contains control characters or whitespace", code: ERROR_CODES.URL_NOT_ALLOWED };
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: "Malformed URL structure", code: ERROR_CODES.URL_NOT_ALLOWED };
  }

  // Scheme enforcement
  const allowedSchemes = policy.allowedSchemes ?? ["https:"];
  if (!allowedSchemes.includes(parsed.protocol)) {
    return { allowed: false, reason: `Scheme '${parsed.protocol}' is not allowed`, code: ERROR_CODES.URL_NOT_ALLOWED };
  }

  // Credential enforcement (no http-basic embedded auth)
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return { allowed: false, reason: "Embedded URL credentials are not allowed", code: ERROR_CODES.URL_NOT_ALLOWED };
  }

  // Port enforcement
  const effectivePort = parsed.port
    ? Number(parsed.port)
    : parsed.protocol === "https:"
      ? 443
      : parsed.protocol === "http:"
        ? 80
        : -1;

  const allowedPorts = policy.allowedPorts ?? (parsed.protocol === "https:" ? [443] : [80, 443]);
  if (!allowedPorts.includes(effectivePort)) {
    return { allowed: false, reason: `Port ${effectivePort} is not allowed`, code: ERROR_CODES.URL_NOT_ALLOWED };
  }

  const hostname = parsed.hostname.toLowerCase();

  // Localhost check
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]") {
    if (!policy.allowLocalhost) {
      return { allowed: false, reason: "Localhost targets are rejected", code: ERROR_CODES.URL_NOT_ALLOWED };
    }
    return { allowed: true, url: parsed, normalized: parsed.toString() };
  }

  // IP literal and SSRF mitigation
  if (isIpLiteral(hostname)) {
    const v4 = hostname.match(IPV4_PATTERN);
    if (v4) {
      const octets = [Number(v4[1]), Number(v4[2]), Number(v4[3]), Number(v4[4])];
      if (isPrivateOrReservedIpv4(octets)) {
        return { allowed: false, reason: "Private or metadata IP literals are strictly forbidden", code: ERROR_CODES.URL_NOT_ALLOWED };
      }
    }
    return { allowed: false, reason: "IP literal hostnames are not allowed", code: ERROR_CODES.URL_NOT_ALLOWED };
  }

  // Allowlist matching
  if (!policy.allowedHosts || policy.allowedHosts.length === 0) {
    return { allowed: false, reason: "Host allow-list is empty (fail-closed)", code: ERROR_CODES.URL_NOT_ALLOWED };
  }

  if (!matchHostAllowlist(hostname, policy.allowedHosts)) {
    return { allowed: false, reason: `Host '${hostname}' is not in the allow-list`, code: ERROR_CODES.URL_NOT_ALLOWED };
  }

  return { allowed: true, url: parsed, normalized: parsed.toString() };
}

/* ------------------------------------------------------------------------- */
/* 2. File Type & Extension Allow-List Validation                            */
/* ------------------------------------------------------------------------- */

export interface FileTypePolicy {
  /** Allowed file extensions in lowercase including the leading dot (e.g. [".json", ".csv"]). */
  allowedExtensions: readonly string[];
  /** Allowed MIME types (e.g. ["application/json", "text/csv"]). */
  allowedMimeTypes: readonly string[];
  /** Strict 1:1 mapping from extension to expected MIME types. */
  extensionToMimeMap?: Record<string, readonly string[]>;
  /** Maximum filename length in characters. Defaults to 120. */
  maxFilenameLength?: number;
}

export type FileTypeValidationResult =
  | { allowed: true; filename: string; extension: string; mimeType: string }
  | { allowed: false; reason: string; code: string };

const DANGEROUS_EXTENSIONS = new Set([
  ".exe", ".bat", ".cmd", ".sh", ".bash", ".zsh", ".ps1", ".psm1",
  ".js", ".mjs", ".cjs", ".ts", ".jsx", ".tsx",
  ".html", ".htm", ".xhtml", ".shtml",
  ".svg", ".xml", ".xsl", ".xslt",
  ".php", ".php3", ".phtml", ".py", ".pyc", ".rb", ".pl", ".cgi",
  ".bin", ".elf", ".so", ".dylib", ".dll",
  ".jar", ".war", ".ear",
  ".zip", ".tar", ".gz", ".7z", ".rar"
]);

export const DEFAULT_FILE_TYPE_POLICY: FileTypePolicy = {
  allowedExtensions: [".csv", ".json"],
  allowedMimeTypes: ["text/csv", "application/json", "text/plain"],
  extensionToMimeMap: {
    ".csv": ["text/csv", "text/plain"],
    ".json": ["application/json", "text/plain"]
  },
  maxFilenameLength: 120
};

export function validateFileType(
  rawFilename: string,
  rawMimeType?: string,
  policy: FileTypePolicy = DEFAULT_FILE_TYPE_POLICY
): FileTypeValidationResult {
  if (!rawFilename || typeof rawFilename !== "string") {
    return { allowed: false, reason: "Filename must be a non-empty string", code: ERROR_CODES.FILE_TYPE_NOT_ALLOWED };
  }

  // Null byte injection check
  if (rawFilename.includes("\0") || rawFilename.includes("%00")) {
    return { allowed: false, reason: "Filename contains null bytes", code: ERROR_CODES.FILE_TYPE_NOT_ALLOWED };
  }

  // Path traversal check
  if (rawFilename.includes("/") || rawFilename.includes("\\") || rawFilename.includes("..")) {
    return { allowed: false, reason: "Path traversal characters detected in filename", code: ERROR_CODES.FILE_TYPE_NOT_ALLOWED };
  }

  const maxLen = policy.maxFilenameLength ?? 120;
  if (rawFilename.length > maxLen) {
    return { allowed: false, reason: `Filename exceeds maximum length of ${maxLen}`, code: ERROR_CODES.FILE_TYPE_NOT_ALLOWED };
  }

  // Extract base and extension
  const trimmed = rawFilename.trim();
  const lastDotIndex = trimmed.lastIndexOf(".");
  if (lastDotIndex <= 0) {
    return { allowed: false, reason: "Filename must have a valid extension", code: ERROR_CODES.FILE_TYPE_NOT_ALLOWED };
  }

  const extension = trimmed.slice(lastDotIndex).toLowerCase();
  const allowedExtensions = policy.allowedExtensions.map((e) => e.toLowerCase());

  // Dangerous extension block
  if (DANGEROUS_EXTENSIONS.has(extension)) {
    return { allowed: false, reason: `Extension '${extension}' is dangerous and forbidden`, code: ERROR_CODES.FILE_TYPE_NOT_ALLOWED };
  }

  // Multi-extension check (e.g. data.csv.exe or data.json.html)
  const segments = trimmed.split(".");
  if (segments.length > 2) {
    const priorExtensions = segments.slice(1, -1).map((s) => `.${s.toLowerCase()}`);
    for (const prior of priorExtensions) {
      if (DANGEROUS_EXTENSIONS.has(prior)) {
        return { allowed: false, reason: `Nested dangerous extension '${prior}' detected`, code: ERROR_CODES.FILE_TYPE_NOT_ALLOWED };
      }
    }
  }

  if (!allowedExtensions.includes(extension)) {
    return { allowed: false, reason: `File extension '${extension}' is not allowed`, code: ERROR_CODES.FILE_TYPE_NOT_ALLOWED };
  }

  // MIME type validation
  const mime = (rawMimeType || (extension === ".json" ? "application/json" : "text/csv")).trim().toLowerCase();
  const allowedMimes = policy.allowedMimeTypes.map((m) => m.toLowerCase());
  if (!allowedMimes.includes(mime)) {
    return { allowed: false, reason: `MIME type '${mime}' is not allowed`, code: ERROR_CODES.FILE_TYPE_NOT_ALLOWED };
  }

  // Extension-to-MIME alignment
  if (policy.extensionToMimeMap && policy.extensionToMimeMap[extension]) {
    const validMimes = policy.extensionToMimeMap[extension].map((m) => m.toLowerCase());
    if (!validMimes.includes(mime)) {
      return {
        allowed: false,
        reason: `MIME type '${mime}' does not match expected types for '${extension}'`,
        code: ERROR_CODES.FILE_TYPE_NOT_ALLOWED
      };
    }
  }

  return { allowed: true, filename: trimmed, extension, mimeType: mime };
}

/* ------------------------------------------------------------------------- */
/* 3. Destination Allow-List Validation                                      */
/* ------------------------------------------------------------------------- */

export type DestinationType = "wallet" | "webhook" | "download" | "notification_channel";

export interface DestinationTarget {
  type: DestinationType;
  target: string;
}

export interface DestinationPolicy {
  allowedTypes?: readonly DestinationType[];
  urlPolicy?: UrlPolicy;
  fileTypePolicy?: FileTypePolicy;
  allowedChannels?: readonly string[];
}

export type DestinationValidationResult =
  | { allowed: true; destination: DestinationTarget }
  | { allowed: false; reason: string; code: string };

const STELLAR_PUBLIC_KEY = /^G[A-Z0-9]{55}$/;
const DEFAULT_ALLOWED_CHANNELS = ["in_app", "webhook", "email"];

export function validateDestination(
  dest: DestinationTarget,
  policy: DestinationPolicy = {}
): DestinationValidationResult {
  if (!dest || typeof dest !== "object" || !dest.type || !dest.target) {
    return { allowed: false, reason: "Destination must specify valid type and target", code: ERROR_CODES.DESTINATION_NOT_ALLOWED };
  }

  const allowedTypes = policy.allowedTypes ?? ["wallet", "webhook", "download", "notification_channel"];
  if (!allowedTypes.includes(dest.type)) {
    return { allowed: false, reason: `Destination type '${dest.type}' is not allowed`, code: ERROR_CODES.DESTINATION_NOT_ALLOWED };
  }

  switch (dest.type) {
    case "wallet": {
      const cleanKey = dest.target.trim();
      const isValid =
        StrKey.isValidEd25519PublicKey(cleanKey) ||
        StrKey.isValidContract(cleanKey) ||
        StrKey.isValidMed25519PublicKey(cleanKey);
      if (!isValid) {
        return { allowed: false, reason: "Invalid Stellar wallet destination address format (failed SEP-23 StrKey checksum or format)", code: ERROR_CODES.DESTINATION_NOT_ALLOWED };
      }
      return { allowed: true, destination: { type: "wallet", target: cleanKey } };
    }

    case "webhook": {
      const urlCheck = validateUrl(dest.target, policy.urlPolicy ?? DEFAULT_URL_POLICY);
      if (!urlCheck.allowed) {
        return { allowed: false, reason: `Webhook destination rejected: ${urlCheck.reason}`, code: urlCheck.code };
      }
      return { allowed: true, destination: { type: "webhook", target: urlCheck.normalized } };
    }

    case "download": {
      const fileCheck = validateFileType(dest.target, undefined, policy.fileTypePolicy ?? DEFAULT_FILE_TYPE_POLICY);
      if (!fileCheck.allowed) {
        return { allowed: false, reason: `Download filename rejected: ${fileCheck.reason}`, code: fileCheck.code };
      }
      return { allowed: true, destination: { type: "download", target: fileCheck.filename } };
    }

    case "notification_channel": {
      const channels = policy.allowedChannels ?? DEFAULT_ALLOWED_CHANNELS;
      const targetChannel = dest.target.trim().toLowerCase();
      if (!channels.includes(targetChannel)) {
        return { allowed: false, reason: `Notification channel '${targetChannel}' is not allowed`, code: ERROR_CODES.DESTINATION_NOT_ALLOWED };
      }
      return { allowed: true, destination: { type: "notification_channel", target: targetChannel } };
    }

    default:
      return { allowed: false, reason: "Unsupported destination type", code: ERROR_CODES.DESTINATION_NOT_ALLOWED };
  }
}
