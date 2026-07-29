"use client";

import { getPoolStatusClassName, getPoolStatusMeta } from "@/lib/pool-status";

export default function PoolStatusBadge({ status, className = "" }) {
  const meta = getPoolStatusMeta(status);
  const toneClass = getPoolStatusClassName(status);

  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${toneClass} ${className}`}
      title={meta.tooltip}
      aria-label={`${meta.label}. ${meta.tooltip}`}
    >
      {meta.label}
    </span>
  );
}

