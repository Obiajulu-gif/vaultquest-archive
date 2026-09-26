"use client";

import PoolStatusBadge from "@/components/app/PoolStatusBadge";

export default function RoundStatusBadge({ status, className = "" }) {
  return <PoolStatusBadge status={status} className={className} />;
}
