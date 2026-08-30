export const POOL_STATUS = {
  DRAFT: "draft",
  UPCOMING: "upcoming",
  ACTIVE: "active",
  PAUSED: "paused",
  MATURED: "matured",
  SETTLING: "settling",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
  OPEN: "open",
  LOCKED: "locked",
  DRAWING: "drawing",
  SETTLED: "settled",
  PENDING: "pending",
} as const;

export type PoolStatus = (typeof POOL_STATUS)[keyof typeof POOL_STATUS];

export interface PoolStatusMeta {
  label: string;
  tone: "neutral" | "info" | "success" | "warning" | "danger";
  tooltip: string;
}

const META: Record<string, PoolStatusMeta> = {
  draft: {
    label: "Draft",
    tone: "neutral",
    tooltip: "This pool is still being prepared and is not yet visible to savers.",
  },
  upcoming: {
    label: "Upcoming",
    tone: "info",
    tooltip: "This pool is scheduled to open soon and cannot accept deposits yet.",
  },
  active: {
    label: "Active",
    tone: "success",
    tooltip: "This pool is open and accepting deposits right now.",
  },
  paused: {
    label: "Paused",
    tone: "warning",
    tooltip: "This pool is temporarily paused while operations or reviews are in progress.",
  },
  matured: {
    label: "Matured",
    tone: "warning",
    tooltip: "This pool has reached the end of its earning period and is awaiting next steps.",
  },
  settling: {
    label: "Settling",
    tone: "info",
    tooltip: "This pool is finalizing rewards and processing settlement.",
  },
  completed: {
    label: "Completed",
    tone: "neutral",
    tooltip: "This pool finished successfully and is now archived.",
  },
  cancelled: {
    label: "Cancelled",
    tone: "danger",
    tooltip: "This pool was cancelled and will not proceed further.",
  },
  open: {
    label: "Active",
    tone: "success",
    tooltip: "This pool is open and accepting deposits right now.",
  },
  locked: {
    label: "Paused",
    tone: "warning",
    tooltip: "This pool is temporarily paused while operations or reviews are in progress.",
  },
  drawing: {
    label: "Settling",
    tone: "info",
    tooltip: "This pool is finalizing rewards and processing settlement.",
  },
  settled: {
    label: "Completed",
    tone: "neutral",
    tooltip: "This pool finished successfully and is now archived.",
  },
  pending: {
    label: "Upcoming",
    tone: "info",
    tooltip: "This pool is scheduled to open soon and cannot accept deposits yet.",
  },
};

const TONE_CLASSES: Record<PoolStatusMeta["tone"], string> = {
  neutral: "border-vault-border bg-vault-surface text-vault-muted",
  info: "border-sky-500/20 bg-sky-500/10 text-sky-300",
  success: "border-emerald-500/20 bg-emerald-500/10 text-emerald-300",
  warning: "border-amber-500/20 bg-amber-500/10 text-amber-300",
  danger: "border-rose-500/20 bg-rose-500/10 text-rose-300",
};

const STATUS_ALIASES: Record<string, string> = {
  active: "active",
  open: "open",
  upcoming: "upcoming",
  draft: "draft",
  paused: "paused",
  locked: "locked",
  matured: "matured",
  settling: "settling",
  drawing: "drawing",
  completed: "completed",
  settled: "settled",
  cancelled: "cancelled",
  canceled: "cancelled",
  pending: "pending",
};

export function normalizePoolStatus(status?: string | null): string {
  if (!status) return "draft";
  const normalized = status.trim().toLowerCase();
  return STATUS_ALIASES[normalized] ?? normalized;
}

export function getPoolStatusMeta(status?: string | null): PoolStatusMeta {
  const normalized = normalizePoolStatus(status);
  return META[normalized] ?? META.draft;
}

export function getPoolStatusClassName(status?: string | null): string {
  return TONE_CLASSES[getPoolStatusMeta(status).tone];
}

// ─── Round status ─────────────────────────────────────────────────────────────
// A round is the active lifecycle window of a vault (open → pending → closed).
// Round status is a strict subset of pool status — `active`, `pending`, and
// `completed` all exist in POOL_STATUS above. This used to live in a separate
// `lib/vault-status.js` module that duplicated the status-derivation concern;
// it is consolidated here so there is a single canonical status module.

export const ROUND_STATUS = {
  ACTIVE: "active",
  PENDING: "pending",
  COMPLETED: "completed",
} as const;

export type RoundStatus = (typeof ROUND_STATUS)[keyof typeof ROUND_STATUS];

export interface RoundStatusMeta {
  label: string;
  tone: "neutral" | "info" | "success" | "warning" | "danger";
}

const ROUND_STATUS_META: Record<RoundStatus, RoundStatusMeta> = {
  [ROUND_STATUS.ACTIVE]: { label: "Active Round", tone: "success" },
  [ROUND_STATUS.PENDING]: { label: "Pending Round", tone: "warning" },
  [ROUND_STATUS.COMPLETED]: { label: "Completed Round", tone: "neutral" },
};

/**
 * Returns the consistent label/tone for a round status, used by both
 * vault cards and the vault detail page so status text never drifts.
 * Unknown/malformed statuses fall back to `pending` (same behavior as the
 * original `lib/vault-status.js`).
 */
export function getRoundStatusMeta(status?: string | null): RoundStatusMeta {
  const normalized = normalizePoolStatus(status);
  return (
    ROUND_STATUS_META[normalized as RoundStatus] ??
    ROUND_STATUS_META[ROUND_STATUS.PENDING]
  );
}

// ─── Archive entry freshness (#622) ────────────────────────────────────────────
// Minimal baseline slice: flag when an archived round's on-chain-derived data
// is old enough that it should not be trusted without reconciling against
// current chain state. This does NOT reconcile against the chain itself, run
// repair tooling, or replace the indexer - it is a pure, presentation-layer
// staleness check over whatever verification timestamp an archive entry
// carries. Full drift reconciliation is out of scope here; see
// docs/RECONCILIATION.md for that larger system.

/**
 * An archive entry is considered stale once its last verification is older
 * than this, relative to "now". 24h mirrors the indexer's own "Critical"
 * hard-lag framing in docs/INDEXER_RUNBOOK.md, applied here to archive
 * metadata rather than live sync lag.
 */
export const ARCHIVE_STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/**
 * Pure staleness check for one archive entry's verification timestamp.
 *
 * Returns `true` when:
 *   - `verifiedAt` is missing/unparseable (never verified, or malformed
 *     metadata - treated as stale rather than silently trusted), or
 *   - the age of `verifiedAt` relative to `now` exceeds `thresholdMs`.
 *
 * A `verifiedAt` that is in the future (clock skew, bad data) is treated as
 * stale as well, rather than "very fresh" - it should never be trusted less
 * cautiously than an ordinary stale entry.
 */
export function isArchiveEntryStale(
  verifiedAt: string | null | undefined,
  now: Date | number = Date.now(),
  thresholdMs: number = ARCHIVE_STALE_THRESHOLD_MS,
): boolean {
  if (!verifiedAt) return true;

  const verifiedAtMs = new Date(verifiedAt).getTime();
  if (Number.isNaN(verifiedAtMs)) return true;

  const nowMs = typeof now === "number" ? now : now.getTime();
  const ageMs = nowMs - verifiedAtMs;

  return ageMs < 0 || ageMs > thresholdMs;
}
