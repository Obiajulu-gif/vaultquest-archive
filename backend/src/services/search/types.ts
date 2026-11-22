import type { Role, Permission } from "../../../../lib/rbac.js";

export type RecordType = "vault" | "saved_pool" | "quest" | "settlement";

export type VisibilityLevel =
  | "public"
  | "unlisted"
  | "owner_only"
  | "maintainer_only"
  | "permission_scoped";

export interface SearchIndexDocument {
  id: string; // Unique composite key, e.g. "vault:pool_123"
  recordType: RecordType;
  recordId: string;
  title: string;
  description?: string;
  asset?: string;
  network?: string;
  status?: string;
  ownerWallet?: string; // Address of owner if owner-scoped
  visibility: VisibilityLevel;
  requiredRoles?: Role[];
  requiredPermissions?: Permission[];
  searchableText: string; // Pre-processed normalized tokens for fast substring/token search
  metadata?: Record<string, unknown>; // Sanitized safe metadata only
  version: number;
  sourceUpdatedAt: Date;
  indexedAt: Date;
  deletedAt?: Date | null;
}

export interface SearchContext {
  walletAddress?: string;
  roles?: readonly Role[];
  permissions?: readonly Permission[];
}

export interface SearchQueryOptions {
  q?: string;
  recordType?: RecordType | RecordType[];
  asset?: string;
  network?: string;
  status?: string;
  limit?: number;
  offset?: number;
  includeUnlisted?: boolean;
}

export interface SearchResult {
  items: SearchIndexDocument[];
  total: number;
  limit: number;
  offset: number;
  executionMs: number;
}

export type AnomalyType =
  | "missing"
  | "stale"
  | "visibility_mismatch"
  | "orphaned";

export interface RepairAnomaly {
  recordType: RecordType;
  recordId: string;
  anomalyType: AnomalyType;
  reason: string;
  recommendation: "rebuild_from_source" | "restrict_visibility" | "refresh_visibility" | "purge_or_review";
  sourceVersion?: number;
  indexVersion?: number;
  indexSourceUpdatedAt?: Date;
  expectedVisibility?: VisibilityLevel;
  actualVisibility?: VisibilityLevel;
}

export interface RepairReport {
  scannedSources: number;
  scannedIndexEntries: number;
  anomaliesDetected: {
    missing: number;
    stale: number;
    visibilityMismatch: number;
    orphaned: number;
  };
  repairedCount: number;
  details: Array<{
    recordType: RecordType;
    recordId: string;
    anomalyType: AnomalyType;
    recommendation: RepairAnomaly["recommendation"];
    actionTaken: "inserted" | "updated" | "deleted" | "skipped_changed";
  }>;
  startedAt: Date;
  completedAt: Date;
  durationMs: number;
}
