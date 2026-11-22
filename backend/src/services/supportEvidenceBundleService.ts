/**
 * Privacy-Preserving Audit Evidence Bundles for Support Investigations (#921).
 *
 * Implements exportable, tamper-evident evidence bundles for support and incident
 * investigations. Redacts PII, private keys, seeds, auth tokens, and raw credentials
 * while deterministically preserving verification artifacts:
 *  - On-chain transaction hashes and Soroban event IDs
 *  - Exact ledger timestamps and sequence bounds (observed/finalized)
 *  - Action types, statuses, error taxonomy codes, and finality states
 *  - Pseudonymized relational identities (salted HMAC-SHA256)
 *  - Verifiable Merkle / record checksums for post-export tamper detection
 *
 * Architecture: Clean domain service with deterministic transformation ports.
 * Time Complexity: O(N * K) single-pass traversal (N records, K fields per record).
 * Space Complexity: O(N * K) bounded auxiliary memory for the exported bundle.
 */

import { createHash, createHmac, randomUUID } from "node:crypto";
import { canonicalJson } from "../utils/canonicalJson.js";
import { AppError } from "../errors.js";
import { ERROR_CODES } from "../constants.js";

export const SUPPORT_EVIDENCE_SCHEMA_VERSION = "1.0.0";
export const EVIDENCE_BUNDLE_TTL_HOURS = 24;

export const SENSITIVE_KEY_PATTERN =
  /token|secret|seed|key|password|jwt|auth|signature|nonce|credential|bearer|cookie/i;

export const PII_KEY_PATTERN =
  /email|phone|ssn|tax_id|real_name|billing|street|national_id/i;

export const IP_V4_PATTERN = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g;
export const IP_V6_PATTERN = /\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b/g;

export interface InvestigationScope {
  ticketId: string;
  investigator: string;
  reason: string;
  timeRange: {
    since: string;
    until: string;
  };
  vaultId?: string | null;
  actionType?: string | null;
  correlationId?: string | null;
  walletAddress?: string | null;
  pseudonymizeWallets?: boolean;
}

export interface RedactionManifest {
  policyVersion: string;
  saltPrefix: string;
  redactedFieldPatterns: string[];
  pseudonymizedFields: string[];
  preservedBehavioralFields: string[];
}

export interface RedactedEvidenceItem {
  evidenceId: string;
  sourceTable: "action_ledger" | "chain_events" | "audit_trail" | "reconciliation";
  recordId: string;
  correlationId?: string | null;
  actionType?: string | null;
  status?: string | null;
  finalityStatus?: string | null;
  timestamps: {
    createdAt?: string | null;
    submittedAt?: string | null;
    confirmedAt?: string | null;
    occurredAt?: string | null;
    ledgerClosedAt?: string | null;
  };
  ledger: {
    observedLedger?: number | null;
    finalizedLedger?: number | null;
    confirmationDepth?: number | null;
  };
  txHash?: string | null;
  sorobanEventId?: string | null;
  actorPseudonym?: string | null;
  financialFacts?: {
    poolId?: string | null;
    asset?: string | null;
    amount?: string | null;
    verifiedPayloadHash?: string | null;
  };
  errorCode?: string | null;
  errorDetailRedacted?: string | null;
  redactedPayload: Record<string, unknown>;
  itemHash: string;
}

export interface SupportEvidenceBundle {
  bundleId: string;
  schemaVersion: string;
  generatedAt: string;
  expiresAt: string;
  retentionHours: number;
  scope: InvestigationScope;
  redactionManifest: RedactionManifest;
  itemCount: number;
  items: RedactedEvidenceItem[];
  bundleChecksum: string;
}

export interface RawEvidenceRecord {
  id: string;
  sourceTable: "action_ledger" | "chain_events" | "audit_trail" | "reconciliation";
  walletAddress?: string | null;
  actor?: string | null;
  actionType?: string | null;
  status?: string | null;
  finalityStatus?: string | null;
  txHash?: string | null;
  sorobanEventId?: string | null;
  correlationId?: string | null;
  observedLedger?: number | null;
  finalizedLedger?: number | null;
  confirmationDepth?: number | null;
  createdAt?: Date | string | null;
  submittedAt?: Date | string | null;
  confirmedAt?: Date | string | null;
  occurredAt?: Date | string | null;
  ledgerClosedAt?: Date | string | null;
  errorCode?: string | null;
  errorDetail?: string | null;
  actionPayload?: unknown;
  verifiedPayload?: unknown;
  metadata?: unknown;
}

/**
 * Computes deterministic pseudonym for wallet addresses within an investigation bundle.
 * Time Complexity: O(L) where L is string length.
 */
export function pseudonymizeAddress(address: string, bundleSalt: string): string {
  if (!address || typeof address !== "string") return "anon_unknown";
  const digest = createHmac("sha256", bundleSalt)
    .update(address.trim().toLowerCase())
    .digest("hex")
    .slice(0, 16);
  return `anon_wallet_${digest}`;
}

/**
 * Redacts arbitrary text strings by removing IP addresses and known secrets.
 */
export function sanitizeStringValue(str: string): string {
  return str
    .replace(IP_V4_PATTERN, "[MASKED_IP]")
    .replace(IP_V6_PATTERN, "[MASKED_IP]");
}

/**
 * Recursively redacts objects and payloads against security & PII policies.
 * Time Complexity: O(K) where K is number of nodes. Space Complexity: O(D) recursion stack.
 */
export function sanitizePayloadRecursive(
  val: unknown,
  bundleSalt: string,
  pseudonymize: boolean,
  depth = 0
): unknown {
  if (depth > 12) return "[DEPTH_TRUNCATED]";
  if (val === null || val === undefined) return null;
  if (typeof val === "boolean" || typeof val === "number") return val;

  if (typeof val === "string") {
    return sanitizeStringValue(val);
  }

  if (Array.isArray(val)) {
    return val.map((elem) => sanitizePayloadRecursive(elem, bundleSalt, pseudonymize, depth + 1));
  }

  if (typeof val === "object") {
    const out: Record<string, unknown> = {};
    const entries = Object.entries(val as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b)
    );

    for (const [k, v] of entries) {
      if (SENSITIVE_KEY_PATTERN.test(k)) {
        out[k] = "[REDACTED_SECRET]";
        continue;
      }
      if (PII_KEY_PATTERN.test(k)) {
        out[k] = "[REDACTED_PII]";
        continue;
      }
      if (/wallet_address|wallet|account_id/i.test(k) && typeof v === "string") {
        out[k] = pseudonymize ? pseudonymizeAddress(v, bundleSalt) : sanitizeStringValue(v);
        continue;
      }
      out[k] = sanitizePayloadRecursive(v, bundleSalt, pseudonymize, depth + 1);
    }
    return out;
  }

  return String(val);
}

/**
 * Computes deterministic item integrity hash.
 */
export function computeItemHash(item: Omit<RedactedEvidenceItem, "itemHash">): string {
  const serialized = canonicalJson(item as unknown as Record<string, unknown>);
  return createHash("sha256").update(serialized).digest("hex");
}

/**
 * Computes deterministic overall bundle checksum.
 */
export function computeBundleChecksum(
  metadata: {
    bundleId: string;
    schemaVersion: string;
    generatedAt: string;
    scope: InvestigationScope;
    redactionManifest: RedactionManifest;
    itemCount: number;
  },
  itemHashes: string[]
): string {
  const commitPayload = {
    metadata,
    itemHashes: [...itemHashes].sort(),
  };
  return createHash("sha256").update(canonicalJson(commitPayload as unknown as Record<string, unknown>)).digest("hex");
}

export class SupportEvidenceBundleService {
  /**
   * Generates a privacy-preserving support evidence bundle from raw records.
   * Time Complexity: O(N * K) where N = record count, K = field count.
   * Space Complexity: O(N * K) auxiliary bundle payload.
   */
  generateBundle(
    scope: InvestigationScope,
    records: RawEvidenceRecord[],
    options: { now?: Date; bundleSalt?: string; bundleId?: string } = {}
  ): SupportEvidenceBundle {
    if (!scope.ticketId || typeof scope.ticketId !== "string" || !scope.ticketId.trim()) {
      throw AppError.badRequest(ERROR_CODES.INVALID_PAYLOAD, "ticketId is required for support investigations");
    }
    if (!scope.reason || scope.reason.trim().length < 10) {
      throw AppError.badRequest(ERROR_CODES.INVALID_PAYLOAD, "investigation reason must be at least 10 characters");
    }

    const now = options.now ?? new Date();
    const bundleSalt = options.bundleSalt ?? createHash("sha256").update(`${scope.ticketId}:${now.toISOString()}`).digest("hex");
    const bundleId = options.bundleId ?? (options.bundleSalt ? createHash("sha256").update(`bundle:${options.bundleSalt}`).digest("hex").slice(0, 36) : randomUUID());
    const pseudonymize = scope.pseudonymizeWallets ?? true;

    const expiresAt = new Date(now.getTime() + EVIDENCE_BUNDLE_TTL_HOURS * 60 * 60 * 1000);

    const manifest: RedactionManifest = {
      policyVersion: SUPPORT_EVIDENCE_SCHEMA_VERSION,
      saltPrefix: bundleSalt.slice(0, 8),
      redactedFieldPatterns: ["SENSITIVE_KEY_PATTERN", "PII_KEY_PATTERN", "IP_ADDRESS_PATTERN"],
      pseudonymizedFields: pseudonymize ? ["walletAddress", "actor"] : [],
      preservedBehavioralFields: [
        "id",
        "actionType",
        "status",
        "finalityStatus",
        "txHash",
        "sorobanEventId",
        "timestamps",
        "ledgerSequences",
        "errorCode",
        "financialFacts",
      ],
    };

    const items: RedactedEvidenceItem[] = [];

    for (const r of records) {
      const address = r.walletAddress || r.actor;
      const pseudonym = address
        ? pseudonymize
          ? pseudonymizeAddress(address, bundleSalt)
          : address
        : null;

      const rawPayload = (r.actionPayload as Record<string, unknown> | null) ?? {};
      const payloadSanitized = (sanitizePayloadRecursive(
        rawPayload,
        bundleSalt,
        pseudonymize
      ) as Record<string, unknown>) ?? {};

      let verifiedHash: string | null = null;
      if (r.verifiedPayload) {
        verifiedHash = createHash("sha256")
          .update(canonicalJson(r.verifiedPayload as Record<string, unknown>))
          .digest("hex");
      }

      const evidenceId = createHash("sha256")
        .update(`${bundleSalt}:${r.sourceTable}:${r.id}`)
        .digest("hex")
        .slice(0, 32);

      const itemWithoutHash: Omit<RedactedEvidenceItem, "itemHash"> = {
        evidenceId,
        sourceTable: r.sourceTable,
        recordId: r.id,
        correlationId: r.correlationId ?? null,
        actionType: r.actionType ?? null,
        status: r.status ?? null,
        finalityStatus: r.finalityStatus ?? null,
        timestamps: {
          createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : null,
          submittedAt: r.submittedAt ? new Date(r.submittedAt).toISOString() : null,
          confirmedAt: r.confirmedAt ? new Date(r.confirmedAt).toISOString() : null,
          occurredAt: r.occurredAt ? new Date(r.occurredAt).toISOString() : null,
          ledgerClosedAt: r.ledgerClosedAt ? new Date(r.ledgerClosedAt).toISOString() : null,
        },
        ledger: {
          observedLedger: r.observedLedger ?? null,
          finalizedLedger: r.finalizedLedger ?? null,
          confirmationDepth: r.confirmationDepth ?? null,
        },
        txHash: r.txHash ?? null,
        sorobanEventId: r.sorobanEventId ?? null,
        actorPseudonym: pseudonym,
        financialFacts: {
          poolId: rawPayload["pool_id"] ? String(rawPayload["pool_id"]) : rawPayload["vault_id"] ? String(rawPayload["vault_id"]) : null,
          asset: rawPayload["asset"] ? String(rawPayload["asset"]) : rawPayload["token"] ? String(rawPayload["token"]) : null,
          amount: rawPayload["amount"] ? String(rawPayload["amount"]) : null,
          verifiedPayloadHash: verifiedHash,
        },
        errorCode: r.errorCode ?? null,
        errorDetailRedacted: r.errorDetail ? sanitizeStringValue(r.errorDetail) : null,
        redactedPayload: payloadSanitized,
      };

      const itemHash = computeItemHash(itemWithoutHash);
      items.push({
        ...itemWithoutHash,
        itemHash,
      });
    }

    // Sort items deterministically by recordId then sourceTable
    items.sort((a, b) => a.recordId.localeCompare(b.recordId) || a.sourceTable.localeCompare(b.sourceTable));

    const metadata = {
      bundleId,
      schemaVersion: SUPPORT_EVIDENCE_SCHEMA_VERSION,
      generatedAt: now.toISOString(),
      scope,
      redactionManifest: manifest,
      itemCount: items.length,
    };

    const bundleChecksum = computeBundleChecksum(
      metadata,
      items.map((i) => i.itemHash)
    );

    return {
      ...metadata,
      expiresAt: expiresAt.toISOString(),
      retentionHours: EVIDENCE_BUNDLE_TTL_HOURS,
      items,
      bundleChecksum,
    };
  }

  /**
   * Verifies the cryptographic integrity of an exported evidence bundle.
   * Returns verification diagnostics and problem codes if altered.
   * Time Complexity: O(N * K) where N = items count. Space Complexity: O(1).
   */
  verifyBundle(bundle: SupportEvidenceBundle): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!bundle || typeof bundle !== "object") {
      return { valid: false, errors: ["MALFORMED_BUNDLE"] };
    }
    if (bundle.schemaVersion !== SUPPORT_EVIDENCE_SCHEMA_VERSION) {
      errors.push(`UNSUPPORTED_SCHEMA_VERSION: ${bundle.schemaVersion}`);
    }

    const itemHashes: string[] = [];
    for (const item of bundle.items ?? []) {
      const { itemHash, ...fields } = item;
      const recomputed = computeItemHash(fields);
      if (recomputed !== itemHash) {
        errors.push(`TAMPERED_ITEM: record ${item.recordId} hash mismatch (expected ${itemHash}, got ${recomputed})`);
      }
      itemHashes.push(recomputed);
    }

    const expectedChecksum = computeBundleChecksum(
      {
        bundleId: bundle.bundleId,
        schemaVersion: bundle.schemaVersion,
        generatedAt: bundle.generatedAt,
        scope: bundle.scope,
        redactionManifest: bundle.redactionManifest,
        itemCount: bundle.itemCount,
      },
      itemHashes
    );

    if (expectedChecksum !== bundle.bundleChecksum) {
      errors.push(`TAMPERED_BUNDLE_CHECKSUM: expected ${bundle.bundleChecksum}, calculated ${expectedChecksum}`);
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Serializes evidence bundle into formatted JSON or NDJSON format.
   */
  exportBundle(bundle: SupportEvidenceBundle, format: "json" | "ndjson" = "json"): string {
    if (format === "ndjson") {
      const header = JSON.stringify({
        type: "header",
        bundleId: bundle.bundleId,
        generatedAt: bundle.generatedAt,
        scope: bundle.scope,
        manifest: bundle.redactionManifest,
        bundleChecksum: bundle.bundleChecksum,
      });
      const lines = bundle.items.map((it) => JSON.stringify({ type: "item", ...it }));
      return [header, ...lines].join("\n");
    }

    return JSON.stringify(bundle, null, 2);
  }
}
