import type { FC } from "react";
import { getPoolStatusClassName, getPoolStatusMeta } from "../../../../../lib/pool-status";

export interface PoolStatusBadgeProps {
  status?: string | null;
  className?: string;
}

export const PoolStatusBadge: FC<PoolStatusBadgeProps> = ({ status, className = "" }) => {
  const meta = getPoolStatusMeta(status);

  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${getPoolStatusClassName(status)} ${className}`}
      title={meta.tooltip}
      aria-label={`${meta.label}. ${meta.tooltip}`}
    >
      {meta.label}
    </span>
  );
};

export default PoolStatusBadge;

