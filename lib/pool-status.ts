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
